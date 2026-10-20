import { randomUUID } from "node:crypto"
import { Authorization, Store } from "@openbot-build/protocol"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { DeveloperRepository } from "./DeveloperRepository.ts"
import { Secrets } from "./Secrets.ts"

const PrivateState = Schema.Struct({
	connection: Schema.NullOr(Store.UserConnection),
	credentials: Schema.Array(
		Schema.Struct({ reference: Schema.String, credential: Store.Credential }),
	),
})
type PrivateState = typeof PrivateState.Type
export interface BoundTestStores {
	readonly apps: typeof Store.AppStore.Service
	readonly credentials: typeof Store.CredentialStore.Service
	readonly flows: typeof Authorization.FlowStore.Service
	readonly clear: Effect.Effect<void, Store.StoreError>
}
export class DeveloperTestStores extends Context.Service<
	DeveloperTestStores,
	{
		readonly bind: (owner: string, id: string) => BoundTestStores
	}
>()("@openbot-build/platform/apps/DeveloperTestStores") {}

export const make: Effect.Effect<
	typeof DeveloperTestStores.Service,
	never,
	DeveloperRepository | Secrets
> = Effect.gen(function* () {
	const records = yield* DeveloperRepository
	const secrets = yield* Secrets
	const codec = Schema.fromJsonString(Schema.toCodecJson(PrivateState))
	const flowCodec = Schema.fromJsonString(
		Schema.toCodecJson(Authorization.Flow),
	)
	const error = () =>
		new Store.StoreError({
			reason: "Unavailable",
			operation: "Developer test storage",
		})
	const missing = () =>
		new Store.StoreError({
			reason: "Missing",
			operation: "Owned developer test",
		})
	return DeveloperTestStores.of({
		bind: (owner, id) => {
			const binding = JSON.stringify(["developer-test", owner, id])
			const owned = Effect.gen(function* () {
				const record = yield* records.tests
					.get(id)
					.pipe(Effect.mapError(missing))
				if (record.owner !== owner) return yield* missing()
				return record.value
			})
			const keyChecked = (key: Store.ConnectionKey) =>
				key.owner === owner && key.connectionId === id
					? Effect.void
					: Effect.fail(missing())
			const read = Effect.gen(function* () {
				yield* owned
				const record = yield* records.secrets.get(id).pipe(
					Effect.catchTag("DeveloperNotFound", () => Effect.succeed(null)),
					Effect.mapError(error),
				)
				if (record === null)
					return { connection: null, credentials: [] } satisfies PrivateState
				if (record.owner !== owner) return yield* missing()
				return yield* secrets
					.open(record.body, binding)
					.pipe(
						Effect.flatMap(Schema.decodeEffect(codec)),
						Effect.mapError(error),
					)
			})
			const write = (value: PrivateState) =>
				Schema.encodeEffect(codec)(value).pipe(
					Effect.flatMap((body) => secrets.seal(body, binding)),
					Effect.flatMap((body) =>
						records.secrets.put(id, owner, id, { owner, body }),
					),
					Effect.mapError(error),
				)
			const get = (key: Store.ConnectionKey) =>
				Effect.gen(function* () {
					yield* keyChecked(key)
					const value = yield* read
					if (value.connection === null) return yield* missing()
					return value.connection
				})
			const flow = (flowId: string) =>
				Effect.gen(function* () {
					const record = yield* records.flows
						.get(flowId)
						.pipe(Effect.mapError(missing))
					if (record.owner !== owner || record.testId !== id)
						return yield* missing()
					return record
				})
			return {
				apps: Store.AppStore.of({
					save: (input) =>
						Effect.gen(function* () {
							const test = yield* owned
							yield* keyChecked(input.connection)
							if (
								input.app.cardUrl !== test.cardUrl ||
								input.connection.cardUrl !== test.cardUrl
							)
								return yield* missing()
							yield* write({ ...(yield* read), connection: input.connection })
							return input.connection
						}),
					get,
					getApp: (cardUrl) =>
						Effect.gen(function* () {
							const test = yield* owned
							if (test.cardUrl !== cardUrl) return yield* missing()
							return yield* Store.AppRecord.decode(test.candidate)
						}),
					update: (input) =>
						records
							.transaction(
								"test:" + id,
								Effect.gen(function* () {
									const current = yield* get(input.key)
									const connection = input.change(current)
									if (
										connection.owner !== owner ||
										connection.connectionId !== id ||
										connection.cardUrl !== current.cardUrl ||
										connection.endpoint !== current.endpoint
									)
										return yield* missing()
									yield* write({ ...(yield* read), connection })
									return connection
								}),
							)
							.pipe(Effect.mapError(error)),
					updateApp: () =>
						Effect.fail(
							new Store.StoreError({
								reason: "Invalid",
								operation: "Immutable developer test target",
							}),
						),
					delete: (key) =>
						keyChecked(key).pipe(
							Effect.andThen(records.secrets.remove(id)),
							Effect.mapError(error),
						),
				}),
				credentials: Store.CredentialStore.of({
					put: (credential) =>
						records
							.transaction(
								"test:" + id,
								Effect.gen(function* () {
									const connection = yield* get({ owner, connectionId: id })
									if (
										credential.binding.owner !== owner ||
										credential.binding.connectionId !== id ||
										credential.binding.resource !== connection.endpoint
									)
										return yield* missing()
									const reference = yield* Effect.sync(randomUUID)
									const current = yield* read
									yield* write({
										...current,
										credentials: [
											...current.credentials,
											{ reference, credential },
										],
									})
									return reference
								}),
							)
							.pipe(Effect.mapError(error)),
					get: (input) =>
						Effect.gen(function* () {
							const current = yield* read
							const found = current.credentials.find(
								(value) =>
									value.reference === input.reference &&
									Schema.toEquivalence(Store.CredentialBinding)(
										value.credential.binding,
										input.binding,
									),
							)
							if (found === undefined) return yield* missing()
							return found.credential
						}),
					deleteConnection: (key) =>
						keyChecked(key).pipe(
							Effect.andThen(read),
							Effect.flatMap((current) =>
								write({ ...current, credentials: [] }),
							),
						),
				}),
				flows: Authorization.FlowStore.of({
					save: (value) =>
						Effect.gen(function* () {
							const test = yield* owned
							const connection = yield* get(value.binding)
							if (value.binding.resource !== connection.endpoint)
								return yield* missing()
							const expiresAt = Math.min(value.expiresAt, test.expiresAt)
							const body = yield* Schema.encodeEffect(flowCodec)({
								...value,
								expiresAt,
							}).pipe(
								Effect.flatMap((body) =>
									secrets.seal(body, binding + ":flow:" + value.flowId),
								),
								Effect.mapError(error),
							)
							yield* records.flows
								.put(value.flowId, owner, id, {
									owner,
									testId: id,
									body,
									callback: null,
									consumed: false,
									value: {
										flowId: value.flowId,
										status: "Waiting",
										issuer: value.binding.issuer,
										resource: value.binding.resource,
										scopes: value.scopes,
										expiresAt,
										authorizationUrl: "",
									},
								})
								.pipe(Effect.mapError(error))
						}),
					get: (input) =>
						Effect.gen(function* () {
							yield* keyChecked(input.key)
							const record = yield* flow(input.flowId)
							return yield* secrets
								.open(record.body, binding + ":flow:" + input.flowId)
								.pipe(
									Effect.flatMap(Schema.decodeEffect(flowCodec)),
									Effect.mapError(error),
								)
						}),
					consume: (input) =>
						records
							.transaction(
								"flow:" + input.flowId,
								Effect.gen(function* () {
									yield* keyChecked(input.key)
									const record = yield* flow(input.flowId)
									if (record.consumed)
										return yield* new Authorization.AuthorizationError({
											reason: "AlreadyConsumed",
											issue: "This test authorization was already used.",
										})
									if (
										record.value.expiresAt <= (yield* Clock.currentTimeMillis)
									)
										return yield* new Authorization.AuthorizationError({
											reason: "FlowExpired",
											issue: "This test authorization expired.",
										})
									yield* records.flows
										.put(input.flowId, owner, id, {
											...record,
											consumed: true,
											value: { ...record.value, status: "Exchanging" },
										})
										.pipe(Effect.mapError(error))
								}),
							)
							.pipe(Effect.catchTag("DeveloperUnavailable", error)),
				}),
				clear: Effect.gen(function* () {
					yield* records.secrets.remove(id)
					for (const record of yield* records.flows.list({ owner, scope: id }))
						yield* records.flows.remove(record.value.flowId)
				}).pipe(Effect.mapError(error)),
			}
		},
	})
})
export const layer = Layer.effect(DeveloperTestStores, make)
