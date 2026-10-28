import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Clock,
	Effect,
	Exit,
	Layer,
	Option,
	Redacted,
	Ref,
	String as Str,
} from "effect"
import { WorkflowEngine } from "effect/workflow"
import { Billing } from "../src/billing/Billing.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Records from "../src/errors/Records.ts"
import * as Calls from "../src/execution/Calls.ts"
import * as Engine from "../src/execution/Engine.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as Program from "../src/execution/Program.ts"
import * as Runner from "../src/execution/Runner.ts"
import * as RunScope from "../src/execution/RunScope.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as PostgresTest from "./PostgresTest.ts"

const database = Layer.effectDiscard(Database.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				Database.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const registry = Layer.mock(Engine.Registry, {
	get: () =>
		Effect.succeedSome({
			start: () => Effect.void,
			cancel: () => Effect.void,
			signal: () => Effect.void,
			authorize: () => Effect.void,
		}),
})
const services = Layer.mergeAll(Calls.layer, Runner.layer, RunScope.layer).pipe(
	Layer.provideMerge(Observation.layer),
	Layer.provideMerge(Layer.mergeAll(Store.layer, Records.layer, registry)),
	Layer.provide(
		Layer.mock(Billing, { releaseExecution: () => Effect.succeed(true) }),
	),
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const workflow = Engine.define("test-program")
const actor = { kind: "member", organizationId: "org", userId: "user" } as const
const start = Effect.fn(function* (namespace: string) {
	const store = yield* Store.Store
	const receipt = yield* store.submit(
		namespace,
		Execution.CommandKey.make("start"),
		{
			workflow: workflow._tag,
			resource: { kind: "Chat", id: namespace },
			identity: { owner: actor, actor },
			input: null,
		},
	)
	return { namespace, id: receipt.executionId }
})
const execute = <E, R>(key: Store.Key, work: Effect.Effect<void, E, R>) =>
	workflow
		.execute(key)
		.pipe(
			Effect.provide(
				workflow
					.toLayer(() => work.pipe(Effect.orDie))
					.pipe(Layer.provideMerge(WorkflowEngine.layerMemory)),
			),
		)

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect(
		"a phase closes before its result and has no next step after its end",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const run = yield* Program.phased
				const key = yield* start("program-close")
				const steps = yield* Ref.make(0)
				const events = yield* Ref.make<ReadonlyArray<string>>([])
				yield* execute(
					key,
					run(key, {
						next: ({ fence }) =>
							Ref.update(steps, (count) => count + 1).pipe(
								Effect.as({
									_tag: "Phase" as const,
									name: "saved-step",
									work: Effect.acquireRelease(Effect.void, () =>
										Ref.update(events, Arr.append("closed")),
									),
									options: undefined,
									after: Ref.update(events, Arr.append("result")).pipe(
										Effect.andThen(
											store.commit(fence, { status: "completed" }, Effect.void),
										),
									),
								}),
							),
						end: () => Effect.die("The phase must complete."),
					}),
				)
				assert.deepEqual(yield* Ref.get(events), ["closed", "result"])
				assert.equal(yield* Ref.get(steps), 1)
				assert.equal((yield* store.get(key)).status, "completed")
			}),
	)
	it.effect("a saved cancel ends before any next step", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const run = yield* Program.phased
			const key = yield* start("program-cancel")
			yield* store.cancel(key, Execution.CommandKey.make("cancel"), actor)
			const steps = yield* Ref.make(0)
			yield* execute(
				key,
				run(key, {
					next: () =>
						Ref.update(steps, (count) => count + 1).pipe(
							Effect.andThen(Effect.die("A cancel must stop new work.")),
						),
					end: (fence, reason) =>
						reason._tag === "Cancel"
							? store
									.finishCancellation(fence, reason.epoch)
									.pipe(Effect.asVoid)
							: Effect.die("The saved end must be a cancel."),
				}),
			)
			assert.equal(yield* Ref.get(steps), 0)
			assert.equal((yield* store.get(key)).status, "cancelled")
		}),
	)
	it.effect("an expired phase skips its work and result", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const run = yield* Program.phased
			const key = yield* start("program-deadline")
			const deadline = (yield* Clock.currentTimeMillis) - 1
			const steps = yield* Ref.make(0)
			yield* execute(
				key,
				run(key, {
					next: ({ fence }) =>
						Effect.gen(function* () {
							if ((yield* Ref.getAndUpdate(steps, (count) => count + 1)) > 0) {
								yield* store.commit(
									fence,
									{ status: "interrupted" },
									Effect.void,
								)
								return { _tag: "Again" as const }
							}
							return {
								_tag: "Phase" as const,
								name: "attempt:0",
								work: Effect.die("An expired phase must not send."),
								options: { deadline },
								after: Effect.die("An expired phase has no result."),
							}
						}),
					end: () => Effect.die("The deadline has its own end."),
				}),
			)
			assert.equal(yield* Ref.get(steps), 2)
			assert.equal((yield* store.get(key)).status, "interrupted")
		}),
	)
	for (const at of ["work", "close"] as const)
		it.effect(`a failed ${at} keeps its saved error at the program end`, () =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const run = yield* Program.phased
				const key = yield* start(`program-failure-${at}`)
				const ended = yield* Ref.make<Option.Option<Execution.Failure>>(
					Option.none(),
				)
				yield* execute(
					key,
					run(key, {
						next: () =>
							Effect.succeed({
								_tag: "Phase" as const,
								name: "saved-step",
								work: Effect.gen(function* () {
									yield* Effect.acquireRelease(Effect.void, () =>
										at === "close"
											? Effect.die("The connection did not close.")
											: Effect.void,
									)
									if (at === "work")
										return yield* Effect.fail("The call failed.")
								}),
								options: undefined,
								after: Effect.die("A failed phase has no result."),
							}),
						end: (fence, reason) =>
							reason._tag === "Fail"
								? Ref.set(ended, Option.some(reason.failure)).pipe(
										Effect.andThen(
											store.commit(
												fence,
												{ status: "failed", failure: reason.failure },
												Effect.void,
											),
										),
									)
								: Effect.die("The saved end must be a failure."),
					}),
				)
				const failure = Option.getOrThrow(yield* Ref.get(ended))
				assert.equal((yield* store.get(key)).failure?.errorId, failure.errorId)
				assert.equal((yield* store.get(key)).status, "failed")
			}),
		)
	it.effect("an old owner cannot publish a result or choose new work", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const run = yield* Program.phased
			const key = yield* start("program-old-owner")
			const steps = yield* Ref.make(0)
			const result = yield* Ref.make(false)
			const exit = yield* Ref.make<
				Option.Option<Exit.Exit<void, Execution.Failure>>
			>(Option.none())
			yield* execute(
				key,
				run(key, {
					next: ({ fence }) =>
						Ref.update(steps, (count) => count + 1).pipe(
							Effect.as({
								_tag: "Phase" as const,
								name: "saved-step",
								work: store.takeOver(fence).pipe(Effect.asVoid),
								options: undefined,
								after: Ref.set(result, true),
							}),
						),
					end: () => Effect.die("The new owner keeps its work."),
				}).pipe(
					Effect.exit,
					Effect.flatMap((value) => Ref.set(exit, Option.some(value))),
				),
			)
			assert.isTrue(Exit.isFailure(Option.getOrThrow(yield* Ref.get(exit))))
			assert.isFalse(yield* Ref.get(result))
			assert.equal(yield* Ref.get(steps), 1)
			assert.equal((yield* store.get(key)).status, "running")
		}),
	)
	it.effect("a saved stop keeps the first phase error", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const calls = yield* Calls.Calls
			const records = yield* Records.Records
			const run = yield* Program.phased
			const key = yield* start("program-stop")
			const first = yield* store.takeOver(key)
			const call = yield* store.writeAttempt(first, "write", null)
			yield* calls.invoke(first, call, () => Effect.fail("The reply was lost."))
			yield* calls.recover(first, call.id)
			const failure = yield* records.record(
				Cause.fail("The phase failed."),
				"external",
				key.id,
			)
			yield* store.failPhase(first, failure)
			yield* store.decide(
				first,
				Execution.CommandKey.make("stop"),
				call.id,
				"stop",
				actor,
			)
			const stopped = yield* Ref.make<Option.Option<Execution.Failure>>(
				Option.none(),
			)
			yield* execute(
				key,
				run(key, {
					next: () => Effect.die("A stopped call must not send new work."),
					end: (fence, reason) =>
						reason._tag === "Stop"
							? Ref.set(stopped, reason.failure).pipe(
									Effect.andThen(
										store.commit(
											fence,
											{ status: "interrupted", failure },
											Effect.void,
										),
									),
								)
							: Effect.die("The saved end must be a stop."),
				}),
			)
			assert.equal(
				Option.getOrThrow(yield* Ref.get(stopped)).errorId,
				failure.errorId,
			)
			assert.equal((yield* store.get(key)).failure?.errorId, failure.errorId)
		}),
	)
	it.effect("a saved phase name reuses its work on the next step", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const run = yield* Program.phased
			const key = yield* start("program-saved-phase")
			const steps = yield* Ref.make(0)
			const sends = yield* Ref.make(0)
			const results = yield* Ref.make(0)
			yield* execute(
				key,
				run(key, {
					next: ({ fence }) =>
						Ref.update(steps, (count) => count + 1).pipe(
							Effect.as({
								_tag: "Phase" as const,
								name: "saved-step",
								work: Ref.update(sends, (count) => count + 1),
								options: undefined,
								after: Effect.gen(function* () {
									if (
										(yield* Ref.updateAndGet(results, (count) => count + 1)) ===
										2
									)
										yield* store.commit(
											fence,
											{ status: "completed" },
											Effect.void,
										)
								}),
							}),
						),
					end: () => Effect.die("The saved phase must complete."),
				}),
			)
			assert.equal(yield* Ref.get(steps), 2)
			assert.equal(yield* Ref.get(results), 2)
			assert.equal(yield* Ref.get(sends), 1)
		}),
	)
	it.effect("a simple program shares phase close and end rules", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const run = yield* Program.make
			const key = yield* start("program-simple")
			const closed = yield* Ref.make(false)
			yield* execute(
				key,
				run(key, (fence) =>
					Effect.gen(function* () {
						yield* Effect.acquireRelease(Effect.void, () =>
							Ref.set(closed, true),
						)
						yield* store.commit(fence, { status: "completed" }, Effect.void)
					}),
				),
			)
			assert.isTrue(yield* Ref.get(closed))
			assert.equal((yield* store.get(key)).status, "completed")
		}),
	)
})
