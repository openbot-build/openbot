import {
	CatalogDiscovery,
	App,
	Client,
	Discovery,
	Store,
	Ui,
} from "@openbot-build/protocol"
import { AppIndex } from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Schema,
	type Scope,
} from "effect"
import type { PgClient } from "@effect/sql-pg"
import { AppHost } from "./AppHost.ts"
import { Governance } from "./Governance.ts"
import { Secrets } from "../secrets/Secrets.ts"
import * as StoredConnections from "./StoredConnections.ts"
import type {
	Error as StorageError,
	StoredConnection,
} from "./StoredConnections.ts"
import * as Db from "../database/Database.ts"

export class Unavailable extends Schema.TaggedError<
	Unavailable,
	{ readonly brand: unique symbol }
>()("AppCapabilitiesUnavailable", {
	reason: Schema.Literals(["Disabled", "NeedsRevalidation"]),
}) {}
export type Error =
	| Client.Error
	| StorageError
	| AppIndex.AppRestricted
	| Discovery.Error
	| Unavailable
export interface Opened {
	readonly stored: StoredConnection
	readonly client: Client.Client
}

export class ConnectionSessions extends Context.Service<
	ConnectionSessions,
	{
		readonly open: (input: {
			readonly owner: string
			readonly connectionId: string
			readonly policy: typeof Client.InvocationPolicy.Service
		}) => Effect.Effect<Opened, Error, Scope.Scope>
	}
>()("@openbot-build/openbot/apps/ConnectionSessions") {}

export const make: Effect.Effect<
	typeof ConnectionSessions.Service,
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
	const sameRemote = CatalogDiscovery.sameConnection
	return ConnectionSessions.of({
		open: Effect.fn("Apps.openConnection")(function* (input) {
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
			if (!Arr.some(previous.sources, (source) => source.role === "manual")) {
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
					yield* StoredConnections.updateApp(
						db,
						input.owner,
						Store.AppRecord.make({
							cardUrl: declared.cardUrl,
							card: declared.card,
							sources: declared.sources,
						}),
					)
					return yield* Unavailable.make({ reason: "NeedsRevalidation" })
				}
				yield* StoredConnections.updateApp(
					db,
					input.owner,
					Store.AppRecord.make({
						cardUrl: declared.cardUrl,
						card: declared.card,
						sources: declared.sources,
					}),
				)
			}
			const client = yield* factory.bind(input.owner, input.policy).open({
				key: input,
				clientInfo: { name: "OpenBot", version: "1.0.0" },
				capabilities: {
					...Ui.clientCapabilities,
					elicitation: { form: {} },
				},
			})
			return { stored, client }
		}),
	})
})
export const layer = Layer.effect(ConnectionSessions, make)
