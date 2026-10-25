import { ConnectionsApi as Api } from "@openbot-build/api"
import { App, Client, Discovery, Document, Ui } from "@openbot-build/protocol"
import {
	Array as Arr,
	Context,
	Effect,
	HashSet,
	Layer,
	Schema,
	type Scope,
} from "effect"
import { AppHost } from "./AppHost.ts"
import { Governance } from "./Governance.ts"
import type { PgClient } from "@effect/sql-pg"
import { Secrets } from "../secrets/Secrets.ts"
import * as StoredConnections from "./StoredConnections.ts"
import type {
	Error as StorageError,
	StoredConnection,
} from "./StoredConnections.ts"
import * as Db from "../database/Database.ts"

export class Unavailable extends Schema.TaggedError<Unavailable>()(
	"AppCapabilitiesUnavailable",
	{ reason: Schema.Literals(["Disabled", "NeedsRevalidation"]) },
) {}
export type Error =
	| Client.Error
	| StorageError
	| Api.AppRestricted
	| Discovery.Error
	| Unavailable
export interface Opened {
	readonly stored: StoredConnection
	readonly client: Client.Client
	readonly tools: Readonly<
		Effect.Success<ReturnType<Client.Client["listTools"]>>["tools"]
	>
	readonly resources: Readonly<
		Effect.Success<ReturnType<Client.Client["listResources"]>>["resources"]
	>
	readonly resourceTemplates: Readonly<
		Effect.Success<
			ReturnType<Client.Client["listResourceTemplates"]>
		>["resourceTemplates"]
	>
	readonly prompts: Readonly<
		Effect.Success<ReturnType<Client.Client["listPrompts"]>>["prompts"]
	>
}

export class Capabilities extends Context.Service<
	Capabilities,
	{
		readonly open: (input: {
			readonly owner: string
			readonly connectionId: string
			readonly policy: typeof Client.InvocationPolicy.Service
		}) => Effect.Effect<Opened, Error, Scope.Scope>
	}
>()("@openbot-build/openbot/apps/Capabilities") {}

export const pages = <A>(
	read: (cursor?: string) => Effect.Effect<
		{
			readonly values: ReadonlyArray<A>
			readonly nextCursor?: string | undefined
		},
		Client.Error
	>,
) => {
	const from = (
		cursor: string | undefined,
		seen: HashSet.HashSet<string>,
	): Effect.Effect<ReadonlyArray<A>, Client.Error> =>
		read(cursor).pipe(
			Effect.flatMap((page) => {
				const next = page.nextCursor
				if (next === undefined) return Effect.succeed(page.values)
				if (HashSet.has(seen, next))
					return Effect.fail(
						Client.ClientError.make({
							reason: "Protocol",
							issue: "The App repeated a capability cursor.",
						}),
					)
				return from(next, HashSet.add(seen, next)).pipe(
					Effect.map((rest) => Arr.appendAll(page.values, rest)),
				)
			}),
		)
	return from(undefined, HashSet.empty())
}
export const make: Effect.Effect<
	typeof Capabilities.Service,
	never,
	| AppHost
	| PgClient.PgClient
	| Secrets
	| Governance
	| Discovery.Discovery
	| App.ConnectionScopes
> = Effect.gen(function* () {
	const factory = yield* AppHost
	const db = yield* Db.make
	const secrets = yield* Secrets
	const governance = yield* Governance
	const discovery = yield* Discovery.Discovery
	const scopes = yield* App.ConnectionScopes
	const sameRemote = Schema.toEquivalence(Schema.UndefinedOr(Document.Remote))
	return Capabilities.of({
		open: Effect.fn("Apps.openCapabilities")(function* (input) {
			const stored = yield* StoredConnections.get(
				db,
				secrets,
				input.owner,
				input.connectionId,
			)
			yield* governance.check(stored.connection.cardUrl)
			if (stored.connection.state !== "Enabled")
				return yield* Unavailable.make({
					reason:
						stored.connection.state === "NeedsRevalidation"
							? "NeedsRevalidation"
							: "Disabled",
				})
			const previous = yield* StoredConnections.getApp(
				db,
				input.owner,
				stored.connection.cardUrl,
			)
			if (!previous.sources.some((source) => source.role === "manual")) {
				const declared = yield* discovery.refreshCard(stored.connection.cardUrl)
				if (
					!sameRemote(
						previous.card.remotes?.[stored.connection.remoteIndex],
						declared.card.remotes?.[stored.connection.remoteIndex],
					)
				) {
					yield* StoredConnections.update(
						db,
						secrets,
						input.owner,
						input.connectionId,
						(row) => ({
							...row,
							connection: { ...row.connection, state: "NeedsRevalidation" },
							verification: { _tag: "NeedsRevalidation" },
						}),
						stored.revision,
					)
					yield* scopes.close(input)
					yield* StoredConnections.updateApp(db, input.owner, {
						cardUrl: declared.cardUrl,
						card: declared.card,
						sources: declared.sources,
					})
					return yield* Unavailable.make({ reason: "NeedsRevalidation" })
				}
				yield* StoredConnections.updateApp(db, input.owner, {
					cardUrl: declared.cardUrl,
					card: declared.card,
					sources: declared.sources,
				})
			}
			const client = yield* factory.bind(input.owner, input.policy).open({
				key: input,
				clientInfo: { name: "OpenBot", version: "1.0.0" },
				capabilities: { ...Ui.clientCapabilities, elicitation: { form: {} } },
			})
			const advertised = client.discovery.capabilities
			return {
				stored,
				client,
				tools:
					advertised.tools === undefined
						? []
						: yield* pages((cursor) =>
								client
									.listTools({
										...(cursor === undefined ? {} : { cursor }),
										source: "host",
										singlePage: true,
									})
									.pipe(
										Effect.map((page) => ({
											values: page.tools,
											nextCursor: page.nextCursor,
										})),
									),
							),
				resources:
					advertised.resources === undefined
						? []
						: yield* pages((cursor) =>
								client.listResources(cursor, "host", { singlePage: true }).pipe(
									Effect.map((page) => ({
										values: page.resources,
										nextCursor: page.nextCursor,
									})),
								),
							),
				resourceTemplates:
					advertised.resources === undefined
						? []
						: yield* pages((cursor) =>
								client
									.listResourceTemplates(cursor, "host", { singlePage: true })
									.pipe(
										Effect.map((page) => ({
											values: page.resourceTemplates,
											nextCursor: page.nextCursor,
										})),
									),
							),
				prompts:
					advertised.prompts === undefined
						? []
						: yield* pages((cursor) =>
								client.listPrompts(cursor, "host", { singlePage: true }).pipe(
									Effect.map((page) => ({
										values: page.prompts,
										nextCursor: page.nextCursor,
									})),
								),
							),
			}
		}),
	})
})
export const layer = Layer.effect(Capabilities, make)
