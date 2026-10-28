import { Execution } from "@openbot-build/domain"
import { and, eq, gt, lte } from "drizzle-orm"
import {
	Array as Arr,
	Crypto,
	Duration,
	Effect,
	Option,
	Schema,
	Stream,
} from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "../database/Database.ts"
import { executions } from "../database/ExecutionSchema.ts"
import { executionPermits } from "../database/PermitSchema.ts"
import { Observation } from "./Observation.ts"
import * as Recovery from "./Recovery.ts"
import { Store, storage, transactionFailures, type Fence } from "./Store.ts"

export interface Pool {
	readonly scope: string
	readonly resource: Execution.Resource
}
export interface Permit {
	readonly fence: Fence
	readonly id: string
	readonly deadline: number
}

/** Shared admission for bounded work. Execution scopes own release and recovery. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const observation = yield* Observation
	const crypto = yield* Crypto.Crypto
	const recovery = yield* Recovery.make
	// The database clock sets every deadline. Runner clocks need not agree.
	const now = sql<{
		readonly now: number
	}>`select floor(extract(epoch from clock_timestamp()) * 1000)::float8 as now`.pipe(
		Effect.flatMap((rows) =>
			Schema.decodeUnknownEffect(Schema.Finite)(rows[0]?.now),
		),
		storage,
	)
	const where = (permit: Pick<Permit, "fence" | "id">) =>
		and(
			eq(executionPermits.namespace, permit.fence.namespace),
			eq(executionPermits.executionId, permit.fence.id),
			eq(executionPermits.generation, permit.fence.generation),
			eq(executionPermits.id, permit.id),
		)
	const current = (fence: Fence) =>
		Effect.gen(function* () {
			yield* store.guard(fence)
			const state = yield* store.load(fence)
			if (state.record.status !== "running" || state.phaseFailed)
				return yield* Execution.Conflict.make({ id: fence.id })
			return state.record.sequence
		})
	/** A call checks again after waits, before it may send to the provider. */
	const check = (permit: Permit) =>
		Effect.gen(function* () {
			yield* current(permit.fence)
			const rows = yield* db
				.select({ deadline: executionPermits.deadline })
				.from(executionPermits)
				.where(where(permit))
			if (rows[0]?.deadline === undefined || rows[0].deadline <= (yield* now))
				return yield* Execution.Conflict.make({ id: permit.fence.id })
		}).pipe(sql.withTransaction, transactionFailures)
	const release = (permit: Permit) =>
		Effect.gen(function* () {
			// Match admission's lock order: the execution row, then its permit.
			// A late release may wake the new owner but cannot remove its place.
			yield* store.wake(permit.fence, "permit-released:" + permit.id)
			yield* db.delete(executionPermits).where(where(permit))
		}).pipe(sql.withTransaction, transactionFailures)

	const use = <A, E, R, LimitE>(
		fence: Fence,
		pool: Pool,
		options: {
			/** Read current settings in the admission transaction. No outside I/O. */
			readonly limit: Effect.Effect<number | undefined, LimitE>
			readonly duration: Duration.Input
		},
		work: (permit: Permit) => Effect.Effect<A, E, R>,
	) =>
		Effect.scoped(
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const id = yield* crypto.randomUUIDv7().pipe(storage)
					const duration = Duration.toMillis(
						Duration.fromInputUnsafe(options.duration),
					)
					if (!Number.isFinite(duration) || duration <= 0)
						return yield* Effect.die("A permit needs a finite work limit.")
					const poolKey = yield* Schema.encodeEffect(
						Schema.fromJsonString(Schema.Json),
					)({
						kind: "execution-permit",
						scope: pool.scope,
						resource: pool.resource,
					}).pipe(storage)
					const acquire = Effect.gen(function* () {
						yield* sql`select pg_advisory_xact_lock(hashtextextended(${poolKey}, 0))`
						const sequence = yield* current(fence)
						const time = yield* now
						const [saved] = yield* db
							.select()
							.from(executionPermits)
							.where(where({ fence, id }))
						if (saved !== undefined) {
							if (saved.deadline <= time)
								return yield* Execution.Conflict.make({ id: fence.id })
							return {
								_tag: "Acquired",
								permit: { fence, id, deadline: saved.deadline },
								remaining: saved.deadline - time,
							} as const
						}
						// Expiry ends admission only. It is not proof of a provider result.
						yield* db
							.delete(executionPermits)
							.where(
								and(
									eq(executionPermits.pool, poolKey),
									lte(executionPermits.deadline, time),
								),
							)
						const limit = yield* options.limit
						if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
							return yield* Effect.die(
								"A permit count must be a positive integer.",
							)
						// Keep old generations until release or deadline. Takeover alone cannot
						// prove that the old process has closed its model request.
						const occupied = yield* db
							.select({
								namespace: executionPermits.namespace,
								id: executions.id,
								sequence: executions.sequence,
								deadline: executionPermits.deadline,
							})
							.from(executionPermits)
							.innerJoin(
								executions,
								and(
									eq(executionPermits.namespace, executions.namespace),
									eq(executionPermits.executionId, executions.id),
								),
							)
							.where(
								and(
									eq(executionPermits.pool, poolKey),
									gt(executionPermits.deadline, time),
								),
							)
						if (limit !== undefined && occupied.length >= limit)
							return { _tag: "Waiting", occupied, sequence, time } as const
						const permit = { fence, id, deadline: time + duration }
						yield* db.insert(executionPermits).values({
							namespace: fence.namespace,
							executionId: fence.id,
							generation: fence.generation,
							id,
							pool: poolKey,
							deadline: permit.deadline,
						})
						return { _tag: "Acquired", permit, remaining: duration } as const
					}).pipe(sql.withTransaction, transactionFailures)
					while (true) {
						const result = yield* recovery.commit(fence.id, acquire)
						if (result._tag === "Acquired") {
							yield* Effect.addFinalizer(() =>
								recovery
									.storage(fence.id, release(result.permit))
									.pipe(Effect.orDie),
							)
							return yield* restore(
								work(result.permit).pipe(Effect.timeout(result.remaining)),
							)
						}
						const changed = (key: {
							readonly namespace: string
							readonly id: string
							readonly sequence: number
						}) =>
							observation
								.observe(
									{ namespace: key.namespace, id: Execution.Id.make(key.id) },
									key.sequence,
								)
								.pipe(
									Stream.runHead,
									Effect.flatMap((event) =>
										Option.isSome(event) ? Effect.void : Effect.never,
									),
								)
						// One SQL snapshot supplied each cursor with its occupied place. Release
						// and its wake commit together, so a change before subscription is kept.
						yield* restore(
							Effect.raceAll([
								...Arr.map(result.occupied, changed),
								changed({ ...fence, sequence: result.sequence }),
								Effect.sleep(
									Math.max(
										0,
										Math.min(
											...Arr.map(result.occupied, (entry) => entry.deadline),
										) - result.time,
									),
								),
							]),
						)
					}
				}),
			),
		)
	return { use, check }
})
