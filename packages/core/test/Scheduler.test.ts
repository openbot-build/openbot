// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { Deferred, Effect, Exit, Fiber, Option, Stream } from "effect"
import { Prompt } from "effect/ai"
import {
	Session,
	SessionRuntime,
	SessionStoreRepository,
	MemoryPersistence,
} from "@openbot-build/core"
import { SessionTest } from "./SessionTest.ts"
import { LanguageModelTest, textParts } from "./LanguageModelTest.ts"

test("steering stays in the current Turn and queued input starts a separate Turn with fresh settings", async () => {
	let requests: ReadonlyArray<Prompt.Prompt> = []
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const ready = yield* Deferred.make<void>(),
					gate = yield* Deferred.make<void>()
				const model = LanguageModelTest({
					streamText: ({ prompt }) => {
						requests = [...requests, prompt]
						return requests.length === 1
							? Stream.fromEffect(
									Deferred.succeed(ready, undefined).pipe(
										Effect.andThen(Deferred.await(gate)),
									),
								).pipe(
									Stream.flatMap(() => Stream.fromArray(textParts("first"))),
								)
							: Stream.fromArray(textParts("done"))
					},
				})
				yield* Effect.gen(function* () {
					const { runtime, runtimeStore, base } = yield* SessionTest()
					const executing = yield* Effect.forkChild(
						runtime.execute({ base, input: "initial" }),
					)
					yield* Deferred.await(ready)
					const running = yield* runtimeStore.read(base.session),
						turn = Session.currentTurn(running.session)!
					yield* runtime.steer({
						session: base.session,
						turn: turn.id,
						input: "steering instruction",
					})
					yield* runtime.enqueue({
						session: base.session,
						message: "ordinary queued input",
					})
					const queued = yield* runtimeStore.read(base.session)
					assert.equal(queued.session.head, running.session.head)
					assert.ok(queued.session.revision > running.session.revision)
					yield* runtimeStore.updateSettings({
						expected: queued.session,
						settings: { ...queued.session.settings, mode: "plan" },
					})
					yield* Deferred.succeed(gate, undefined)
					const done = yield* Fiber.join(executing)
					assert.equal(done.session.turns.length, 1)
					assert.equal(Session.currentTurn(done.session)!.steps, 2)
					assert.equal(
						Session.currentTurn(done.session)!.settings.mode,
						"default",
					)
					assert.match(JSON.stringify(requests[1]), /steering instruction/)
					assert.doesNotMatch(
						JSON.stringify(requests[1]),
						/ordinary queued input/,
					)
					const next = yield* runtime.runQueued(base.session)
					assert.ok(Option.isSome(next))
					assert.notEqual(next.value.turn, turn.id)
					const wait: Effect.Effect<void, Session.RuntimeError> =
						Effect.suspend(() =>
							runtime
								.status(base.session)
								.pipe(
									Effect.flatMap((view) =>
										Session.currentTurn(view.session)!.status._tag === "Running"
											? Effect.yieldNow.pipe(Effect.andThen(wait))
											: Effect.void,
									),
								),
						)
					yield* wait
					const latest = yield* runtimeStore.read(base.session)
					assert.equal(latest.session.turns.length, 2)
					assert.equal(
						Session.currentTurn(latest.session)!.settings.mode,
						"plan",
					)
					assert.match(JSON.stringify(requests.at(-1)), /ordinary queued input/)
					assert.ok(
						Exit.isFailure(
							yield* Effect.exit(
								runtime.steer({
									session: base.session,
									turn: turn.id,
									input: "late",
								}),
							),
						),
					)
					assert.ok(
						Exit.isFailure(
							yield* Effect.exit(
								runtime.interrupt({ session: base.session, turn: turn.id }),
							),
						),
					)
					assert.deepEqual(
						(yield* runtimeStore.read(base.session)).session.turns,
						latest.session.turns,
					)
				}).pipe(Effect.provide(model))
			}),
		),
	)
})

test("read and Resume do not run saved queues or restart an interrupted Turn", async () => {
	let requests = 0
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const ready = yield* Deferred.make<void>()
				const model = LanguageModelTest({
					streamText: () => {
						requests++
						return Stream.fromEffect(
							Deferred.succeed(ready, undefined).pipe(
								Effect.andThen(Effect.never),
							),
						).pipe(Stream.flatMap(() => Stream.empty))
					},
				})
				yield* Effect.gen(function* () {
					const { runtime, runtimeStore, base, definition } =
						yield* SessionTest()
					const receipt = yield* runtime.start({ base, input: "running" })
					yield* Deferred.await(ready)
					yield* runtime.enqueue({
						session: base.session,
						message: "stay queued",
					})
					const record = yield* runtimeStore.export(base.session)
					const restoredStore = yield* SessionStoreRepository.make({
						definition,
						persistence: yield* MemoryPersistence.make,
					})
					yield* restoredStore.import({ record, expected: null })
					const restored = yield* SessionRuntime.make({
						store: restoredStore,
						agent: {},
					})
					assert.equal(
						Session.currentTurn(
							(yield* restoredStore.read(base.session)).session,
						)!.status._tag,
						"Running",
					)
					const resumed = yield* restored.resume(base.session)
					assert.equal(resumed.session.id, base.session)
					assert.equal(Session.currentTurn(resumed.session)!.id, receipt.turn)
					assert.equal(
						Session.currentTurn(resumed.session)!.status._tag,
						"Interrupted",
					)
					assert.equal(resumed.session.pending.length, 1)
					assert.equal(
						(yield* restored.resume(base.session)).session.revision,
						resumed.session.revision,
					)
					assert.equal(requests, 1)
					yield* runtime.interrupt({
						session: base.session,
						turn: receipt.turn,
					})
				}).pipe(Effect.provide(model))
			}),
		),
	)
})

test("two Sessions run independently, and another start cannot replace an active Turn", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>(),
					release = yield* Deferred.make<void>()
				const model = LanguageModelTest({
					streamText: () =>
						Stream.fromEffect(
							Effect.sync(() => {}).pipe(
								Effect.andThen(Deferred.succeed(entered, undefined)),
								Effect.andThen(Deferred.await(release)),
							),
						).pipe(Stream.flatMap(() => Stream.fromArray(textParts("done")))),
				})
				yield* Effect.gen(function* () {
					const { runtime, runtimeStore, base } = yield* SessionTest()
					const other = yield* runtimeStore.create({ metadata: {} })
					const a = yield* runtime.start({ base, input: "one" })
					yield* Deferred.await(entered)
					const b = yield* runtime.start({
						base: {
							session: other.session.id,
							revision: other.session.revision,
						},
						input: "two",
					})
					assert.notEqual(a.turn, b.turn)
					const current = yield* runtimeStore.read(base.session)
					assert.ok(
						Exit.isFailure(
							yield* Effect.exit(
								runtime.start({
									base: {
										session: base.session,
										revision: current.session.revision,
									},
									input: "collision",
								}),
							),
						),
					)
					yield* runtime.interrupt({ session: base.session, turn: a.turn })
					assert.equal(
						Session.currentTurn(
							(yield* runtimeStore.read(other.session.id)).session,
						)!.status._tag,
						"Running",
					)
					yield* Deferred.succeed(release, undefined)
				}).pipe(Effect.provide(model))
			}),
		),
	)
})
