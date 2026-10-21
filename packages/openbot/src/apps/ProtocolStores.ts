import { Authorization, Store } from "@openbot-build/protocol"
import type { PgClient } from "@effect/sql-pg"
import { Context, Effect, Layer, Match, Schema } from "effect"
import { and, eq } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { appAuthorizations, appSecrets } from "../database/Schema.ts"
import { Repository, type Error as RepositoryError } from "./Repository.ts"
import { Secrets } from "./Secrets.ts"

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

const missing = () =>
	new Store.StoreError({ reason: "Missing", operation: "Owned App storage" })
const unavailable = () =>
	new Store.StoreError({
		reason: "Unavailable",
		operation: "Owned App storage",
	})
const translate = (error: RepositoryError | Store.StoreError) =>
	Match.value(error).pipe(
		Match.tag("ExperienceNotFound", missing),
		Match.tag("StoreError", (error) => error),
		Match.orElse(unavailable),
	)
const credentialCodec = Schema.fromJsonString(
	Schema.toCodecJson(Store.Credential),
)
const flowCodec = Schema.fromJsonString(Schema.toCodecJson(Authorization.Flow))

export const make: Effect.Effect<
	typeof ProtocolStores.Service,
	never,
	Repository | PgClient.PgClient | Secrets
> = Effect.gen(function* () {
	const repository = yield* Repository
	const secrets = yield* Secrets
	const db = yield* makeWithDefaults()
	return ProtocolStores.of({
		bind: (owner) => {
			const owned = (key: Store.ConnectionKey) =>
				key.owner === owner ? Effect.void : Effect.fail(missing())
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
					.pipe(Effect.asVoid, Effect.mapError(unavailable))
			const apps = Store.AppStore.of({
				save: (input) =>
					owned(input.connection).pipe(
						Effect.andThen(
							repository.save(owner, {
								...input,
								name: (input.app.card.title ?? input.app.card.name).slice(
									0,
									80,
								),
							}),
						),
						Effect.map((stored) => stored.connection),
						Effect.mapError(translate),
					),
				get: (key) =>
					owned(key).pipe(
						Effect.andThen(repository.get(owner, key.connectionId)),
						Effect.map((stored) => stored.connection),
						Effect.mapError(translate),
					),
				getApp: (cardUrl) =>
					repository.getApp(owner, cardUrl).pipe(Effect.mapError(translate)),
				update: ({ key, change }) =>
					owned(key).pipe(
						Effect.andThen(
							repository.update(owner, key.connectionId, (stored) => ({
								...stored,
								connection: change(stored.connection),
								verification: null,
							})),
						),
						Effect.map((stored) => stored.connection),
						Effect.mapError(translate),
					),
				updateApp: (app) =>
					repository.updateApp(owner, app).pipe(Effect.mapError(translate)),
				delete: (key) =>
					owned(key).pipe(
						Effect.andThen(repository.remove(owner, key.connectionId)),
						Effect.mapError(translate),
					),
			})
			const credentials = Store.CredentialStore.of({
				put: Effect.fn("AppCredentials.put")(function* (credential) {
					yield* owned(credential.binding)
					const id = yield* Effect.sync(() => crypto.randomUUID())
					const encoded = yield* Schema.encodeEffect(credentialCodec)(
						credential,
					).pipe(Effect.mapError(unavailable))
					const body = yield* secrets
						.seal(encoded, binding("credential", id))
						.pipe(Effect.mapError(unavailable))
					yield* db
						.insert(appSecrets)
						.values({
							owner,
							kind: "credential",
							id,
							connectionId: credential.binding.connectionId,
							body,
						})
						.pipe(Effect.mapError(unavailable))
					return id
				}),
				get: Effect.fn("AppCredentials.get")(function* (input) {
					yield* owned(input.binding)
					const row = (yield* db
						.select()
						.from(appSecrets)
						.where(where("credential", input.reference))
						.pipe(Effect.mapError(unavailable)))[0]
					if (row === undefined) return yield* missing()
					const encoded = yield* secrets
						.open(row.body, binding("credential", input.reference))
						.pipe(Effect.mapError(unavailable))
					const credential = yield* Schema.decodeEffect(credentialCodec)(
						encoded,
					).pipe(Effect.mapError(unavailable))
					if (
						credential.binding.owner !== input.binding.owner ||
						credential.binding.connectionId !== input.binding.connectionId ||
						credential.binding.resource !== input.binding.resource ||
						credential.binding.issuer !== input.binding.issuer
					)
						return yield* missing()
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
						Effect.mapError(unavailable),
					)
					const body = yield* secrets
						.seal(encoded, binding("flow", flow.flowId))
						.pipe(Effect.mapError(unavailable))
					yield* db
						.insert(appSecrets)
						.values({
							owner,
							kind: "flow",
							id: flow.flowId,
							connectionId: flow.binding.connectionId,
							body,
						})
						.pipe(Effect.mapError(unavailable))
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
						.pipe(Effect.mapError(unavailable)))[0]
					if (row === undefined) return yield* missing()
					if (row.consumed)
						return yield* new Authorization.AuthorizationError({
							reason: "AlreadyConsumed",
							issue: "This authorization flow was already used.",
						})
					const encoded = yield* secrets
						.open(row.body, binding("flow", flowId))
						.pipe(Effect.mapError(unavailable))
					return yield* Schema.decodeEffect(flowCodec)(encoded).pipe(
						Effect.mapError(unavailable),
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
						.pipe(Effect.mapError(unavailable))
					if (rows.length === 0)
						return yield* new Authorization.AuthorizationError({
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
						.pipe(Effect.asVoid, Effect.mapError(unavailable)),
			}
		},
	})
})
export const layer = Layer.effect(ProtocolStores, make)
