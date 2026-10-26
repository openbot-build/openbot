import { Settings as SettingsApi } from "@openbot-build/api"
import { AppIndexApi as Api } from "@openbot-build/api"
import { type Index as ProtocolIndex, Network } from "@openbot-build/protocol"
import {
	Array as Arr,
	Context,
	Effect,
	Equivalence,
	HashMap,
	HashSet,
	Layer,
	Match,
	Option,
	Order,
	pipe,
	Schema,
	String as Str,
} from "effect"
import { eq } from "drizzle-orm"
import type { PgClient } from "@effect/sql-pg"
import { appIndexEntries } from "../database/Schema.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import * as IndexStore from "./IndexStore.ts"
import { Governance } from "./Governance.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../app/Failures.ts"
import * as Platform from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"

export type Error =
	| Api.IndexInputInvalid
	| Api.IndexNotFound
	| Api.IndexUnavailable
	| Api.IndexRestricted
export interface SourceProvider {
	readonly source: Api.Source
	readonly entries: Effect.Effect<
		ReadonlyArray<ProtocolIndex.Entry>,
		Api.IndexUnavailable
	>
	readonly checks?: Effect.Effect<
		HashMap.HashMap<string, Api.Check>,
		Api.IndexUnavailable
	>
}
export interface Options {
	readonly providers?: ReadonlyArray<SourceProvider>
	readonly simulated?: boolean
}

export class PublicIndex extends Context.Service<
	PublicIndex,
	{
		/** The sources, with the address of the OpenBot Index at the current public origin. */
		readonly sources: Effect.Effect<
			ReadonlyArray<Api.Source>,
			SettingsApi.SettingsUnavailable
		>
		readonly search: (input: Api.Query) => Effect.Effect<Api.Page, Error>
		readonly get: (
			cardUrl: string,
			source?: string,
		) => Effect.Effect<Api.App, Error>
	}
>()("@openbot-build/openbot/apps/PublicIndex") {}

const Cursor = Schema.fromJsonString(
	Schema.Struct({
		query: Schema.String,
		sources: Schema.Array(Schema.String),
		unavailable: Schema.Array(Schema.String),
		name: Schema.String,
		cardUrl: Schema.String,
	}),
)
/** The order of Apps on a page and in a cursor: by name, then by card URL. */
const byKey = Order.Struct({ name: Order.String, cardUrl: Order.String })
const keyOf = (app: Api.App) => ({
	name: app.entry.card.name,
	cardUrl: app.entry.cardUrl,
})
const byApp = Order.mapInput(byKey, keyOf)
const sameSources = Arr.makeEquivalence(Equivalence.String)

const matches = (
	entry: ProtocolIndex.Entry,
	query: string,
): Api.App["matches"] => {
	if (query === "") return []
	return pipe(
		[
			{
				field: "name" as const,
				value: `${entry.card.name} ${entry.card.title ?? ""}`,
			},
			{ field: "description" as const, value: entry.card.description },
			{
				field: "publisher" as const,
				value: pipe(
					entry.evidence,
					Arr.map((evidence) => new URL(evidence.publisherUrl).hostname),
					Arr.join(" "),
				),
			},
		],
		Arr.filter((item) =>
			pipe(item.value, Str.toLocaleLowerCase("en-US"), Str.includes(query)),
		),
		Arr.map((item) => item.field),
	)
}

export const make = (
	options: Options,
): Effect.Effect<
	typeof PublicIndex.Service,
	never,
	PgClient.PgClient | Governance | Settings
> =>
	Effect.gen(function* () {
		const db = yield* Db.make
		const namespace = yield* IndexNamespace
		const governance = yield* Governance
		const settings = yield* Settings
		const localId = "openbot"
		/** The OpenBot Index of this platform. Its address follows the public origin. */
		const localSource = (publicOrigin: string): Api.Source => ({
			id: localId,
			name:
				options.simulated === true
					? "OpenBot Development Index"
					: "OpenBot Index",
			url: `${publicOrigin}/v1/app-index/apps`,
			simulated: options.simulated === true,
		})
		const providersAt = (
			publicOrigin: string,
		): ReadonlyArray<SourceProvider> => [
			{
				source: localSource(publicOrigin),
				checks: IndexStore.checks(db, namespace).pipe(
					Failures.replace("Public Index checks could not be read", () =>
						Api.IndexUnavailable.make({
							issues: [
								{
									source: localId,
									message: "The public Index status could not be read.",
								},
							],
						}),
					),
				),
				entries: db
					.select()
					.from(appIndexEntries)
					.where(eq(appIndexEntries.namespace, namespace))
					.pipe(
						Effect.flatMap((rows) =>
							Effect.forEach(rows, (row) => IndexStore.decode(row.body)),
						),
						Failures.replace("Public Index entries could not be read", () =>
							Api.IndexUnavailable.make({
								issues: [
									{
										source: localId,
										message: "The public Index could not be read.",
									},
								],
							}),
						),
					),
			},
			...(options.providers ?? []),
		]
		const collect = Effect.fn("PublicIndex.collect")(function* (
			selected?: string,
		) {
			const publicOrigin = yield* Platform.publicOriginOr(settings, () =>
				Api.IndexUnavailable.make({
					issues: [
						{
							source: localId,
							message: "The address of the public Index could not be read.",
						},
					],
				}),
			)
			const chosen = Arr.filter(
				providersAt(publicOrigin),
				(provider) => selected === undefined || provider.source.id === selected,
			)
			if (chosen.length === 0)
				return yield* Api.IndexNotFound.make({
					message: "This Index source is unavailable.",
				})
			const outcomes = yield* Effect.forEach(
				chosen,
				(provider) =>
					Effect.all({
						entries: provider.entries,
						checks:
							provider.checks ??
							Effect.succeed(HashMap.empty<string, Api.Check>()),
					}).pipe(
						Effect.map(({ entries, checks }) => ({
							source: provider.source,
							entries: Option.some(entries),
							checks,
							issues: [],
						})),
						Effect.catchTag("IndexUnavailable", (error) =>
							Effect.succeed({
								source: provider.source,
								entries: Option.none<ReadonlyArray<ProtocolIndex.Entry>>(),
								checks: HashMap.empty<string, Api.Check>(),
								issues: error.issues,
							}),
						),
					),
				{ concurrency: 4 },
			)
			const issues = Arr.flatMap(outcomes, (outcome) => outcome.issues)
			if (Arr.every(outcomes, (outcome) => Option.isNone(outcome.entries)))
				return yield* Api.IndexUnavailable.make({ issues })
			const listed = Arr.flatMap(outcomes, (outcome) =>
				Arr.map(
					Option.getOrElse(outcome.entries, () => []),
					(raw) => {
						const entry = { ...raw, cardUrl: new URL(raw.cardUrl).href }
						const indexed = {
							_tag: "Indexed",
							attemptedAt: entry.checkedAt,
						} as const
						const check: Api.Check = Option.match(
							HashMap.get(outcome.checks, entry.cardUrl),
							{
								onNone: () => indexed,
								onSome: (check) =>
									Match.value(check).pipe(
										Match.tag("Pending", (check) => check),
										Match.orElse((check) =>
											check.attemptedAt < entry.checkedAt ? indexed : check,
										),
									),
							},
						)
						return { source: outcome.source, entry, check }
					},
				),
			)
			const apps = Arr.reduce(
				listed,
				HashMap.empty<string, Api.App>(),
				(apps, { source, entry, check }) =>
					check._tag === "Excluded" || check._tag === "Withdrawn"
						? apps
						: HashMap.set(
								apps,
								entry.cardUrl,
								Option.match(HashMap.get(apps, entry.cardUrl), {
									onNone: (): Api.App => ({
										entry,
										sources: [source],
										matches: [],
										check,
										...Option.match(governance.find(entry.cardUrl), {
											onNone: () => ({}),
											onSome: (restriction) => ({ restriction }),
										}),
									}),
									onSome: (app): Api.App => ({
										...app,
										sources: Arr.dedupeWith(
											[...app.sources, source],
											(a, b) => a.id === b.id,
										),
									}),
								}),
							),
			)
			return {
				apps: Arr.sort(Arr.fromIterable(HashMap.values(apps)), byApp),
				issues,
				sources: Arr.map(chosen, (provider) => provider.source.id),
				unavailable: pipe(
					outcomes,
					Arr.filter((outcome) => Option.isNone(outcome.entries)),
					Arr.map((outcome) => outcome.source.id),
				),
			}
		})
		return PublicIndex.of({
			sources: Effect.map(
				Platform.publicOriginOr(settings, () =>
					SettingsApi.SettingsUnavailable.make({}),
				),
				(publicOrigin) =>
					Arr.map(providersAt(publicOrigin), (provider) => provider.source),
			),
			search: Effect.fn("PublicIndex.search")(function* (input) {
				const query = pipe(
					input.query ?? "",
					Str.trim,
					Str.toLocaleLowerCase("en-US"),
				)
				const collected = yield* collect(input.source)
				const cursor =
					input.cursor === undefined
						? undefined
						: yield* Schema.decodeEffect(Cursor)(input.cursor).pipe(
								Effect.catchTag("SchemaError", () =>
									Effect.fail(
										Api.IndexInputInvalid.make({
											message: "Invalid page cursor.",
										}),
									),
								),
							)
				if (
					cursor !== undefined &&
					(cursor.query !== query ||
						!sameSources(cursor.sources, collected.sources) ||
						!sameSources(cursor.unavailable, collected.unavailable))
				)
					return yield* Api.IndexInputInvalid.make({
						message:
							"The search or its sources changed. Return to the first page to refresh results.",
					})
				const filtered = pipe(
					collected.apps,
					Arr.map((app) => ({ ...app, matches: matches(app.entry, query) })),
					Arr.filter(
						(app) =>
							(query === "" || app.matches.length > 0) &&
							(cursor === undefined ||
								Order.isGreaterThan(byKey)(keyOf(app), cursor)),
					),
				)
				const limit = input.limit ?? 20
				const page = Arr.take(filtered, limit)
				const nextCursor = yield* pipe(
					Arr.last(page),
					Option.filter(() => filtered.length > limit),
					Option.map((last) =>
						Schema.encodeEffect(Cursor)({
							query,
							sources: collected.sources,
							unavailable: collected.unavailable,
							name: last.entry.card.name,
							cardUrl: last.entry.cardUrl,
						}),
					),
					Effect.transposeOption,
					// The code builds this value, so a failed encode is a broken rule of the code.
					Effect.orDie,
				)
				return {
					apps: page,
					issues: collected.issues,
					nextCursor: Option.getOrNull(nextCursor),
				}
			}),
			get: Effect.fn("PublicIndex.get")(function* (cardUrl, source) {
				yield* governance
					.check(cardUrl)
					.pipe(
						Effect.mapError(({ restriction }) =>
							Api.IndexRestricted.make({ restriction }),
						),
					)
				const collected = yield* collect(source)
				return yield* Arr.findFirst(
					collected.apps,
					(app) => app.entry.cardUrl === new URL(cardUrl).href,
				).pipe(
					Effect.fromOption(() =>
						Api.IndexNotFound.make({
							message: "This App is not in the selected public Index.",
						}),
					),
				)
			}),
		})
	})

export const layer = (options: Options) =>
	Layer.effect(PublicIndex, make(options))

/** Read another OpenBot Index that the configuration names. Never forward user credentials. */
export const remoteProvider = (
	source: Api.Source,
): Effect.Effect<SourceProvider, never, Network.PublicNetwork> =>
	Effect.gen(function* () {
		const network = yield* Network.PublicNetwork
		/** A network failure, or a page that does not decode. */
		const unreadable = Failures.replace(
			"An Index source could not be read",
			() =>
				Api.IndexUnavailable.make({
					issues: [
						{
							source: source.id,
							message: "This Index source could not be read.",
						},
					],
				}),
		)
		const read = (
			cursor: string | undefined,
			seen: HashSet.HashSet<string>,
		): Effect.Effect<
			ReadonlyArray<ProtocolIndex.Entry>,
			Api.IndexUnavailable
		> =>
			Effect.gen(function* () {
				const url = new URL(source.url)
				url.searchParams.set("limit", "50")
				if (cursor !== undefined) url.searchParams.set("cursor", cursor)
				const response = yield* network
					.readDocument({ url: url.href })
					.pipe(unreadable)
				if (response.status !== 200) {
					yield* Effect.logWarning(
						"An Index source did not return a public Index page",
					).pipe(
						Effect.annotateLogs({ source: source.id, status: response.status }),
					)
					return yield* Api.IndexUnavailable.make({
						issues: [
							{
								source: source.id,
								message: "The source did not return a public Index page.",
							},
						],
					})
				}
				const page = yield* Schema.decodeEffect(
					Schema.fromJsonString(Api.Page),
				)(response.text).pipe(unreadable)
				if (page.issues.length > 0) {
					yield* Effect.logWarning(
						"An Index source returned incomplete results",
						page.issues,
					).pipe(Effect.annotateLogs({ source: source.id }))
					return yield* Api.IndexUnavailable.make({
						issues: [
							{
								source: source.id,
								message: "This Index source returned incomplete results.",
							},
						],
					})
				}
				const entries = Arr.map(page.apps, (app) => app.entry)
				if (page.nextCursor === null) return entries
				if (HashSet.has(seen, page.nextCursor))
					return yield* Api.IndexUnavailable.make({
						issues: [
							{
								source: source.id,
								message: "The source repeated a page cursor.",
							},
						],
					})
				return [
					...entries,
					...(yield* read(page.nextCursor, HashSet.add(seen, page.nextCursor))),
				]
			})
		return { source, entries: read(undefined, HashSet.empty()) }
	})
