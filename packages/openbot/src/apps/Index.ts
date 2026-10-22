import { AppIndexApi as Api } from "@openbot-build/api"
import { type Index as ProtocolIndex, Network } from "@openbot-build/protocol"
import {
	Array as Arr,
	Context,
	Effect,
	HashMap,
	HashSet,
	Layer,
	Match,
	Option,
	Order,
	Schema,
} from "effect"
import { eq } from "drizzle-orm"
import type { PgClient } from "@effect/sql-pg"
import { appIndexEntries } from "../database/Schema.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import * as IndexStore from "./IndexStore.ts"
import { Governance } from "./Governance.ts"
import * as Db from "../database/Database.ts"

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
	readonly publicOrigin: string
	readonly providers?: ReadonlyArray<SourceProvider>
	readonly simulated?: boolean
}

export class PublicIndex extends Context.Service<
	PublicIndex,
	{
		readonly sources: ReadonlyArray<Api.Source>
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
const compare = (left: ProtocolIndex.Entry, right: ProtocolIndex.Entry) =>
	Order.String(left.card.name, right.card.name) ||
	Order.String(left.cardUrl, right.cardUrl)

const matches = (
	entry: ProtocolIndex.Entry,
	query: string,
): Api.App["matches"] => {
	if (query === "") return []
	return Arr.filter(
		[
			{
				field: "name" as const,
				value: `${entry.card.name} ${entry.card.title ?? ""}`,
			},
			{ field: "description" as const, value: entry.card.description },
			{
				field: "publisher" as const,
				value: entry.evidence
					.map((evidence) => new URL(evidence.publisherUrl).hostname)
					.join(" "),
			},
		],
		(item) => item.value.toLocaleLowerCase("en-US").includes(query),
	).map((item) => item.field)
}

export const make = (
	options: Options,
): Effect.Effect<
	typeof PublicIndex.Service,
	never,
	PgClient.PgClient | Governance
> =>
	Effect.gen(function* () {
		const db = yield* Db.make
		const namespace = yield* IndexNamespace
		const governance = yield* Governance
		const local: Api.Source = {
			id: "openbot",
			name:
				options.simulated === true
					? "OpenBot Development Index"
					: "OpenBot Index",
			url: `${options.publicOrigin}/v1/app-index/apps`,
			simulated: options.simulated === true,
		}
		const providers: ReadonlyArray<SourceProvider> = [
			{
				source: local,
				checks: IndexStore.checks(db, namespace).pipe(
					Effect.mapError(() =>
						Api.IndexUnavailable.make({
							issues: [
								{
									source: local.id,
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
						Effect.mapError(() =>
							Api.IndexUnavailable.make({
								issues: [
									{
										source: local.id,
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
			const chosen = providers.filter(
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
			const issues = outcomes.flatMap((outcome) => outcome.issues)
			if (outcomes.every((outcome) => Option.isNone(outcome.entries)))
				return yield* Api.IndexUnavailable.make({ issues })
			const listed = outcomes.flatMap((outcome) =>
				Option.getOrElse(outcome.entries, () => []).map((raw) => {
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
				}),
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
				apps: Arr.sort(
					Arr.fromIterable(HashMap.values(apps)),
					(a: Api.App, b: Api.App) => compare(a.entry, b.entry),
				),
				issues,
				sources: chosen.map((provider) => provider.source.id),
				unavailable: outcomes
					.filter((outcome) => Option.isNone(outcome.entries))
					.map((outcome) => outcome.source.id),
			}
		})
		return PublicIndex.of({
			sources: providers.map((provider) => provider.source),
			search: Effect.fn("PublicIndex.search")(function* (input) {
				const query = (input.query ?? "").trim().toLocaleLowerCase("en-US")
				const collected = yield* collect(input.source)
				const cursor =
					input.cursor === undefined
						? undefined
						: yield* Schema.decodeEffect(Cursor)(input.cursor).pipe(
								Effect.mapError(() =>
									Api.IndexInputInvalid.make({
										message: "Invalid page cursor.",
									}),
								),
							)
				if (
					cursor !== undefined &&
					(cursor.query !== query ||
						cursor.sources.length !== collected.sources.length ||
						!cursor.sources.every(
							(source, index) => source === collected.sources[index],
						) ||
						cursor.unavailable.length !== collected.unavailable.length ||
						!cursor.unavailable.every(
							(source, index) => source === collected.unavailable[index],
						))
				)
					return yield* Api.IndexInputInvalid.make({
						message:
							"The search or its sources changed. Return to the first page to refresh results.",
					})
				const filtered = collected.apps
					.map((app) => ({ ...app, matches: matches(app.entry, query) }))
					.filter(
						(app) =>
							(query === "" || app.matches.length > 0) &&
							(cursor === undefined ||
								Order.String(app.entry.card.name, cursor.name) > 0 ||
								(app.entry.card.name === cursor.name &&
									Order.String(app.entry.cardUrl, cursor.cardUrl) > 0)),
					)
				const limit = Number(input.limit ?? "20")
				const page = filtered.slice(0, limit)
				return {
					apps: page,
					issues: collected.issues,
					nextCursor: Arr.last(page).pipe(
						Option.filter(() => filtered.length > limit),
						Option.map((last) =>
							JSON.stringify({
								query,
								sources: collected.sources,
								unavailable: collected.unavailable,
								name: last.entry.card.name,
								cardUrl: last.entry.cardUrl,
							}),
						),
						Option.getOrNull,
					),
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
				const app = collected.apps.find(
					(app) => app.entry.cardUrl === new URL(cardUrl).href,
				)
				if (app === undefined)
					return yield* Api.IndexNotFound.make({
						message: "This App is not in the selected public Index.",
					})
				return app
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
				const response = yield* network.readDocument({ url: url.href })
				if (response.status !== 200)
					return yield* Api.IndexUnavailable.make({
						issues: [
							{
								source: source.id,
								message: "The source did not return a public Index page.",
							},
						],
					})
				const page = yield* Schema.decodeEffect(
					Schema.fromJsonString(Api.Page),
				)(response.text)
				if (page.issues.length > 0)
					return yield* Api.IndexUnavailable.make({
						issues: [
							{
								source: source.id,
								message: "This Index source returned incomplete results.",
							},
						],
					})
				const entries = page.apps.map((app) => app.entry)
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
			}).pipe(
				Effect.mapError(() =>
					Api.IndexUnavailable.make({
						issues: [
							{
								source: source.id,
								message: "This Index source could not be read.",
							},
						],
					}),
				),
			)
		return { source, entries: read(undefined, HashSet.empty()) }
	})
