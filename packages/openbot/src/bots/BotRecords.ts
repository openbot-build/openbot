import { PgClient } from "@effect/sql-pg"
import { Bots as BotsApi } from "@openbot-build/domain"
import { Array as Arr, Context, Effect, Layer, Option, Schema } from "effect"
import * as Failures from "../errors/Failures.ts"

/** Fails with `BotStorageUnavailable` in place of a storage failure, and logs the failure. */
const storageUnavailable = (message: string) =>
	Failures.replace(message, () => BotsApi.BotStorageUnavailable.make({}))

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
		/**
		 * Takes the lock on `key` as well, and waits for it. The lock lasts until
		 * the transaction ends, so use it only inside `transaction`.
		 */
		readonly lock: (
			key: string,
		) => Effect.Effect<void, BotsApi.BotStorageUnavailable>
	}
>()("@openbot-build/openbot/bots/BotRecords") {}

export const make: Effect.Effect<
	typeof BotRecords.Service,
	never,
	PgClient.PgClient
> = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const collection = <
		S extends Schema.Codec<any, any>,
		Status extends string = string,
	>(
		kind: string,
		schema: S,
		// Only the type of the status keys comes from this schema.
		_status?: Schema.Schema<Status>,
	): Collection<S["Type"], Status> => {
		const codec = Schema.fromJsonString(Schema.toCodecJson(schema))
		const decode = Schema.decodeEffect(codec)
		// Each log of a read or a change names the record, so the operator can find the row.
		return {
			find: (organizationId, id) =>
				sql<{
					body: string
				}>`SELECT body FROM openbot_bot_records WHERE kind = ${kind} AND organization_id = ${organizationId} AND id = ${id}`.pipe(
					Effect.map(Arr.head),
					Effect.flatMap((row) =>
						Effect.transposeOption(Option.map(row, (row) => decode(row.body))),
					),
					storageUnavailable("A Bot record could not be read."),
					Effect.annotateLogs({
						botRecordKind: kind,
						organizationId,
						botRecordId: id,
					}),
				),
			list: (organizationId, filter = {}) =>
				sql<{
					id: string
					body: string
				}>`SELECT id, body FROM openbot_bot_records WHERE kind = ${kind} AND organization_id = ${organizationId} AND (${filter.owner ?? null}::text IS NULL OR owner = ${filter.owner ?? null}) AND (${filter.scope ?? null}::text IS NULL OR scope = ${filter.scope ?? null}) AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null}) ORDER BY id`.pipe(
					storageUnavailable("The Bot records could not be listed."),
					// A record that does not decode fails the list. The log names it.
					Effect.flatMap((rows) =>
						Effect.forEach(rows, (row) =>
							decode(row.body).pipe(
								storageUnavailable("A Bot record could not be read."),
								Effect.annotateLogs({ botRecordId: row.id }),
							),
						),
					),
					Effect.annotateLogs({ botRecordKind: kind, organizationId }),
				),
			put: (keys, value) =>
				Schema.encodeEffect(codec)(value).pipe(
					Effect.flatMap(
						(body) =>
							sql`INSERT INTO openbot_bot_records (kind, organization_id, id, owner, scope, status, body) VALUES (${kind}, ${keys.organizationId}, ${keys.id}, ${keys.owner}, ${keys.scope}, ${keys.status}, ${body}) ON CONFLICT (kind, organization_id, id) DO UPDATE SET owner = EXCLUDED.owner, scope = EXCLUDED.scope, status = EXCLUDED.status, body = EXCLUDED.body`,
					),
					Effect.asVoid,
					storageUnavailable("A Bot record could not be written."),
					Effect.annotateLogs({
						botRecordKind: kind,
						organizationId: keys.organizationId,
						botRecordId: keys.id,
					}),
				),
			remove: (organizationId, id) =>
				sql`DELETE FROM openbot_bot_records WHERE kind = ${kind} AND organization_id = ${organizationId} AND id = ${id}`.pipe(
					Effect.asVoid,
					storageUnavailable("A Bot record could not be removed."),
					Effect.annotateLogs({
						botRecordKind: kind,
						organizationId,
						botRecordId: id,
					}),
				),
		}
	}
	const lock = (key: string) =>
		sql`SELECT pg_advisory_xact_lock(hashtextextended(${"bots:" + key}, 0))`.pipe(
			Effect.asVoid,
			storageUnavailable("The lock of a Bot record could not be taken."),
			Effect.annotateLogs({ botRecordLock: key }),
		)
	return BotRecords.of({
		collection,
		lock,
		transaction: (key, operation) =>
			sql
				.withTransaction(Effect.andThen(lock(key), operation))
				.pipe(
					Effect.catchTag("SqlError", (error) =>
						Effect.fail(error).pipe(
							storageUnavailable("A transaction of Bot records failed."),
						),
					),
				),
	})
})
export const layer = Layer.effect(BotRecords, make)
