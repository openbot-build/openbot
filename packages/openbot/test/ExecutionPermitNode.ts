import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Execution } from "@openbot-build/domain"
import { Array as Arr, Config, Effect, Layer, Schedule } from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Permits from "../src/execution/Permits.ts"
import * as Recovery from "../src/execution/Recovery.ts"
import * as Fixture from "./ExecutionPermitFixture.ts"

/** A process with its own permit service and scope. The parent sets each fence. */
const main = Effect.gen(function* () {
	const runner = yield* Config.Int("TEST_RUNNER_ID")
	const namespace = yield* Config.String("TEST_NAMESPACE")
	const id = Execution.Id.make(yield* Config.String("TEST_EXECUTION_ID"))
	const generation = yield* Config.Int("TEST_GENERATION")
	const duration = yield* Config.Int("TEST_DURATION")
	const batch = yield* Config.Int("TEST_BATCH")
	const limit = yield* Config.Int("TEST_LIMIT")
	const pool = Fixture.pool(yield* Config.String("TEST_POOL"))
	const fence = { namespace, id, generation }
	const sql = yield* PgClient.PgClient
	const permits = yield* Permits.make
	const recovery = yield* Recovery.make
	yield* sql`insert into permit_test_nodes (runner) values (${runner})`
	yield* sql<{
		readonly go: boolean
	}>`select go from permit_test_nodes where runner = ${runner}`.pipe(
		Effect.repeat({
			schedule: Schedule.spaced("20 millis"),
			until: (rows) => rows[0]?.go === true,
		}),
	)
	yield* Effect.forEach(
		Arr.range(0, batch - 1),
		Effect.fn(function* (slot) {
			yield* sql`insert into permit_test_work (runner, slot) values (${runner}, ${slot})`
			const result = yield* permits
				.use(
					fence,
					pool,
					{
						limit:
							sql`update permit_test_work set waiting = true where runner = ${runner} and slot = ${slot}`.pipe(
								Effect.as(limit),
							),
						duration,
					},
					(permit) =>
						Effect.scoped(
							Effect.gen(function* () {
								// Test the send guard again as the old scope closes after a pause.
								yield* Effect.addFinalizer(() =>
									recovery.storage(id, permits.check(permit)).pipe(
										Effect.match({
											onFailure: (error) => error._tag,
											onSuccess: () => "allowed",
										}),
										Effect.flatMap(
											(check) =>
												sql`update permit_test_work set last_check = ${check}
											where runner = ${runner} and slot = ${slot}`,
										),
										Effect.orDie,
									),
								)
								yield* permits.check(permit)
								yield* sql`update permit_test_work set entered = true, permit_id = ${permit.id},
									deadline = ${permit.deadline}, admitted_at = extract(epoch from clock_timestamp()) * 1000
									where runner = ${runner} and slot = ${slot}`
								if (batch > 1) {
									// This count measures work in both processes, outside admission's lock.
									yield* Effect.acquireRelease(
										sql`update permit_test_counts set active = active + 1, peak = greatest(peak, active + 1)`,
										() =>
											sql`update permit_test_counts set active = active - 1`.pipe(
												Effect.orDie,
											),
									)
									yield* Effect.sleep("50 millis")
								} else {
									yield* sql<{
										readonly released: boolean
									}>`select released from permit_test_work
										where runner = ${runner} and slot = ${slot}`.pipe(
										Effect.repeat({
											schedule: Schedule.spaced("20 millis"),
											until: (rows) => rows[0]?.released === true,
										}),
									)
								}
								yield* permits.check(permit)
							}),
						),
				)
				.pipe(
					Effect.onExit(() =>
						sql`update permit_test_work set closed = true where runner = ${runner} and slot = ${slot}`.pipe(
							Effect.orDie,
						),
					),
					Effect.match({
						onFailure: (error) => error._tag,
						onSuccess: () => "done",
					}),
				)
			yield* sql`update permit_test_work set result = ${result} where runner = ${runner} and slot = ${slot}`
		}),
		{ concurrency: "unbounded", discard: true },
	)
})

const services = Fixture.services.pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(Config.Redacted("TEST_DATABASE_URL"), (databaseUrl) =>
				DatabasePostgres.layer({ databaseUrl }),
			),
		),
	),
	Layer.provideMerge(NodeServices.layer),
)

main.pipe(Effect.provide(services), Effect.scoped, NodeRuntime.runMain)
