import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
	String as Str,
} from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Admission from "../src/execution/Admission.ts"
import * as Engine from "../src/execution/Engine.ts"
import * as RunScope from "../src/execution/RunScope.ts"
import { WorkflowEngine } from "effect/workflow"
import * as Permits from "../src/execution/Permits.ts"
import * as Store from "../src/execution/Store.ts"
import * as PostgresTest from "./PostgresTest.ts"
import * as Fixture from "./ExecutionPermitFixture.ts"

const { actor, pool, start } = Fixture
const database = Layer.effectDiscard(DatabasePostgres.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = Fixture.services.pipe(
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect(
		"separate permit services share one limit and release every place",
		() =>
			Effect.gen(function* () {
				const first = yield* Permits.make
				const second = yield* Permits.make
				const active = yield* Ref.make(0)
				const peak = yield* Ref.make(0)
				const fences = yield* Effect.forEach(Arr.range(0, 15), (n) =>
					start("permit-concurrent-" + n),
				)
				yield* Effect.forEach(
					Arr.flatMap(fences, (fence) => [fence, fence]),
					(fence, n) =>
						(n % 2 === 0 ? first : second).use(
							fence,
							pool("concurrent"),
							{ limit: Effect.succeed(2), duration: "10 seconds" },
							(permit) =>
								Effect.gen(function* () {
									yield* first.check(permit)
									const count = yield* Ref.updateAndGet(
										active,
										(value) => value + 1,
									)
									yield* Ref.update(peak, (value) => Math.max(value, count))
									yield* Effect.sleep("10 millis")
									yield* Ref.update(active, (value) => value - 1)
								}),
						),
					{ concurrency: "unbounded" },
				)
				assert.equal(yield* Ref.get(peak), 2)
				assert.equal(yield* Ref.get(active), 0)
				const sql = yield* PgClient.PgClient
				assert.equal(
					(yield* sql`select id from openbot_execution_permits`).length,
					0,
				)
				const store = yield* Store.Store
				for (const fence of fences)
					assert.isTrue(
						Arr.some(
							yield* store.events(fence, 0),
							(event) =>
								event.body._tag === "Wake" &&
								Str.startsWith("permit-released:")(event.body.key),
						),
					)
			}),
	)
	it.effect(
		"cancelling a queued execution does not take or release another place",
		() =>
			Effect.gen(function* () {
				const permits = yield* Permits.make
				const store = yield* Store.Store
				const held = yield* Deferred.make<void>()
				const open = yield* Deferred.make<void>()
				const owner = yield* start("permit-cancel-owner")
				const holder = yield* permits
					.use(
						owner,
						pool("cancel"),
						{ limit: Effect.succeed(1), duration: "10 seconds" },
						() =>
							Deferred.succeed(held, undefined).pipe(
								Effect.andThen(Deferred.await(open)),
							),
					)
					.pipe(Effect.forkChild)
				yield* Deferred.await(held)
				const queued = yield* Deferred.make<void>()
				const waiter = yield* start("permit-cancel-waiter")
				const waiting = yield* permits
					.use(
						waiter,
						pool("cancel"),
						{
							limit: Deferred.succeed(queued, undefined).pipe(Effect.as(1)),
							duration: "10 seconds",
						},
						() => Effect.die("Cancelled work got a place."),
					)
					.pipe(Effect.flip, Effect.forkChild)
				yield* Deferred.await(queued)
				yield* store.cancel(waiter, Execution.CommandKey.make("stop"), actor)
				assert.ok(Schema.is(Execution.Conflict)(yield* Fiber.join(waiting)))
				const sql = yield* PgClient.PgClient
				assert.equal(
					(yield* sql`select id from openbot_execution_permits where execution_id = ${owner.id}`)
						.length,
					1,
				)
				assert.equal(
					(yield* sql`select id from openbot_execution_permits where execution_id = ${waiter.id}`)
						.length,
					0,
				)
				yield* Deferred.succeed(open, undefined)
				yield* Fiber.join(holder)
				assert.equal(
					yield* permits.use(
						yield* start("permit-after-cancel"),
						pool("cancel"),
						{ limit: Effect.succeed(1), duration: "10 seconds" },
						() => Effect.succeed("open"),
					),
					"open",
				)
			}),
	)
	it.effect(
		"takeover keeps an old place until release and rejects its old send check",
		() =>
			Effect.gen(function* () {
				const first = yield* Permits.make
				const second = yield* Permits.make
				const store = yield* Store.Store
				const entered = yield* Deferred.make<Permits.Permit>()
				const oldDone = yield* Deferred.make<void>()
				const old = yield* start("permit-takeover")
				const holder = yield* first
					.use(
						old,
						pool("takeover"),
						{ limit: Effect.succeed(1), duration: "10 seconds" },
						(permit) =>
							Deferred.succeed(entered, permit).pipe(
								Effect.andThen(Deferred.await(oldDone)),
							),
					)
					.pipe(Effect.forkChild)
				const oldPermit = yield* Deferred.await(entered)
				const current = yield* store.takeOver(old)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* first.check(oldPermit).pipe(Effect.flip),
					),
				)
				const queued = yield* Deferred.make<void>()
				const newEntered = yield* Deferred.make<void>()
				const newDone = yield* Deferred.make<void>()
				const next = yield* second
					.use(
						current,
						pool("takeover"),
						{
							limit: Deferred.succeed(queued, undefined).pipe(Effect.as(1)),
							duration: "10 seconds",
						},
						() =>
							Deferred.succeed(newEntered, undefined).pipe(
								Effect.andThen(Deferred.await(newDone)),
							),
					)
					.pipe(Effect.forkChild)
				yield* Deferred.await(queued)
				assert.isTrue(Option.isNone(yield* Deferred.poll(newEntered)))
				yield* Deferred.succeed(oldDone, undefined)
				yield* Fiber.join(holder)
				yield* Deferred.await(newEntered)
				const sql = yield* PgClient.PgClient
				const rows = yield* sql<{
					readonly generation: number
				}>`select generation from openbot_execution_permits where execution_id = ${old.id}`
				assert.deepEqual(rows, [{ generation: current.generation }])
				yield* Deferred.succeed(newDone, undefined)
				yield* Fiber.join(next)
			}),
	)
	it.effect(
		"a saved deadline permits recovery and a late release cannot delete the new place",
		() =>
			Effect.gen(function* () {
				const permits = yield* Permits.make
				const store = yield* Store.Store
				const entered = yield* Deferred.make<void>()
				const closing = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const old = yield* start("permit-deadline")
				const holder = yield* permits
					.use(
						old,
						pool("deadline"),
						{ limit: Effect.succeed(1), duration: "1 second" },
						() =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(
									Deferred.succeed(closing, undefined).pipe(
										Effect.andThen(Deferred.await(release)),
									),
								),
							),
					)
					.pipe(Effect.result, Effect.forkChild)
				yield* Deferred.await(entered)
				const current = yield* store.takeOver(old)
				const nextEntered = yield* Deferred.make<void>()
				const nextDone = yield* Deferred.make<void>()
				const next = yield* permits
					.use(
						current,
						pool("deadline"),
						{ limit: Effect.succeed(1), duration: "10 seconds" },
						() =>
							Deferred.succeed(nextEntered, undefined).pipe(
								Effect.andThen(Deferred.await(nextDone)),
							),
					)
					.pipe(Effect.forkChild)
				yield* Deferred.await(closing)
				yield* Deferred.await(nextEntered)
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(holder)
				const sql = yield* PgClient.PgClient
				assert.equal(
					(yield* sql`select id from openbot_execution_permits where execution_id = ${old.id} and generation = ${current.generation}`)
						.length,
					1,
				)
				yield* Deferred.succeed(nextDone, undefined)
				yield* Fiber.join(next)
			}),
	)
	it.effect(
		"a paused phase releases its permit before it waits for the owner",
		() =>
			Effect.gen(function* () {
				const permits = yield* Permits.make
				const store = yield* Store.Store
				const owner = yield* start("permit-phase-owner")
				const child = yield* start("permit-phase-child")
				const other = yield* start("permit-phase-other")
				const paused = yield* Deferred.make<void>()
				const first = yield* Ref.make(true)
				const workflow = Engine.define("permit-phase")
				const handler = workflow.toLayer(() =>
					Effect.gen(function* () {
						const phases = yield* RunScope.RunScope
						const result = yield* phases.run(
							child,
							"model",
							permits.use(
								child,
								pool("phase"),
								{ limit: Effect.succeed(1), duration: "10 seconds" },
								() =>
									Effect.gen(function* () {
										if (yield* Ref.getAndSet(first, false)) {
											const before = yield* store.get(owner)
											yield* Deferred.succeed(paused, undefined)
											return yield* Admission.stop(
												Admission.Paused.make({
													...owner,
													afterSequence: before.sequence,
												}),
											)
										}
									}),
							),
						)
						assert.equal(result._tag, "Done")
					}).pipe(Effect.orDie),
				)
				yield* Effect.gen(function* () {
					const running = yield* workflow.execute(child).pipe(Effect.forkScoped)
					yield* Deferred.await(paused)
					assert.equal(
						yield* permits.use(
							other,
							pool("phase"),
							{ limit: Effect.succeed(1), duration: "10 seconds" },
							() => Effect.succeed("open"),
						),
						"open",
					)
					yield* store.wake(owner, "resume")
					yield* Fiber.join(running)
				}).pipe(
					Effect.provide(
						handler.pipe(
							Layer.provideMerge(RunScope.layer),
							Layer.provideMerge(WorkflowEngine.layerMemory),
						),
					),
				)
			}),
	)
})
