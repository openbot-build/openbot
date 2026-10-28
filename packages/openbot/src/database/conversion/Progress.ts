import { getTableName } from "drizzle-orm"
import {
	Array as Arr,
	Cause,
	Clock,
	Crypto,
	Effect,
	Record as Rec,
	Schema,
	String as Str,
} from "effect"
import { SqlClient } from "effect/sql"
import * as Tables from "../Schema.ts"
import * as Auth from "../AuthSchema.ts"
import { codec, snapshot } from "../../errors/Snapshot.ts"
import { Secrets } from "../../secrets/Secrets.ts"
import * as Legacy from "./LegacyV1.ts"

export const version = "execution/1"
const lockId = 727124612
const json = Schema.fromJsonString(Schema.Json)
export class UpgradeRequired extends Schema.TaggedError<
	UpgradeRequired,
	{ readonly brand: unique symbol }
>()("DataUpgradeRequired", {
	reason: Schema.Literals([
		"Maintenance",
		"Missing",
		"Blocked",
		"SourceUnknown",
	]),
	message: Schema.String,
}) {}
export class InvalidRecord extends Schema.TaggedError<
	InvalidRecord,
	{ readonly brand: unique symbol }
>()("DataUpgradeInvalidRecord", {
	step: Schema.String,
	errorId: Schema.String,
	message: Schema.String,
}) {}
export class InvalidData extends Schema.TaggedError<
	InvalidData,
	{ readonly brand: unique symbol }
>()("DataUpgradeCheckFailed", { message: Schema.String }) {}
const required = (reason: UpgradeRequired["reason"]) =>
	UpgradeRequired.make({
		reason,
		message:
			reason === "Maintenance"
				? "Stop all OpenBot servers before the data move."
				: "The data move is not complete. Run openbot migrate and read its report.",
	})

/** A live server holds a shared lock. The maintenance program needs the only lock. */
const lock = (shared: boolean) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const connection = yield* sql.reserve
		const [row] = yield* connection.executeValues(
			shared
				? "select pg_try_advisory_lock_shared($1)"
				: "select pg_try_advisory_lock($1)",
			[lockId],
		)
		if (row?.[0] !== true) return yield* required("Maintenance")
		yield* Effect.addFinalizer(() =>
			connection
				.executeValues(
					shared
						? "select pg_advisory_unlock_shared($1)"
						: "select pg_advisory_unlock($1)",
					[lockId],
				)
				.pipe(Effect.orDie),
		)
	})
export const withMaintenance = <A, E, R>(work: Effect.Effect<A, E, R>) =>
	Effect.scoped(lock(false).pipe(Effect.andThen(work)))

export const checkReadyFor = (dataVersion: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const rows = yield* sql<{
			state: string
			checked_at: string | null
		}>`select state, checked_at from openbot_data_upgrades where version = ${dataVersion}`
		const row = rows[0]
		if (row === undefined) return yield* required("Missing")
		if (row.state !== "ready" || row.checked_at === null)
			return yield* required("Blocked")
	})
export const checkReady = checkReadyFor(version)
/** Keep this scope open until every server service has closed. */
export const checkStartup = lock(true).pipe(Effect.andThen(checkReady))

/** Counts are a full inventory, including auth and tables whose data format is unchanged. */
export const inventory = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	return yield* Effect.forEach(
		Arr.sort(
			Arr.filter(
				Arr.map(Rec.values({ ...Tables, ...Auth }), getTableName),
				(name) => !Str.startsWith("openbot_data_upgrade")(name),
			),
			Str.Order,
		),
		(name) =>
			Effect.gen(function* () {
				const rows = yield* sql<{
					count: number
				}>`select count(*)::float8 as count from ${sql(name)}`
				return {
					table: name,
					rows: yield* Schema.decodeUnknownEffect(Schema.Natural)(
						rows[0]?.count,
					),
				}
			}),
	)
})

/** Only a truly empty database can be ready without any row conversion. */
export const establish = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	return yield* sql.withTransaction(
		Effect.gen(function* () {
			const found = yield* sql<{
				source: string
			}>`select source from openbot_data_upgrades where version = ${version} for update`
			if (found[0] !== undefined) return found[0].source
			const counts = yield* inventory
			const empty = Arr.every(counts, (entry) => entry.rows === 0)
			const hasNewWork = Arr.some(
				counts,
				(entry) => entry.table === "openbot_executions" && entry.rows > 0,
			)
			const source = empty ? "empty" : hasNewWork ? "unknown" : Legacy.source
			const now = yield* Clock.currentTimeMillis
			yield* sql`insert into openbot_data_upgrades ${sql.insert({
				version,
				source,
				state: empty ? "ready" : "blocked",
				counts: yield* Schema.encodeEffect(json)(counts),
				started_at: now,
				updated_at: now,
				checked_at: empty ? now : null,
			})}`
			return source
		}),
	)
})

/** Batch work and its cursor use the same SQL transaction. Failed batches keep their cursor. */
export const makeFor = (dataVersion: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const secrets = yield* Secrets
		const crypto = yield* Crypto.Crypto
		const report = (step: string, cause: Cause.Cause<unknown>) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const errorId = yield* crypto.randomUUIDv7()
				const sealed = yield* secrets.seal(
					yield* cause.pipe(snapshot, Schema.encodeEffect(codec)),
					`data-upgrade-failure:${errorId}`,
				)
				yield* sql`insert into openbot_data_upgrade_failures ${sql.insert({ id: errorId, version: dataVersion, step, cause: sealed, created_at: now })}`
				yield* sql`update openbot_data_upgrades set state = 'blocked', checked_at = null, updated_at = ${now} where version = ${dataVersion}`
				return yield* InvalidRecord.make({
					step,
					errorId,
					message:
						"A stored record is not valid. Its cause is in the sealed data move report.",
				})
			})
		const batch = <A, E>(
			step: {
				readonly name: string
				readonly read: (
					cursor: string | null,
					limit: number,
				) => Effect.Effect<ReadonlyArray<A>, E>
				readonly key: (row: A) => string
				readonly convert: (row: A) => Effect.Effect<void, E>
			},
			limit: number,
		) =>
			sql
				.withTransaction(
					Effect.gen(function* () {
						const now = yield* Clock.currentTimeMillis
						yield* sql`insert into openbot_data_upgrade_steps ${sql.insert({ version: dataVersion, step: step.name, updated_at: now })} on conflict (version, step) do nothing`
						const [current] = yield* sql<{
							cursor: string | null
							complete: boolean
						}>`select cursor, complete from openbot_data_upgrade_steps where version = ${dataVersion} and step = ${step.name} for update`
						if (current === undefined)
							return yield* Effect.die("The data move step is missing.")
						if (current.complete) return { complete: true, rows: 0 }
						const rows = yield* step.read(current.cursor, limit)
						yield* Effect.forEach(rows, step.convert, { discard: true })
						const last = Arr.last(rows)
						const cursor =
							last._tag === "None" ? current.cursor : step.key(last.value)
						const complete = rows.length < limit
						yield* sql`update openbot_data_upgrade_steps set cursor = ${cursor}, complete = ${complete}, rows = rows + ${rows.length}, updated_at = ${now} where version = ${dataVersion} and step = ${step.name}`
						return { complete, rows: rows.length }
					}),
				)
				.pipe(
					Effect.catchCauseIf(
						(cause) => !Cause.hasInterruptsOnly(cause),
						(cause) => report(step.name, cause),
					),
				)
		const record = (
			collection: string,
			key: string,
			state: "converted" | "needs_authorization",
			body: Schema.Json,
		) =>
			Effect.gen(function* () {
				const binding = yield* Schema.encodeEffect(json)([
					"data-upgrade",
					dataVersion,
					collection,
					key,
				])
				const sealed = yield* secrets.seal(
					yield* Schema.encodeEffect(json)(body),
					binding,
				)
				yield* sql`insert into openbot_data_upgrade_records ${sql.insert({ version: dataVersion, collection, key, state, body: sealed, updated_at: yield* Clock.currentTimeMillis })} on conflict (version, collection, key) do nothing`
			})
		/** Checks always read again. A saved conversion cursor is not proof that its rows are still valid. */
		const check = <A, E, R>(name: string, work: Effect.Effect<A, E, R>) =>
			work.pipe(
				Effect.catchCauseIf(
					(cause) => !Cause.hasInterruptsOnly(cause),
					(cause) => report(name, cause),
				),
			)
		const phase = <A, E, R>(name: string, work: Effect.Effect<A, E, R>) =>
			check(
				`phase:${name}`,
				Effect.gen(function* () {
					const step = `phase:${name}`
					yield* sql`insert into openbot_data_upgrade_steps ${sql.insert({ version: dataVersion, step, complete: false, updated_at: yield* Clock.currentTimeMillis })} on conflict (version, step) do update set complete = false, updated_at = excluded.updated_at`
					const result = yield* work
					yield* sql`update openbot_data_upgrade_steps set complete = true, updated_at = ${yield* Clock.currentTimeMillis} where version = ${dataVersion} and step = ${step}`
					return result
				}),
			)
		const verify = <A, E, E2>(
			step: {
				readonly name: string
				readonly read: (
					cursor: string | null,
					limit: number,
				) => Effect.Effect<ReadonlyArray<A>, E>
				readonly key: (row: A) => string
				readonly check: (row: A) => Effect.Effect<void, E2>
			},
			limit = 100,
		) =>
			check(
				step.name,
				Effect.gen(function* () {
					let cursor: string | null = null
					let rows = 0
					while (true) {
						const batch = yield* step.read(cursor, limit)
						yield* Effect.forEach(batch, step.check, { discard: true })
						rows += batch.length
						const last = Arr.last(batch)
						if (last._tag === "Some") {
							const next = step.key(last.value)
							if (next === cursor)
								return yield* InvalidData.make({
									message: "A data check did not advance its cursor.",
								})
							cursor = next
						}
						if (batch.length < limit) break
					}
					yield* sql`insert into openbot_data_upgrade_steps ${sql.insert({ version: dataVersion, step: step.name, cursor, rows, complete: true, updated_at: yield* Clock.currentTimeMillis })} on conflict (version, step) do update set cursor = excluded.cursor, rows = excluded.rows, complete = true, updated_at = excluded.updated_at`
					return rows
				}),
			)
		/** Called only after this run has completed and checked every phase under the maintenance lock. */
		const ready = (phases: ReadonlyArray<string>) =>
			sql.withTransaction(
				Effect.gen(function* () {
					for (const name of phases) {
						const [phase] = yield* sql<{
							complete: boolean
						}>`select complete from openbot_data_upgrade_steps where version = ${dataVersion} and step = ${`phase:${name}`}`
						if (phase?.complete !== true) return yield* required("Blocked")
					}
					yield* sql`update openbot_data_upgrades set state = 'ready', checked_at = ${yield* Clock.currentTimeMillis}, updated_at = ${yield* Clock.currentTimeMillis} where version = ${dataVersion}`
				}),
			)
		return { batch, record, check, phase, verify, ready }
	})

export const make = makeFor(version)
