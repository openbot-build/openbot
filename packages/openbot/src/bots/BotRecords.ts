import { PgClient } from "@effect/sql-pg"
import { BotsApi } from "@openbot-build/api"
import { Array as Arr, Context, Effect, Layer, Option, Schema } from "effect"

/** Where one record is. `owner` and `scope` are the keys that lists filter by. */
export interface Keys<Status extends string = string> {
	readonly organizationId: string
	readonly id: string
	readonly owner: string
	readonly scope: string
	readonly status: Status
}

export interface Filter<Status extends string = string> {
	readonly owner?: string
	readonly scope?: string
	readonly status?: Status
}

/** Typed JSON records of one kind. */
export interface Collection<A, Status extends string = string> {
	readonly find: (
		organizationId: string,
		id: string,
	) => Effect.Effect<Option.Option<A>, BotsApi.BotStorageUnavailable>
	readonly list: (
		organizationId: string,
		filter?: Filter<Status>,
	) => Effect.Effect<ReadonlyArray<A>, BotsApi.BotStorageUnavailable>
	/** Records with this status in every organization. Recovery uses it after a restart. */
	readonly withStatus: (
		status: Status,
	) => Effect.Effect<
		ReadonlyArray<{ readonly organizationId: string; readonly value: A }>,
		BotsApi.BotStorageUnavailable
	>
	readonly put: (
		keys: Keys<Status>,
		value: A,
	) => Effect.Effect<void, BotsApi.BotStorageUnavailable>
	readonly remove: (
		organizationId: string,
		id: string,
	) => Effect.Effect<void, BotsApi.BotStorageUnavailable>
}

export class BotRecords extends Context.Service<
	BotRecords,
	{
		/** `status` is the set of values that the status key can have. */
		readonly collection: <
			S extends Schema.Codec<any, any>,
			Status extends string = string,
		>(
			kind: string,
			schema: S,
			status?: Schema.Schema<Status>,
		) => Collection<S["Type"], Status>
		/**
		 * Runs the operation in one transaction that holds a lock on `key`.
		 * Read-change-write steps on the same key never run at the same time.
		 */
		readonly transaction: <A, E, R>(
			key: string,
			operation: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E | BotsApi.BotStorageUnavailable, R>
	}
>()("@openbot-build/openbot/bots/BotRecords") {}

export const make: Effect.Effect<
	typeof BotRecords.Service,
	never,
	PgClient.PgClient
> = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const unavailable = () => BotsApi.BotStorageUnavailable.make({})
	const collection = <
		S extends Schema.Codec<any, any>,
		Status extends string = string,
	>(
		kind: string,
		schema: S,
		// Only the type of the status keys comes from this schema.
		_status?: Schema.Schema<Status>,
	): Collection<S["Type"], Status> => {
		type A = S["Type"]
		const codec = Schema.fromJsonString(
			Schema.toCodecJson(schema),
		) as Schema.Codec<A, string>
		const decode = Schema.decodeEffect(codec)
		return {
			find: (organizationId, id) =>
				sql<{
					body: string
				}>`SELECT body FROM openbot_bot_records WHERE kind = ${kind} AND organization_id = ${organizationId} AND id = ${id}`.pipe(
					Effect.map(Arr.head),
					Effect.flatMap((row) =>
						Effect.transposeOption(Option.map(row, (row) => decode(row.body))),
					),
					Effect.mapError(unavailable),
				),
			list: (organizationId, filter = {}) =>
				sql<{
					body: string
				}>`SELECT body FROM openbot_bot_records WHERE kind = ${kind} AND organization_id = ${organizationId} AND (${filter.owner ?? null}::text IS NULL OR owner = ${filter.owner ?? null}) AND (${filter.scope ?? null}::text IS NULL OR scope = ${filter.scope ?? null}) AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null}) ORDER BY id`.pipe(
					Effect.flatMap((rows) =>
						Effect.forEach(rows, (row) => decode(row.body)),
					),
					Effect.mapError(unavailable),
				),
			withStatus: (status) =>
				sql<{
					organization_id: string
					body: string
				}>`SELECT organization_id, body FROM openbot_bot_records WHERE kind = ${kind} AND status = ${status} ORDER BY id`.pipe(
					Effect.flatMap((rows) =>
						Effect.forEach(rows, (row) =>
							decode(row.body).pipe(
								Effect.map((value) => ({
									organizationId: row.organization_id,
									value,
								})),
							),
						),
					),
					Effect.mapError(unavailable),
				),
			put: (keys, value) =>
				Schema.encodeEffect(codec)(value).pipe(
					Effect.flatMap(
						(body) =>
							sql`INSERT INTO openbot_bot_records (kind, organization_id, id, owner, scope, status, body) VALUES (${kind}, ${keys.organizationId}, ${keys.id}, ${keys.owner}, ${keys.scope}, ${keys.status}, ${body}) ON CONFLICT (kind, organization_id, id) DO UPDATE SET owner = EXCLUDED.owner, scope = EXCLUDED.scope, status = EXCLUDED.status, body = EXCLUDED.body`,
					),
					Effect.asVoid,
					Effect.mapError(unavailable),
				),
			remove: (organizationId, id) =>
				sql`DELETE FROM openbot_bot_records WHERE kind = ${kind} AND organization_id = ${organizationId} AND id = ${id}`.pipe(
					Effect.asVoid,
					Effect.mapError(unavailable),
				),
		}
	}
	return BotRecords.of({
		collection,
		transaction: (key, operation) =>
			sql
				.withTransaction(
					Effect.gen(function* () {
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${"bots:" + key}, 0))`.pipe(
							Effect.mapError(unavailable),
						)
						return yield* operation
					}),
				)
				.pipe(Effect.catchTag("SqlError", unavailable)),
	})
})
export const layer = Layer.effect(BotRecords, make)
