import { Authorization, Store } from "@openbot-build/protocol"
import type { PgClient } from "@effect/sql-pg"
import {
	Context,
	Crypto,
	Effect,
	Layer,
	Match,
	pipe,
	Schema,
	String as Str,
} from "effect"
import { and, eq } from "drizzle-orm"
import {
	appAuthorizations,
	appConnections,
	appSecrets,
} from "../database/Schema.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import * as StoredConnections from "./StoredConnections.ts"
import { Secrets } from "../secrets/Secrets.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../app/Failures.ts"

export interface OwnedStores {
	readonly apps: typeof Store.AppStore.Service
	readonly credentials: typeof Store.CredentialStore.Service
	readonly flows: typeof Authorization.FlowStore.Service
	readonly clearFlows: (
		connectionId: string,
	) => Effect.Effect<void, Store.StoreError>
}
export class ProtocolStores extends Context.Service<
	ProtocolStores,
	{
		readonly bind: (owner: string) => OwnedStores
	}
>()("@openbot-build/openbot/apps/ProtocolStores") {}

/**
 * Turn a failure of the stored connections into the error of the protocol
 * stores. A missing connection becomes `Missing`, and every other failure
 * becomes `Unavailable` and keeps the old error as its cause. This does not
 * log: the stored connections already log a storage failure, and the step that
 * makes the public error logs the full cause.
 */
export const toStoreError =
	(operation: string) =>
	(error: StoredConnections.Error | Store.StoreError): Store.StoreError =>
		Match.value(error).pipe(
			Match.tag("StoreError", (error) => error),
			Match.tag("ExperienceNotFound", () =>
				Store.StoreError.make({ reason: "Missing", operation }),
			),
			Match.orElse((error) =>
				Store.StoreError.make({
					reason: "Unavailable",
					operation,
					cause: error,
				}),
			),
		)
/**
 * Log a failure that the caller can not act on, such as a database or a
 * sealing failure, and replace it with an Unavailable StoreError.
 */
const unavailable = (message: string) =>
	Failures.replace(message, () =>
		Store.StoreError.make({
			reason: "Unavailable",
			operation: "Owned App storage",
		}),
	)
const credentialCodec = Schema.fromJsonString(
	Schema.toCodecJson(Store.Credential),
)
const flowCodec = Schema.fromJsonString(Schema.toCodecJson(Authorization.Flow))

export const make: Effect.Effect<
	typeof ProtocolStores.Service,
	never,
	PgClient.PgClient | Secrets | Crypto.Crypto
> = Effect.gen(function* () {
	const namespace = yield* IndexNamespace
	const secrets = yield* Secrets
	const db = yield* Db.make
	const crypto = yield* Crypto.Crypto
	return ProtocolStores.of({
		bind: (owner) => {
			const owned = (key: Store.ConnectionKey) =>
				key.owner === owner
					? Effect.void
					: Effect.fail(
							Store.StoreError.make({
								reason: "Missing",
								operation: "Owned App storage",
							}),
						)
			const where = (kind: string, id: string) =>
				and(
					eq(appSecrets.owner, owner),
					eq(appSecrets.kind, kind),
					eq(appSecrets.id, id),
				)
			const binding = (kind: string, id: string) =>
				JSON.stringify([kind, owner, id])
			const remove = (kind: string, connectionId: string) =>
				db
					.delete(appSecrets)
					.where(
						and(
							eq(appSecrets.owner, owner),
							eq(appSecrets.kind, kind),
							eq(appSecrets.connectionId, connectionId),
						),
					)
					.pipe(
						Effect.asVoid,
						unavailable("Could not remove owned App secrets."),
					)
			const apps = Store.AppStore.of({
				save: (input) =>
					owned(input.connection).pipe(
						Effect.andThen(
							StoredConnections.save(db, secrets, namespace, owner, {
								...input,
								name: pipe(
									input.app.card.title ?? input.app.card.name,
									Str.slice(0, 80),
								),
							}),
						),
						Effect.map((stored) => stored.connection),
						Effect.mapError(toStoreError("Owned App storage")),
					),
				get: (key) =>
					owned(key).pipe(
						Effect.andThen(
							StoredConnections.get(db, secrets, owner, key.connectionId),
						),
						Effect.map((stored) => stored.connection),
						Effect.mapError(toStoreError("Owned App storage")),
					),
				getApp: (cardUrl) =>
					StoredConnections.getApp(db, owner, cardUrl).pipe(
						Effect.mapError(toStoreError("Owned App storage")),
					),
				update: ({ key, change }) =>
					owned(key).pipe(
						Effect.andThen(
							StoredConnections.update(
								db,
								secrets,
								owner,
								key.connectionId,
								(stored) => ({
									...stored,
									connection: change(stored.connection),
									verification: null,
								}),
							),
						),
						Effect.map((stored) => stored.connection),
						Effect.mapError(toStoreError("Owned App storage")),
					),
				updateApp: (app) =>
					StoredConnections.updateApp(db, owner, app).pipe(
						Effect.mapError(toStoreError("Owned App storage")),
					),
				delete: (key) =>
					owned(key).pipe(
						Effect.andThen(
							db
								.transaction((tx) =>
									Effect.gen(function* () {
										const rows = yield* tx
											.delete(appConnections)
											.where(
												StoredConnections.connectionWhere(
													owner,
													key.connectionId,
												),
											)
											.returning({ id: appConnections.id })
										if (rows.length === 0)
											return yield* Store.StoreError.make({
												reason: "Missing",
												operation: "Owned App storage",
											})
										yield* tx
											.delete(appSecrets)
											.where(
												and(
													eq(appSecrets.owner, owner),
													eq(appSecrets.connectionId, key.connectionId),
												),
											)
									}),
								)
								.pipe(
									Effect.catchTag(
										["EffectDrizzleQueryError", "SqlError"],
										(error) =>
											Effect.fail(error).pipe(
												unavailable(
													"Could not delete an owned App connection.",
												),
											),
									),
								),
						),
					),
			})
			const credentials = Store.CredentialStore.of({
				put: Effect.fn("AppCredentials.put")(function* (credential) {
					yield* owned(credential.binding)
					const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie)
					const encoded = yield* Schema.encodeEffect(credentialCodec)(
						credential,
					).pipe(unavailable("Could not encode an App credential."))
					const body = yield* secrets
						.seal(encoded, binding("credential", id))
						.pipe(unavailable("Could not seal an App credential."))
					yield* db
						.insert(appSecrets)
						.values({
							owner,
							kind: "credential",
							id,
							connectionId: credential.binding.connectionId,
							body,
						})
						.pipe(unavailable("Could not save an App credential."))
					return id
				}),
				get: Effect.fn("AppCredentials.get")(function* (input) {
					yield* owned(input.binding)
					const row = (yield* db
						.select()
						.from(appSecrets)
						.where(where("credential", input.reference))
						.pipe(unavailable("Could not read an App credential.")))[0]
					if (row === undefined)
						return yield* Store.StoreError.make({
							reason: "Missing",
							operation: "Owned App storage",
						})
					const encoded = yield* secrets
						.open(row.body, binding("credential", input.reference))
						.pipe(unavailable("Could not open an App credential."))
					const credential = yield* Schema.decodeEffect(credentialCodec)(
						encoded,
					).pipe(unavailable("Could not decode an App credential."))
					if (
						credential.binding.owner !== input.binding.owner ||
						credential.binding.connectionId !== input.binding.connectionId ||
						credential.binding.resource !== input.binding.resource ||
						credential.binding.issuer !== input.binding.issuer
					)
						return yield* Store.StoreError.make({
							reason: "Missing",
							operation: "Owned App storage",
						})
					return credential
				}),
				deleteConnection: (key) =>
					owned(key).pipe(
						Effect.andThen(remove("credential", key.connectionId)),
					),
			})
			const flows = Authorization.FlowStore.of({
				save: Effect.fn("AppFlows.save")(function* (flow) {
					yield* owned(flow.binding)
					const encoded = yield* Schema.encodeEffect(flowCodec)(flow).pipe(
						unavailable("Could not encode an App authorization flow."),
					)
					const body = yield* secrets
						.seal(encoded, binding("flow", flow.flowId))
						.pipe(unavailable("Could not seal an App authorization flow."))
					yield* db
						.insert(appSecrets)
						.values({
							owner,
							kind: "flow",
							id: flow.flowId,
							connectionId: flow.binding.connectionId,
							body,
						})
						.pipe(unavailable("Could not save an App authorization flow."))
				}),
				get: Effect.fn("AppFlows.get")(function* ({ key, flowId }) {
					yield* owned(key)
					const row = (yield* db
						.select()
						.from(appSecrets)
						.where(
							and(
								where("flow", flowId),
								eq(appSecrets.connectionId, key.connectionId),
							),
						)
						.pipe(unavailable("Could not read an App authorization flow.")))[0]
					if (row === undefined)
						return yield* Store.StoreError.make({
							reason: "Missing",
							operation: "Owned App storage",
						})
					if (row.consumed)
						return yield* Authorization.AuthorizationError.make({
							reason: "AlreadyConsumed",
							issue: "This authorization flow was already used.",
						})
					const encoded = yield* secrets
						.open(row.body, binding("flow", flowId))
						.pipe(unavailable("Could not open an App authorization flow."))
					return yield* Schema.decodeEffect(flowCodec)(encoded).pipe(
						unavailable("Could not decode an App authorization flow."),
					)
				}),
				consume: Effect.fn("AppFlows.consume")(function* ({ key, flowId }) {
					yield* owned(key)
					const rows = yield* db
						.update(appSecrets)
						.set({ consumed: true })
						.where(
							and(
								where("flow", flowId),
								eq(appSecrets.connectionId, key.connectionId),
								eq(appSecrets.consumed, false),
							),
						)
						.returning({ id: appSecrets.id })
						.pipe(
							unavailable("Could not mark an App authorization flow as used."),
						)
					if (rows.length === 0)
						return yield* Authorization.AuthorizationError.make({
							reason: "AlreadyConsumed",
							issue:
								"This authorization flow is unavailable or was already used.",
						})
				}),
			})
			return {
				apps,
				credentials,
				flows,
				clearFlows: (id) =>
					db
						.transaction((tx) =>
							Effect.gen(function* () {
								yield* tx
									.delete(appAuthorizations)
									.where(
										and(
											eq(appAuthorizations.owner, owner),
											eq(appAuthorizations.connectionId, id),
										),
									)
								yield* tx
									.delete(appSecrets)
									.where(
										and(
											eq(appSecrets.owner, owner),
											eq(appSecrets.kind, "flow"),
											eq(appSecrets.connectionId, id),
										),
									)
							}),
						)
						.pipe(
							Effect.asVoid,
							unavailable("Could not clear the App authorization flows."),
						),
			}
		},
	})
})
export const layer = Layer.effect(ProtocolStores, make)
