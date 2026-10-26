import { Authorization, Store } from "@openbot-build/protocol"
import { PgClient } from "@effect/sql-pg"
import { and, eq } from "drizzle-orm"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { developerTestFlows, developerTests } from "../database/Schema.ts"
import { Secrets } from "../secrets/Secrets.ts"
import * as Rows from "./DeveloperRows.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import * as Db from "../database/Database.ts"

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
>()("@openbot-build/openbot/apps/DeveloperTestStores") {}

export const make: Effect.Effect<
	typeof DeveloperTestStores.Service,
	never,
	PgClient.PgClient | Secrets | Crypto.Crypto
> = Effect.gen(function* () {
	const db = yield* Db.make
	const inTransaction = Rows.transaction(yield* PgClient.PgClient)
	const namespace = yield* IndexNamespace
	const secrets = yield* Secrets
	const crypto = yield* Crypto.Crypto
	const codec = Schema.fromJsonString(Schema.toCodecJson(PrivateState))
	const flowCodec = Schema.fromJsonString(
		Schema.toCodecJson(Authorization.Flow),
	)
	const unavailable = (cause: unknown) =>
		Store.StoreError.make({
			reason: "Unavailable",
			operation: "Developer test storage",
			cause,
		})
	const missing = () =>
		Store.StoreError.make({
			reason: "Missing",
			operation: "Owned developer test",
		})
	return DeveloperTestStores.of({
		bind: (owner, id) => {
			const binding = JSON.stringify(["developer-test", owner, id])
			const testWhere = and(
				eq(developerTests.namespace, namespace),
				eq(developerTests.id, id),
				eq(developerTests.owner, owner),
			)
			/** Read the test. With `lock`, keep its row locked until the transaction ends. */
			const ownedTest = (lock: boolean) =>
				Rows.getTest(db, namespace, id, lock).pipe(
					Effect.catchTags({
						DeveloperNotFound: () => missing(),
						DeveloperUnavailable: unavailable,
					}),
					Effect.flatMap((record) =>
						record.owner === owner
							? Effect.succeed(record.value)
							: Effect.fail(missing()),
					),
				)
			const owned = ownedTest(false)
			const keyChecked = (key: Store.ConnectionKey) =>
				key.owner === owner && key.connectionId === id
					? Effect.void
					: Effect.fail(missing())
			const read = Effect.gen(function* () {
				const row = (yield* db
					.select({ privateState: developerTests.privateState })
					.from(developerTests)
					.where(testWhere)
					.pipe(Effect.mapError(unavailable)))[0]
				if (row === undefined) return yield* missing()
				if (row.privateState === null)
					return { connection: null, credentials: [] } satisfies PrivateState
				return yield* secrets
					.open(row.privateState, binding)
					.pipe(
						Effect.flatMap(Schema.decodeEffect(codec)),
						Effect.mapError(unavailable),
					)
			})
			const setPrivateState = (privateState: string | null) =>
				db
					.update(developerTests)
					.set({ privateState })
					.where(testWhere)
					.pipe(Effect.asVoid, Effect.mapError(unavailable))
			const write = (value: PrivateState) =>
				Schema.encodeEffect(codec)(value).pipe(
					Effect.flatMap((body) => secrets.seal(body, binding)),
					Effect.mapError(unavailable),
					Effect.flatMap(setPrivateState),
				)
			/** Run the change while the test row is locked. */
			const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
				inTransaction(ownedTest(true).pipe(Effect.andThen(effect)))
			const get = (key: Store.ConnectionKey) =>
				Effect.gen(function* () {
					yield* keyChecked(key)
					const value = yield* read
					if (value.connection === null) return yield* missing()
					return value.connection
				})
			const flow = (flowId: string) =>
				Effect.gen(function* () {
					const record = yield* Rows.getFlow(db, namespace, flowId).pipe(
						Effect.catchTags({
							DeveloperNotFound: () => missing(),
							DeveloperUnavailable: unavailable,
						}),
					)
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
						locked(
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
						).pipe(Effect.catchTag("DeveloperUnavailable", unavailable)),
					updateApp: () =>
						Effect.fail(
							Store.StoreError.make({
								reason: "Invalid",
								operation: "Immutable developer test target",
							}),
						),
					delete: (key) =>
						keyChecked(key).pipe(Effect.andThen(setPrivateState(null))),
				}),
				credentials: Store.CredentialStore.of({
					put: (credential) =>
						locked(
							Effect.gen(function* () {
								const connection = yield* get({ owner, connectionId: id })
								if (
									credential.binding.owner !== owner ||
									credential.binding.connectionId !== id ||
									credential.binding.resource !== connection.endpoint
								)
									return yield* missing()
								const reference = yield* crypto
									.randomUUIDv4()
									.pipe(Effect.orDie)
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
						).pipe(Effect.catchTag("DeveloperUnavailable", unavailable)),
					get: (input) =>
						Effect.gen(function* () {
							const current = yield* read
							const found = Arr.findFirst(
								current.credentials,
								(value) =>
									value.reference === input.reference &&
									Schema.toEquivalence(Store.CredentialBinding)(
										value.credential.binding,
										input.binding,
									),
							)
							if (Option.isNone(found)) return yield* missing()
							return found.value.credential
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
								Effect.mapError(unavailable),
							)
							yield* Rows.putFlow(db, namespace, {
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
							}).pipe(Effect.mapError(unavailable))
						}),
					get: (input) =>
						Effect.gen(function* () {
							yield* keyChecked(input.key)
							const record = yield* flow(input.flowId)
							if (record.body === null) return yield* missing()
							return yield* secrets
								.open(record.body, binding + ":flow:" + input.flowId)
								.pipe(
									Effect.flatMap(Schema.decodeEffect(flowCodec)),
									Effect.mapError(unavailable),
								)
						}),
					consume: (input) =>
						locked(
							Effect.gen(function* () {
								yield* keyChecked(input.key)
								const record = yield* flow(input.flowId)
								if (record.consumed)
									return yield* Authorization.AuthorizationError.make({
										reason: "AlreadyConsumed",
										issue: "This test authorization was already used.",
									})
								if (record.value.expiresAt <= (yield* Clock.currentTimeMillis))
									return yield* Authorization.AuthorizationError.make({
										reason: "FlowExpired",
										issue: "This test authorization expired.",
									})
								yield* Rows.putFlow(db, namespace, {
									...record,
									consumed: true,
									value: { ...record.value, status: "Exchanging" },
								}).pipe(Effect.mapError(unavailable))
							}),
						).pipe(Effect.catchTag("DeveloperUnavailable", unavailable)),
				}),
				clear: Effect.gen(function* () {
					yield* setPrivateState(null)
					yield* db
						.delete(developerTestFlows)
						.where(
							and(
								eq(developerTestFlows.namespace, namespace),
								eq(developerTestFlows.testId, id),
								eq(developerTestFlows.owner, owner),
							),
						)
						.pipe(Effect.mapError(unavailable))
				}),
			}
		},
	})
})
export const layer = Layer.effect(DeveloperTestStores, make)
