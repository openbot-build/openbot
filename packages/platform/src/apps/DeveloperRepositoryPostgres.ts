import { PgClient } from "@effect/sql-pg"
import { DeveloperApi as Api } from "@openbot-build/platform-api"
import { Effect, Layer, Schema } from "effect"
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
			return {
				get: (id) =>
					Effect.gen(function* () {
						const rows = yield* sql<{
							body: string
						}>`SELECT body FROM openbot_developer_records WHERE kind = ${recordKind} AND id = ${id}`.pipe(
							Effect.mapError(unavailable),
						)
						if (rows[0] === undefined)
							return yield* Api.DeveloperNotFound.make({})
						return yield* Schema.decodeEffect(codec)(rows[0].body).pipe(
							Effect.mapError(unavailable),
						)
					}),
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
					Schema.encodeEffect(codec)(value).pipe(
						Effect.flatMap(
							(body) =>
								sql`INSERT INTO openbot_developer_records (kind, id, owner, scope, body) VALUES (${recordKind}, ${id}, ${owner}, ${scope}, ${body}) ON CONFLICT (kind, id) DO UPDATE SET owner = EXCLUDED.owner, scope = EXCLUDED.scope, body = EXCLUDED.body`,
						),
						Effect.asVoid,
						Effect.mapError(unavailable),
					),
				remove: (id) =>
					sql`DELETE FROM openbot_developer_records WHERE kind = ${recordKind} AND id = ${id}`.pipe(
						Effect.asVoid,
						Effect.mapError(unavailable),
					),
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
				sql
					.withTransaction(
						Effect.gen(function* () {
							yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${"developer:" + key}, 0))`.pipe(
								Effect.mapError(unavailable),
							)
							return yield* operation
						}),
					)
					.pipe(Effect.catchTag("SqlError", unavailable)),
		})
	})
export const make = makeFor("public")
export const layerFor = (namespace: string) =>
	Layer.effect(DeveloperRepository, makeFor(namespace))
export const layer = layerFor("public")
