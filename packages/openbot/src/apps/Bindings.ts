import { AppCalls, AppViews, ConnectionId } from "@openbot-build/domain"

import { Client } from "@openbot-build/protocol"
import {
	Array as Arr,
	Cause,
	Crypto,
	Effect,
	Match,
	Option,
	Record as Rec,
	Schema,
	String as Str,
	pipe,
	type JsonSchema,
} from "effect"
import { Hex } from "effect/encoding"
import { json } from "./AppResults.ts"
import type { Binding } from "../code/Bindings.ts"
import type { Capabilities, Opened } from "./Capabilities.ts"
import type { ActionPolicy } from "./ActionPolicy.ts"
import * as StoredConnections from "./StoredConnections.ts"
import { organizationOf } from "./StoredConnections.ts"
import type { Secrets } from "../secrets/Secrets.ts"
import * as Db from "../database/Database.ts"
import type * as Report from "../errors/Report.ts"
import * as Failures from "../errors/Failures.ts"

/** The services needed to read descriptions. Calls use the App workflow. */
export interface DiscoveryServices {
	readonly db: Db.Database
	readonly secrets: typeof Secrets.Service
	readonly capabilities: typeof Capabilities.Service
	readonly policy: typeof ActionPolicy.Service
	readonly crypto: Crypto.Crypto
	readonly report: Report.Report
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const hash = (crypto: Crypto.Crypto, value: unknown) =>
	Effect.gen(function* () {
		const text = yield* encodeJson(value)
		const digest = yield* crypto.digest(
			"SHA-256",
			new TextEncoder().encode(text),
		)
		return pipe(Hex.encode(digest), Str.slice(0, 40))
	}).pipe(
		// The value is JSON data and SHA-256 is always there, so a failure here is a defect.
		Effect.orDie,
	)
const visible = (tool: Opened["tools"][number]) => {
	const metadata = Schema.decodeUnknownOption(
		Schema.Struct({ visibility: Schema.Array(Schema.String) }),
	)(tool._meta?.["ui"])
	return Option.match(metadata, {
		onNone: () => true,
		onSome: (value) => value.visibility.includes("model"),
	})
}
export interface Selected {
	readonly name: string
	readonly source: AppViews.ActionSource
}
const bindingsFor = (
	services: DiscoveryServices,
	owner: string,
	opened: Opened,
	occupied: ReadonlyArray<string>,
	selected: Option.Option<Selected>,
) =>
	Effect.gen(function* () {
		const stored = opened.stored
		const app = yield* StoredConnections.getApp(
			services.db,
			owner,
			stored.connection.cardUrl,
		)
		const source = (
			kind: AppCalls.Source["kind"],
			name: string,
			definition: Schema.Json,
		): AppCalls.Source => ({
			connectionId: ConnectionId.make(stored.connection.connectionId),
			connectionName: stored.name,
			cardUrl: stored.connection.cardUrl,
			appName: app.card.title ?? app.card.name,
			remoteIndex: stored.connection.remoteIndex,
			revision: stored.revision,
			kind,
			name,
			definition,
		})
		let entries: ReadonlyArray<Binding> = []
		let used = occupied
		/** The first name `openbot_<hash>` that no other tool uses yet. */
		const freeName = (
			origin: AppCalls.Source,
			schema: JsonSchema.JsonSchema,
			salt: number,
		): Effect.Effect<string> =>
			hash(services.crypto, [owner, origin, schema, salt]).pipe(
				Effect.map((value) => "openbot_" + value),
				Effect.filterOrElse(
					(name) => !used.includes(name),
					() => freeName(origin, schema, salt + 1),
				),
			)
		const add = (
			origin: AppCalls.Source,
			schema: JsonSchema.JsonSchema,
			description: string,
			needsDecision: boolean,
			readOnly: boolean,
		) =>
			Effect.gen(function* () {
				const name = yield* Option.match(selected, {
					onSome: (value) => Effect.succeed(value.name),
					onNone: () => freeName(origin, schema, 0),
				})
				if (used.includes(name)) return
				used = Arr.append(used, name)
				entries = Arr.append(entries, {
					name,
					source: origin,
					schema,
					description,
					needsDecision,
					readOnly,
				})
			})
		for (const tool of Arr.filter(opened.tools, (tool) =>
			Option.match(selected, {
				onNone: () => visible(tool),
				onSome: ({ source }) =>
					source.kind === "tool" && source.target === tool.name,
			}),
		)) {
			const origin = source("tool", tool.name, yield* json(tool))
			yield* add(
				origin,
				tool.inputSchema,
				tool.description ?? "Call this App capability.",
				true,
				yield* services.policy.isRead({
					organizationId: organizationOf(owner),
					source: origin,
				}),
			)
		}
		for (const resource of Arr.filter(opened.resources, (resource) =>
			Option.match(selected, {
				onNone: () => true,
				onSome: ({ source }) =>
					source.kind === "resource" && source.target === resource.uri,
			}),
		))
			yield* add(
				source("resource", resource.uri, yield* json(resource)),
				{ type: "object", properties: {}, additionalProperties: false },
				resource.description ?? "Read this App resource.",
				false,
				true,
			)
		for (const template of Option.isNone(selected)
			? opened.resourceTemplates
			: [])
			yield* add(
				source("template", template.uriTemplate, yield* json(template)),
				{ type: "object", additionalProperties: { type: "string" } },
				template.description ?? "Read this App resource template.",
				false,
				true,
			)
		for (const prompt of Option.isNone(selected) ? opened.prompts : []) {
			const args = prompt.arguments ?? []
			yield* add(
				source("prompt", prompt.name, yield* json(prompt)),
				{
					type: "object",
					properties: Rec.fromEntries(
						Arr.map(args, (argument) => [
							argument.name,
							{
								type: "string",
								...(argument.description === undefined
									? {}
									: { description: argument.description }),
							},
						]),
					),
					required: pipe(
						args,
						Arr.filter((argument) => argument.required === true),
						Arr.map((argument) => argument.name),
					),
					additionalProperties: false,
				},
				prompt.description ?? "Read this App prompt as external content.",
				false,
				true,
			)
		}
		return entries
	})

const read = (
	services: DiscoveryServices,
	owner: string,
	occupied: ReadonlyArray<string>,
	selected: Option.Option<Selected>,
) =>
	Effect.gen(function* () {
		const read = yield* StoredConnections.list(
			services.db,
			services.secrets,
			owner,
		).pipe(
			Effect.tapCauseIf(Cause.hasFails, (cause) =>
				services.report("App connections could not be read for a Turn.", cause),
			),
			Effect.result,
		)
		const rows = Match.value(read).pipe(
			Match.tag("Success", ({ success }) => success),
			Match.tag("Failure", () => []),
			Match.exhaustive,
		)
		let entries: ReadonlyArray<Binding> = []
		let issues: ReadonlyArray<string> = Match.value(read).pipe(
			Match.tag("Failure", () => [
				"App connection storage is unavailable. No App connection can be used in this Turn.",
			]),
			Match.orElse(() => []),
		)
		for (const stored of rows) {
			if (stored.connection.state !== "Enabled") continue
			if (
				Option.exists(
					selected,
					({ source }) =>
						stored.connection.connectionId !== source.connectionId ||
						stored.revision !== source.revision,
				)
			)
				continue
			const policy = Client.InvocationPolicy.of({
				check: (invocation) =>
					Effect.gen(function* () {
						const current = yield* StoredConnections.get(
							services.db,
							services.secrets,
							owner,
							stored.connection.connectionId,
						).pipe(
							Effect.catchTags({
								ExperienceNotFound: () =>
									Effect.fail(
										Client.PermissionDenied.make({
											action: invocation.action,
											target: invocation.target,
										}),
									),
								// The policy can only deny, so a storage failure denies the call too.
								ExperienceStorageUnavailable: (error) =>
									Effect.fail(error).pipe(
										Failures.replace(
											"OpenBot could not read an App connection, so it denies the App call.",
											() =>
												Client.PermissionDenied.make({
													action: invocation.action,
													target: invocation.target,
												}),
										),
									),
							}),
						)
						if (
							current.revision !== stored.revision ||
							invocation.connection.owner !== owner ||
							invocation.connection.connectionId !==
								stored.connection.connectionId
						)
							return yield* Client.PermissionDenied.make({
								action: invocation.action,
								target: invocation.target,
							})
						if (!Schema.is(Client.ListAction)(invocation.action))
							return yield* Client.PermissionDenied.make({
								action: invocation.action,
								target: invocation.target,
							})
					}),
			})
			const result = yield* services.capabilities
				.open({
					owner,
					connectionId: ConnectionId.make(stored.connection.connectionId),
					policy,
				})
				.pipe(
					Effect.flatMap((opened) =>
						bindingsFor(
							services,
							owner,
							opened,
							Arr.appendAll(
								occupied,
								Arr.map(entries, (entry) => entry.name),
							),
							selected,
						),
					),
					Effect.tapCauseIf(Cause.hasFails, (cause) =>
						services
							.report(
								"An App connection could not be opened for a Turn.",
								cause,
							)
							.pipe(
								Effect.annotateLogs({
									connectionId: ConnectionId.make(
										stored.connection.connectionId,
									),
								}),
							),
					),
					Effect.result,
				)
			Match.value(result).pipe(
				Match.tag("Success", ({ success }) => {
					entries = Arr.appendAll(entries, success)
				}),
				Match.tag("Failure", ({ failure }) => {
					issues = Arr.append(
						issues,
						`${stored.name}: ${failure._tag}. Review this connection in My Apps.`,
					)
				}),
				Match.exhaustive,
			)
		}
		return { entries, issues }
	})

/** Close discovery clients before returning descriptions to a workflow's tools. */
export const describe = (
	services: DiscoveryServices,
	owner: string,
	occupied: ReadonlyArray<string>,
	selected: Option.Option<Selected>,
) => Effect.scoped(read(services, owner, occupied, selected))
