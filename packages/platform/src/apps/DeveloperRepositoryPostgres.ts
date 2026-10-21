import * as Fence from "../execution/ExecutionFence.ts"
import * as OwnedWrites from "../execution/OwnedWrites.ts"
import { Context, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import { DeveloperApi as Api } from "@openbot-build/platform-api"
import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import {
	AppRecord,
	ClaimRecord,
	DeveloperRepository,
	InvitationRecord,
	MemberRecord,
	ProofRecord,
	ReportRecord,
	TestRecord,
	SecretRecord,
	TestFlowRecord,
	IndexRequestRecord,
	SubscriptionRecord,
	NoticeRecord,
	MonitorRecord,
	type Collection,
} from "./DeveloperRepository.ts"

/** Cross-account developer writes keep leases until the outer transaction commits. */
const TransactionScope = Context.Reference<Scope.Scope | undefined>(
	"platform/developer/TransactionScope",
	{ defaultValue: () => undefined },
)
const hold = <A, E, R>(owner: string, effect: Effect.Effect<A, E, R>) => {
	if (owner === "" || owner === "monitor") return effect
	const operation = Effect.gen(function* () {
		const current = yield* Fence.CurrentExecution
		const id = OwnedWrites.accountId(owner)
		return yield* current?.accountId === id
			? Fence.guardScoped(id, "write", effect)
			: Fence.admitScoped(id, effect)
	})
	return Effect.flatMap(TransactionScope, (scope) =>
		scope === undefined
			? Effect.scoped(operation)
			: Effect.provideService(operation, Scope.Scope, scope),
	)
}

export const makeFor = (
	namespace: string,
): Effect.Effect<
	typeof DeveloperRepository.Service,
	never,
	PgClient.PgClient
> =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient
		const unavailable = () => Api.DeveloperUnavailable.make({})
		const collection = <A>(
			kind: string,
			schema: Schema.Codec<A>,
		): Collection<A> => {
			const recordKind = namespace + ":" + kind
			const codec = Schema.fromJsonString(Schema.toCodecJson(schema))
			const find = (id: string) =>
				sql<{
					body: string
				}>`SELECT body FROM openbot_developer_records WHERE kind = ${recordKind} AND id = ${id}`.pipe(
					Effect.map(Arr.head),
					Effect.flatMap((row) =>
						Effect.transposeOption(
							Option.map(row, (row) => Schema.decodeEffect(codec)(row.body)),
						),
					),
					Effect.mapError(unavailable),
				)
			return {
				find,
				get: (id) =>
					find(id).pipe(
						Effect.flatMap(Effect.fromOption),
						Effect.catchTag("NoSuchElementError", () =>
							Effect.fail(Api.DeveloperNotFound.make({})),
						),
					),
				list: (filter = {}) =>
					sql<{
						body: string
					}>`SELECT body FROM openbot_developer_records WHERE kind = ${recordKind} AND (${filter.owner ?? null}::text IS NULL OR owner = ${filter.owner ?? null}) AND (${filter.scope ?? null}::text IS NULL OR scope = ${filter.scope ?? null}) ORDER BY id`.pipe(
						Effect.flatMap((rows) =>
							Effect.forEach(rows, (row) =>
								Schema.decodeEffect(codec)(row.body),
							),
						),
						Effect.mapError(unavailable),
					),
				put: (id, owner, scope, value) =>
					hold(
						owner,
						Effect.gen(function* () {
							const body = yield* Schema.encodeEffect(codec)(value)
							const rows =
								yield* sql`INSERT INTO openbot_developer_records (kind, id, owner, scope, body) VALUES (${recordKind}, ${id}, ${owner}, ${scope}, ${body}) ON CONFLICT (kind, id) DO UPDATE SET scope = EXCLUDED.scope, body = EXCLUDED.body WHERE openbot_developer_records.owner = EXCLUDED.owner RETURNING id`
							if (rows.length !== 1) return yield* unavailable()
						}),
					).pipe(Effect.asVoid, Effect.mapError(unavailable)),
				remove: (id) =>
					Effect.gen(function* () {
						const rows = yield* sql<{
							owner: string
						}>`SELECT owner FROM openbot_developer_records WHERE kind = ${recordKind} AND id = ${id}`
						const owner = rows[0]?.owner
						if (owner === undefined) return
						yield* hold(
							owner,
							sql`DELETE FROM openbot_developer_records WHERE kind = ${recordKind} AND id = ${id} AND owner = ${owner}`,
						)
					}).pipe(Effect.asVoid, Effect.mapError(unavailable)),
			}
		}
		return DeveloperRepository.of({
			claims: collection("claim", ClaimRecord),
			proofs: collection("proof", ProofRecord),
			invitations: collection("invitation", InvitationRecord),
			members: collection("member", MemberRecord),
			apps: collection("app", AppRecord),
			reports: collection("report", ReportRecord),
			tests: collection("test", TestRecord),
			secrets: collection("testSecret", SecretRecord),
			flows: collection("testFlow", TestFlowRecord),
			indexing: collection("indexRequest", IndexRequestRecord),
			subscriptions: collection("subscription", SubscriptionRecord),
			notices: collection("notice", NoticeRecord),
			monitors: collection("monitor", MonitorRecord),
			transaction: (key, operation) =>
				Effect.flatMap(TransactionScope, (existing) => {
					const transaction = sql
						.withTransaction(
							Effect.gen(function* () {
								yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${"developer:" + key}, 0))`.pipe(
									Effect.mapError(unavailable),
								)
								return yield* operation
							}),
						)
						.pipe(
							Effect.catchTag("SqlError", unavailable),
							Effect.uninterruptible,
						)
					if (existing !== undefined) return transaction
					return Effect.scoped(
						Effect.flatMap(Scope.Scope, (scope) =>
							transaction.pipe(Effect.provideService(TransactionScope, scope)),
						),
					)
				}),
		})
	})
export const make = makeFor("public")
export const layerFor = (namespace: string) =>
	Layer.effect(DeveloperRepository, makeFor(namespace))
export const layer = layerFor("public")
