// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import {
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Match,
	Option,
	Schema,
	Stream,
} from "effect"
import { Prompt, Response, Tool, Toolkit } from "effect/ai"
import {
	TimelineState,
	Plugin,
	Session,
	SessionRuntime,
	SessionStoreMemory,
	Turn,
} from "@openbot-build/core"
import { SessionTest } from "./SessionTest.ts"
import {
	LanguageModelTest,
	finish,
	textParts,
	lastText,
} from "./LanguageModelTest.ts"
const Echo = Tool.make("Echo", {
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.String,
})
const tools = Toolkit.make(Echo)
const call = () =>
	Response.makePart("tool-call", {
		id: "echo-1",
		name: "Echo",
		params: { text: "value" },
		providerExecuted: false,
	})
const handlers = tools.toLayer({
	Echo: ({ text }) => Effect.succeed("tool:" + text),
})
const hasResult = (prompt: Prompt.Prompt) =>
	prompt.content.some((message) =>
		Match.value(message).pipe(
			Match.when({ role: "tool" }, (message) =>
				message.content.some((part) => part.type === "tool-result"),
			),
			Match.orElse(() => false),
		),
	)

test("a multi-step tool loop has one Turn and stable Item identities", async () => {
	let requests = 0
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, base } = yield* SessionTest({
					toolkit: tools,
				})
				const events = yield* Stream.runCollect(
					runtime.stream({ base, input: "echo" }),
				)
				const started = events.filter((event) => event._tag === "TurnStarted"),
					steps = events.filter((event) => event._tag === "ModelStepStarted")
				assert.equal(started.length, 1)
				assert.equal(steps.length, 2)
				assert.ok(steps.every((event) => event.turn === started[0]!.turn))
				const view = yield* runtimeStore.read(base.session),
					turn = Session.currentTurn(view.session)!
				assert.equal(turn.id, started[0]!.turn)
				assert.equal(turn.status._tag, "Completed")
				assert.equal(turn.steps, 2)
				assert.equal(turn.end, view.session.head)
				assert.deepEqual(
					TimelineState.fullHistory(view.state.value).content.map(
						(message) => message.role,
					),
					["user", "assistant", "tool", "assistant"],
				)
				const results = events.filter((event) => event._tag === "ResponsePart")
				assert.ok(
					results.every((event) =>
						view.state.value.conversation.history.some(
							(item) => item.id === event.item,
						),
					),
				)
				assert.equal(requests, 2)
			}),
		).pipe(
			Effect.provide(
				Layer.merge(
					handlers,
					LanguageModelTest({
						streamText: ({ prompt }) => {
							requests++
							return hasResult(prompt)
								? Stream.fromArray(textParts("answer"))
								: Stream.make(call(), finish("tool-calls"))
						},
					}),
				),
			),
		),
	)
})

test("Session settings change revision without changing the Timeline or a completed Turn", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, base } = yield* SessionTest()
				const first = yield* runtime.execute({ base, input: "first" }),
					record = Session.currentTurn(first.session)!
				const changed = yield* runtimeStore.updateSettings({
					expected: first.session,
					settings: { ...first.session.settings, mode: "plan" },
				})
				assert.equal(changed.session.head, first.session.head)
				assert.ok(changed.session.revision > first.session.revision)
				assert.deepEqual(Session.currentTurn(changed.session), record)
				const stale = yield* Effect.exit(
					runtime.execute({
						base: { session: base.session, revision: first.session.revision },
						input: "stale",
					}),
				)
				assert.ok(Exit.isFailure(stale))
				const next = yield* runtime.execute({
					base: { session: base.session, revision: changed.session.revision },
					input: "next",
				})
				assert.equal(Session.currentTurn(next.session)!.settings.mode, "plan")
				assert.notEqual(Session.currentTurn(next.session)!.id, record.id)
				assert.equal(next.session.turns[0]!.settings.mode, "default")
			}),
		).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.fromArray(textParts("done")),
				}),
			),
		),
	)
})

test("Fork inherits a selected completed Timeline version and starts with separate coordination state", async () => {
	let requests: ReadonlyArray<Prompt.Prompt> = []
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, base } = yield* SessionTest()
				const first = yield* runtime.execute({ base, input: "first" })
				const second = yield* runtime.execute({
					base: { session: base.session, revision: first.session.revision },
					input: "future",
				})
				yield* runtime.enqueue({ session: base.session, message: "queued" })
				const source = yield* runtimeStore.read(base.session)
				yield* runtimeStore.modifyEffect({
					session: base.session,
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({
								session: { business: { goal: { objective: "source" } } },
							}),
						] as const),
				})
				const fork = yield* runtimeStore.fork({
					source: base.session,
					version: first.session.head,
					metadata: {},
					settings: { mode: "plan" },
				})
				assert.equal(fork.session.head, first.session.head)
				assert.deepEqual(fork.session.pending, [])
				assert.deepEqual(fork.session.business, {})
				assert.deepEqual(fork.session.turns, [])
				assert.equal(fork.session.inheritedTurns.length, 1)
				assert.equal(fork.session.forkedFrom!.session, base.session)
				assert.equal(requests.length, 2)
				const continued = yield* runtime.execute({
					base: { session: fork.session.id, revision: fork.session.revision },
					input: "fork",
				})
				assert.doesNotMatch(
					JSON.stringify(requests.at(-1)),
					/future|queued|source/,
				)
				assert.equal(
					Session.currentTurn(continued.session)!.settings.mode,
					"plan",
				)
				assert.equal(
					(yield* runtimeStore.read(base.session)).session.head,
					source.session.head,
				)
				assert.equal(second.session.turns.length, 2)
			}),
		).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: ({ prompt }) => {
						requests = [...requests, prompt]
						return Stream.fromArray(textParts("answer:" + lastText(prompt)))
					},
				}),
			),
		),
	)
})

test("Fork during a running Turn picks the last coherent point and does not stop its source", async () => {
	const ready = Deferred.make<void>(),
		release = Deferred.make<void>()
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const entered = yield* ready,
					gate = yield* release
				const model = LanguageModelTest({
					streamText: () =>
						Stream.fromEffect(
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(gate)),
							),
						).pipe(Stream.flatMap(() => Stream.fromArray(textParts("done")))),
				})
				yield* Effect.gen(function* () {
					const {
						runtime,
						runtimeStore,
						base,
						view: root,
					} = yield* SessionTest()
					const running = yield* Effect.forkChild(
						runtime.execute({ base, input: "running" }),
					)
					yield* Deferred.await(entered)
					const current = yield* runtimeStore.read(base.session),
						turn = Session.currentTurn(current.session)!
					const illegal = yield* Effect.exit(
						runtimeStore.fork({
							source: base.session,
							version: current.session.head,
						}),
					)
					assert.ok(Exit.isFailure(illegal))
					const fork = yield* runtimeStore.fork({ source: base.session })
					assert.equal(fork.session.head, root.session.head)
					assert.equal(
						Session.currentTurn(
							(yield* runtimeStore.read(base.session)).session,
						)!.status._tag,
						"Running",
					)
					assert.ok(
						Exit.isFailure(
							yield* Effect.exit(
								runtime.interrupt({
									session: base.session,
									turn: Turn.Id.make("old"),
								}),
							),
						),
					)
					yield* runtime.interrupt({ session: base.session, turn: turn.id })
					yield* Fiber.await(running)
					assert.equal(
						Session.currentTurn(
							(yield* runtimeStore.read(base.session)).session,
						)!.status._tag,
						"Interrupted",
					)
				}).pipe(Effect.provide(model))
			}),
		),
	)
})

const approvalIds = (view: Session.View<{}>) =>
	Session.waits(view).map((wait) => wait.approvalId)
const settled = (
	read: Effect.Effect<Session.View<{}>, Session.RuntimeError>,
): Effect.Effect<Session.View<{}>, Session.RuntimeError> =>
	Effect.gen(function* () {
		const view = yield* read
		if (Session.status(view.session)._tag === "Running") {
			yield* Effect.yieldNow
			return yield* settled(read)
		}
		return view
	})

test("an approval survives a restart and resumes the Turn once", async () => {
	let calls = 0
	const approved = Toolkit.make(Echo.setNeedsApproval(true))
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, base, definition } = yield* SessionTest({
					toolkit: approved,
				})
				const waiting = yield* runtime.execute({ base, input: "approve" }),
					turn = Session.currentTurn(waiting.session)!
				assert.equal(turn.status._tag, "Waiting")
				assert.equal(calls, 0)
				const [request] = approvalIds(waiting)
				assert.ok(request !== undefined)
				assert.equal(
					(yield* runtime.resume(base.session)).session.revision,
					waiting.session.revision,
				)
				const restoredStore = yield* SessionStoreMemory.make(definition)
				const restored = yield* restoredStore.import({
					record: yield* runtimeStore.export(base.session),
					expected: null,
				})
				const restoredRuntime = yield* SessionRuntime.make({
					store: restoredStore,
					agent: { toolkit: approved },
				})
				assert.equal(
					Session.status((yield* restoredRuntime.resume(base.session)).session)
						._tag,
					"Waiting",
				)
				yield* restoredRuntime.resolve({
					session: base.session,
					turn: turn.id,
					approval: request,
					outcome: Session.Outcome.Approved(),
					expectedRevision: restored.session.revision,
				})
				const completed = yield* settled(restoredStore.read(base.session))
				assert.equal(Session.currentTurn(completed.session)!.id, turn.id)
				assert.equal(
					Session.currentTurn(completed.session)!.status._tag,
					"Completed",
				)
				assert.equal(calls, 1)
				assert.ok(
					Exit.isFailure(
						yield* Effect.exit(
							restoredRuntime.resolve({
								session: base.session,
								turn: turn.id,
								approval: request,
								outcome: Session.Outcome.Approved(),
								expectedRevision: completed.session.revision,
							}),
						),
					),
				)
			}),
		).pipe(
			Effect.provide(
				Layer.merge(
					LanguageModelTest({
						streamText: ({ prompt }) =>
							hasResult(prompt)
								? Stream.fromArray(textParts("done"))
								: Stream.make(call(), finish("tool-calls")),
					}),
					approved.toLayer({
						Echo: () =>
							Effect.sync(() => {
								calls++
								return "done"
							}),
					}),
				),
			),
		),
	)
})

test("a result from the host answers a waiting call without its handler", async () => {
	let calls = 0
	let seen: unknown = undefined
	const approved = Toolkit.make(Echo.setNeedsApproval(true))
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, base } = yield* SessionTest({
					toolkit: approved,
				})
				const waiting = yield* runtime.execute({ base, input: "delegate" }),
					turn = Session.currentTurn(waiting.session)!
				yield* runtime.resolve({
					session: base.session,
					turn: turn.id,
					approval: approvalIds(waiting)[0]!,
					outcome: Session.Outcome.Result({
						result: "from the host",
						isFailure: false,
					}),
					expectedRevision: waiting.session.revision,
				})
				const completed = yield* settled(runtimeStore.read(base.session))
				assert.equal(Session.status(completed.session)._tag, "Completed")
				assert.equal(calls, 0)
				assert.equal(seen, "from the host")
			}),
		).pipe(
			Effect.provide(
				Layer.merge(
					LanguageModelTest({
						streamText: ({ prompt }) => {
							const result = prompt.content
								.flatMap((message) =>
									message.role === "tool" ? message.content : [],
								)
								.find((part) => part.type === "tool-result")
							if (result === undefined)
								return Stream.make(call(), finish("tool-calls"))
							seen = result.result
							return Stream.fromArray(textParts("done"))
						},
					}),
					approved.toLayer({
						Echo: () =>
							Effect.sync(() => {
								calls++
								return "handler"
							}),
					}),
				),
			),
		),
	)
})

test("a Turn with two waits runs again only after both have answers", async () => {
	let steps = 0
	const approved = Toolkit.make(Echo.setNeedsApproval(true))
	const two = (id: string) =>
		Response.makePart("tool-call", {
			id,
			name: "Echo",
			params: { text: id },
			providerExecuted: false,
		})
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, base } = yield* SessionTest({
					toolkit: approved,
				})
				const waiting = yield* runtime.execute({ base, input: "two" }),
					turn = Session.currentTurn(waiting.session)!
				const [first, second] = approvalIds(waiting)
				assert.ok(first !== undefined && second !== undefined)
				yield* runtime.resolve({
					session: base.session,
					turn: turn.id,
					approval: first,
					outcome: Session.Outcome.Result({ result: "one", isFailure: false }),
					expectedRevision: waiting.session.revision,
				})
				const half = yield* runtimeStore.read(base.session)
				assert.equal(Session.status(half.session)._tag, "Waiting")
				assert.deepEqual(approvalIds(half), [second])
				assert.equal(steps, 1)
				yield* runtime.resolve({
					session: base.session,
					turn: turn.id,
					approval: second,
					outcome: Session.Outcome.Denied({ reason: "not now" }),
					expectedRevision: half.session.revision,
				})
				const completed = yield* settled(runtimeStore.read(base.session))
				assert.equal(Session.status(completed.session)._tag, "Completed")
				assert.ok(steps > 1)
			}),
		).pipe(
			Effect.provide(
				Layer.merge(
					LanguageModelTest({
						streamText: () => {
							steps++
							return steps === 1
								? Stream.make(
										two("echo-1"),
										two("echo-2"),
										finish("tool-calls"),
									)
								: Stream.fromArray(textParts("done"))
						},
					}),
					approved.toLayer({ Echo: () => Effect.succeed("handler") }),
				),
			),
		),
	)
})

test(
	"interrupt keeps an external receipt while another tool is still running",
	{ timeout: 5000 },
	async () => {
		const Slow = Tool.make("Slow", {
			parameters: Schema.Struct({}),
			success: Schema.String,
		})
		const concurrent = Toolkit.make(Echo, Slow)
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const received = yield* Deferred.make<void>()
					const { runtime, runtimeStore, base } = yield* SessionTest({
						toolkit: concurrent,
						concurrency: "unbounded",
					})
					const running = yield* runtime
						.stream({ base, input: "perform tools" })
						.pipe(
							Stream.tap((event) =>
								Match.value(event).pipe(
									Match.when(
										{
											_tag: "ResponsePart",
											part: { type: "tool-result", name: "Echo" },
										},
										() => Deferred.succeed(received, undefined),
									),
									Match.orElse(() => Effect.void),
								),
							),
							Stream.runDrain,
							Effect.forkChild,
						)
					yield* Deferred.await(received)
					yield* Fiber.interrupt(running)
					const view = yield* runtimeStore.read(base.session)
					assert.equal(
						Session.currentTurn(view.session)!.status._tag,
						"Interrupted",
					)
					assert.match(
						JSON.stringify(TimelineState.fullHistory(view.state.value)),
						/actual external receipt/,
					)
					assert.equal(TimelineState.coherent(view.state.value), true)
				}),
			).pipe(
				Effect.provide(
					Layer.merge(
						concurrent.toLayer({
							Echo: () => Effect.succeed("actual external receipt"),
							Slow: () => Effect.never,
						}),
						LanguageModelTest({
							streamText: () =>
								Stream.make(
									call(),
									Response.makePart("tool-call", {
										id: "slow",
										name: "Slow",
										params: {},
										providerExecuted: false,
									}),
									finish("tool-calls"),
								),
						}),
					),
				),
			),
		)
	},
)

test("an activity wait wakes after the final resources are released, without a new Timeline version", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const plugin = Plugin.make({ id: Plugin.Id.make("delayed-finalizer") })(
					() =>
						Effect.succeed((next, options) =>
							next(options).pipe(
								Stream.ensuring(
									Deferred.succeed(entered, undefined).pipe(
										Effect.andThen(Deferred.await(release)),
									),
								),
							),
						),
				)
				const { runtime, runtimeStore, base } = yield* SessionTest({ plugin })
				yield* runtime.start({ base, input: "finish" })
				yield* Deferred.await(entered)
				yield* Effect.gen(function* () {
					const completed = yield* runtimeStore.read(base.session)
					assert.equal(Session.status(completed.session)._tag, "Completed")
					assert.equal(yield* runtime.isActive(base.session), true)
					const waiting = yield* Effect.forkChild(
						runtime.wait({
							session: base.session,
							after: completed.session.revision,
							afterActive: true,
							timeout: "5 seconds",
						}),
						{ startImmediately: true },
					)
					yield* Deferred.succeed(release, undefined)
					const settled = yield* Fiber.join(waiting).pipe(
						Effect.timeout("500 millis"),
					)
					assert.equal(settled.session.head, completed.session.head)
					assert.equal(settled.session.revision, completed.session.revision)
					assert.equal(yield* runtime.isActive(base.session), false)
					yield* runtime
						.wait({
							session: base.session,
							after: settled.session.revision,
							afterActive: true,
							timeout: "5 seconds",
						})
						.pipe(Effect.timeout("500 millis"))
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
			}),
		).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.fromArray(textParts("done")),
				}),
			),
		),
	)
})
