import { Execution } from "@openbot-build/domain"
import { Store as Protocol } from "@openbot-build/protocol"
import { and, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm"
import { Array as Arr, Effect, Option, Schema } from "effect"
import * as Db from "../database/Database.ts"
import { appGrantUses, appSecrets } from "../database/Schema.ts"
import { executions } from "../database/ExecutionSchema.ts"
import { storage, type Key } from "../execution/Store.ts"
import { Secrets } from "../secrets/Secrets.ts"

/** OAuth may revoke all grants from the same issuer and client together. */
export const Scope = Schema.Struct({
	issuer: Schema.String,
	clientId: Schema.NullOr(Schema.String),
})
export type Scope = typeof Scope.Type
export const scopeOf = (credential: Protocol.Credential): Scope => ({
	issuer: credential.binding.issuer,
	clientId: credential.clientId ?? null,
})
export const scopeKey = (scope: Scope) =>
	JSON.stringify([scope.issuer, scope.clientId])
export const testReference = (namespace: string, id: string) =>
	JSON.stringify([namespace, id])
const terminal = ["completed", "failed", "cancelled", "interrupted"] as const
const credentialCodec = Schema.fromJsonString(
	Schema.toCodecJson(Protocol.Credential),
)
type TestState = {
	readonly connection: Protocol.UserConnection | null
	readonly credentials: ReadonlyArray<{
		readonly reference: string
		readonly credential: Protocol.Credential
	}>
}

/** All methods join the caller's transaction. They do not open one. */
export const makeWith = (db: Db.Database, secrets: typeof Secrets.Service) => {
	const lock = (scope: Scope) =>
		storage(
			db.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${"app-grant:" + scopeKey(scope)}, 0))`,
			),
		).pipe(Effect.asVoid)
	const pending = (scope: Scope, kind: "send" | "revoke", except?: Key) =>
		Effect.gen(function* () {
			const rows = yield* storage(
				db
					.select({
						namespace: executions.namespace,
						id: executions.id,
						sequence: executions.sequence,
					})
					.from(appGrantUses)
					.innerJoin(
						executions,
						and(
							eq(executions.namespace, appGrantUses.namespace),
							eq(executions.id, appGrantUses.executionId),
						),
					)
					.where(
						and(
							eq(appGrantUses.scopeKey, scopeKey(scope)),
							eq(appGrantUses.kind, kind),
							notInArray(executions.status, [...terminal]),
							...(except === undefined
								? []
								: [
										or(
											ne(executions.namespace, except.namespace),
											ne(executions.id, except.id),
										),
									]),
						),
					)
					.limit(1),
			)
			return yield* Effect.transposeOption(
				Option.map(Arr.head(rows), (row) =>
					Schema.decodeEffect(Execution.Id)(row.id).pipe(
						Effect.map((id) => ({
							key: { namespace: row.namespace, id },
							sequence: row.sequence,
						})),
					),
				),
			)
		})
	const hold = (
		namespace: string,
		kind: "connection" | "developer-test",
		reference: string,
		scope: Scope | null,
	) =>
		Effect.gen(function* () {
			if (scope !== null) {
				yield* lock(scope)
				const held = yield* pending(scope, "revoke")
				if (Option.isSome(held))
					return yield* Execution.Conflict.make({ id: held.value.key.id })
				yield* storage(
					db
						.insert(appGrantUses)
						.values({
							namespace,
							kind,
							reference,
							scopeKey: scopeKey(scope),
							executionId: null,
						})
						.onConflictDoUpdate({
							target: [
								appGrantUses.namespace,
								appGrantUses.kind,
								appGrantUses.reference,
							],
							set: { scopeKey: scopeKey(scope), executionId: null },
						}),
				)
			} else
				yield* storage(
					db
						.delete(appGrantUses)
						.where(
							and(
								eq(appGrantUses.namespace, namespace),
								eq(appGrantUses.kind, kind),
								eq(appGrantUses.reference, reference),
							),
						),
				)
		})
	const connection = (value: Protocol.UserConnection) =>
		Effect.gen(function* () {
			const auth = value.authorization
			if (auth._tag !== "Authorized")
				return yield* hold(value.owner, "connection", value.connectionId, null)
			const row = (yield* storage(
				db
					.select({ body: appSecrets.body })
					.from(appSecrets)
					.where(
						and(
							eq(appSecrets.owner, value.owner),
							eq(appSecrets.kind, "credential"),
							eq(appSecrets.id, auth.credentialRef),
						),
					)
					.limit(1),
			))[0]
			if (row === undefined)
				return yield* Execution.StorageError.make({
					cause: "The current grant is missing.",
				})
			const credential = yield* secrets
				.open(
					row.body,
					yield* Schema.encodeEffect(
						Schema.fromJsonString(Schema.Array(Schema.String)),
					)(["credential", value.owner, auth.credentialRef]),
				)
				.pipe(Effect.flatMap(Schema.decodeEffect(credentialCodec)))
			yield* hold(
				value.owner,
				"connection",
				value.connectionId,
				scopeOf(credential),
			)
		})
	const test = (
		namespace: string,
		owner: string,
		id: string,
		state: TestState,
	) =>
		Effect.gen(function* () {
			const auth = state.connection?.authorization
			if (auth?._tag !== "Authorized")
				return yield* hold(
					owner,
					"developer-test",
					testReference(namespace, id),
					null,
				)
			const found = Arr.findFirst(
				state.credentials,
				(credential) => credential.reference === auth.credentialRef,
			)
			if (Option.isNone(found))
				return yield* Execution.StorageError.make({
					cause: "The current test grant is missing.",
				})
			yield* hold(
				owner,
				"developer-test",
				testReference(namespace, id),
				scopeOf(found.value.credential),
			)
		})
	return {
		lock,
		hold,
		pending,
		connection,
		test,
		reserve: (
			key: Key,
			kind: "send" | "revoke",
			reference: string,
			scope: Scope,
		) =>
			storage(
				db
					.insert(appGrantUses)
					.values({
						namespace: key.namespace,
						kind,
						reference,
						scopeKey: scopeKey(scope),
						executionId: key.id,
					})
					.onConflictDoNothing(),
			).pipe(Effect.asVoid),
		inUse: (scope: Scope) =>
			storage(
				db
					.select({ reference: appGrantUses.reference })
					.from(appGrantUses)
					.where(
						and(
							eq(appGrantUses.scopeKey, scopeKey(scope)),
							inArray(appGrantUses.kind, ["connection", "developer-test"]),
						),
					)
					.limit(1),
			).pipe(Effect.map(Arr.isReadonlyArrayNonEmpty)),
	}
}
export const make = Effect.gen(function* () {
	return makeWith(yield* Db.make, yield* Secrets)
})
