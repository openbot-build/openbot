import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Cause,
	Crypto,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Ref,
	Schema,
	Stream,
	type Duration,
} from "effect"
import { AiError, Response, Tool, Toolkit } from "effect/ai"
import { TestClock, TestCrypto } from "effect/testing"
import {
	Chat,
	type ChatStore,
	type Item,
	Operation,
	Operations,
	Turn,
} from "@openbot-build/core"
import { ChatTest, settled } from "./ChatTest.ts"
import { LanguageModelTest, finish, textParts } from "./LanguageModelTest.ts"

const Slow = Tool.make("Slow", {
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.String,
})
const Held = Tool.make("Held", {
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.String,
}).annotate(Operation.Budget, "foreground")

/** The first model step calls `tool` `count` times. Every later step gives text. */
const model = (tool: string, count = 1) => {
	let calls = 0
	return LanguageModelTest({
		streamText: () =>
			Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
				calls++
				if (calls > 1) return Stream.fromArray(textParts("answer"))
				return Stream.fromArray([
					...Arr.makeBy(count, (index) =>
						Response.makePart("tool-call", {
							id: `call-${index + 1}`,
							name: tool,
							params: { text: "value" },
							providerExecuted: false,
						}),
					),
					finish("tool-calls"),
				])
			}),
	})
}

/**
 * Operations need random ids. TestCrypto gives the same ids on each run.
 * These tests make no digests.
 */
const crypto = TestCrypto.layer("operations").pipe(
	Layer.provide(
		Layer.succeed(
			Crypto.Crypto,
			Crypto.make({
				randomBytes: (size) => new Uint8Array(size),
				digest: () => Effect.die("The Operations tests make no digests."),
			}),
		),
	),
)

const operations = (settings: Partial<Operations.Settings> = {}) =>
	Layer.effect(
		Operations.Operations,
		Effect.flatMap(Operation.memoryStore, (store) =>
			Operations.make({
				store,
				settings: () =>
					Effect.succeed({
						...Operations.defaultSettings,
						budget: "50 millis",
						...settings,
					}),
			}),
		),
	).pipe(Layer.provide(crypto))

/**
 * Runs `execute`, and moves the test clock by `duration` when the tool call has
 * started. Operations sets up its budget before the call starts, so the move
 * reaches the budget. A move before the start would come too early.
 */
const executePast = <A, E, R>(
	execute: Effect.Effect<A, E, R>,
	started: Deferred.Deferred<void>,
	duration: Duration.Input,
) =>
	Effect.gen(function* () {
		const fiber = yield* Effect.forkChild(execute)
		yield* Deferred.await(started)
		yield* TestClock.adjust(duration)
		return yield* Fiber.join(fiber)
	})

/** Waits until the Chat has the notice of an Operation, and it is at rest. */
const noticed = (
	runtime: Parameters<typeof settled>[0],
	store: Pick<ChatStore.Store<{}>, "items" | "changes">,
	chat: Chat.Id,
	id: Operation.Id,
) =>
	Effect.gen(function* () {
		const isNotice = (item: Item.Record) =>
			item.origin?.notice?.kind === "operation" && item.origin.notice.ref === id
		// Listen first, so a notice that comes during the read is not lost.
		const seen = yield* store.changes({ chat }).pipe(
			Stream.filter(
				(change) =>
					change._tag === "Committed" && Arr.some(change.items, isNotice),
			),
			Stream.runHead,
			Effect.forkChild({ startImmediately: true }),
		)
		if (Arr.some(yield* store.items(chat), isNotice))
			yield* Fiber.interrupt(seen)
		else yield* Fiber.join(seen)
		return yield* settled(runtime, chat)
	})

/** The tool results that the model saw in the Chat. */
const toolResults = (view: Chat.View<{}>) =>
	Arr.flatMap(view.state.conversation.context.prompt.content, (message) =>
		message.role === "tool"
			? Arr.flatMap(message.content, (part) =>
					part.type === "tool-result" ? [part.result] : [],
				)
			: [],
	)

it.effect(
	"a call that ends inside its budget gives its result in the Turn",
	() =>
		Effect.gen(function* () {
			const { runtime, chat } = yield* ChatTest({ toolkit: Toolkit.make(Slow) })
			const view = yield* runtime.execute({ chat, input: "go" })
			assert.deepStrictEqual(toolResults(view), ["done value"])
			const service = yield* Operations.Operations
			assert.deepStrictEqual(yield* service.list(chat), [])
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					Toolkit.make(Slow).toLayer({
						Slow: ({ text }) => Effect.succeed(`done ${text}`),
					}),
					model("Slow"),
					operations(),
				),
			),
		),
)

it.effect(
	"a slow call goes to the background, and its end starts a new Turn",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>()
			const gate = yield* Deferred.make<void>()
			yield* Effect.gen(function* () {
				const { runtime, runtimeStore, chat } = yield* ChatTest({
					toolkit: Toolkit.make(Slow),
				})
				const first = yield* executePast(
					runtime.execute({ chat, input: "go" }),
					started,
					"50 millis",
				)
				const [result] = toolResults(first) as ReadonlyArray<{
					readonly operation: Operation.Id
					readonly status: string
				}>
				assert.strictEqual(result?.status, "running")
				const service = yield* Operations.Operations
				const running = yield* service.get(chat, result!.operation)
				assert.strictEqual(running.status._tag, "Running")
				assert.strictEqual(running.tool, "Slow")

				yield* Deferred.succeed(gate, undefined)
				const [ended] = yield* service.wait(chat, [running.id], "5 seconds")
				assert.deepStrictEqual(
					ended?.status,
					Operation.Status.Completed({ result: "done value" }),
				)
				const view = yield* noticed(runtime, runtimeStore, chat, running.id)
				assert.strictEqual(Chat.status(view.chat)._tag, "Completed")
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						Toolkit.make(Slow).toLayer({
							Slow: ({ text }) =>
								Deferred.succeed(started, undefined).pipe(
									Effect.andThen(Deferred.await(gate)),
									Effect.as(`done ${text}`),
								),
						}),
						model("Slow"),
						operations(),
					),
				),
			)
		}),
)

it.effect("a foreground tool keeps its Turn until it ends", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		yield* Effect.gen(function* () {
			const { runtime, chat } = yield* ChatTest({ toolkit: Toolkit.make(Held) })
			const view = yield* executePast(
				runtime.execute({ chat, input: "go" }),
				started,
				"200 millis",
			)
			assert.deepStrictEqual(toolResults(view), ["held value"])
			const service = yield* Operations.Operations
			assert.deepStrictEqual(yield* service.list(chat), [])
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					Toolkit.make(Held).toLayer({
						Held: ({ text }) =>
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Effect.sleep("200 millis")),
								Effect.as(`held ${text}`),
							),
					}),
					model("Held"),
					operations(),
				),
			),
		)
	}),
)

it.effect("a Chat at its limit keeps more calls in the Turn", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		yield* Effect.gen(function* () {
			const { runtime, chat } = yield* ChatTest({ toolkit: Toolkit.make(Slow) })
			const view = yield* executePast(
				runtime.execute({ chat, input: "go" }),
				started,
				"200 millis",
			)
			assert.deepStrictEqual(toolResults(view), ["done value"])
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					Toolkit.make(Slow).toLayer({
						Slow: ({ text }) =>
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Effect.sleep("200 millis")),
								Effect.as(`done ${text}`),
							),
					}),
					model("Slow"),
					operations({ limit: 0 }),
				),
			),
		)
	}),
)

it.effect("calls that start at the same time do not pass the limit", () =>
	Effect.gen(function* () {
		const starts = yield* Ref.make(0)
		const started = yield* Deferred.make<void>()
		yield* Effect.gen(function* () {
			const { runtime, chat } = yield* ChatTest({ toolkit: Toolkit.make(Slow) })
			const view = yield* executePast(
				runtime.execute({ chat, input: "go" }),
				started,
				"200 millis",
			)
			const results = toolResults(view)
			assert.strictEqual(results.length, 2)
			assert.strictEqual(
				Arr.filter(results, (result) => result === "done value").length,
				1,
			)
			assert.strictEqual(
				Arr.filter(
					results,
					(result) =>
						typeof result === "object" &&
						result !== null &&
						"status" in result &&
						result.status === "running",
				).length,
				1,
			)
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					Toolkit.make(Slow).toLayer({
						// The clock moves only when both calls have started.
						Slow: ({ text }) =>
							Ref.updateAndGet(starts, (count) => count + 1).pipe(
								Effect.flatMap((count) =>
									count === 2
										? Deferred.succeed(started, undefined)
										: Effect.void,
								),
								Effect.andThen(Effect.sleep("200 millis")),
								Effect.as(`done ${text}`),
							),
					}),
					model("Slow", 2),
					operations({ limit: 1 }),
				),
			),
		)
	}),
)

it.effect("cancel stops a background call and tells its Chat", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const stoppedTool = yield* Deferred.make<void>()
		yield* Effect.gen(function* () {
			const { runtime, runtimeStore, chat } = yield* ChatTest({
				toolkit: Toolkit.make(Slow),
			})
			const first = yield* executePast(
				runtime.execute({ chat, input: "go" }),
				started,
				"50 millis",
			)
			const [result] = toolResults(first) as ReadonlyArray<{
				readonly operation: Operation.Id
			}>
			const service = yield* Operations.Operations
			const stopped = yield* service.cancel(chat, result!.operation)
			assert.strictEqual(stopped.status._tag, "Cancelled")
			yield* Deferred.await(stoppedTool)
			yield* noticed(runtime, runtimeStore, chat, stopped.id)
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					Toolkit.make(Slow).toLayer({
						Slow: () =>
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(
									Effect.never.pipe(
										Effect.onInterrupt(() =>
											Deferred.succeed(stoppedTool, undefined),
										),
									),
								),
							),
					}),
					model("Slow"),
					operations(),
				),
			),
		)
	}),
)

it.effect("a call that runs too long fails", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		yield* Effect.gen(function* () {
			const { runtime, chat } = yield* ChatTest({ toolkit: Toolkit.make(Slow) })
			const first = yield* executePast(
				runtime.execute({ chat, input: "go" }),
				started,
				"50 millis",
			)
			const [result] = toolResults(first) as ReadonlyArray<{
				readonly operation: Operation.Id
			}>
			const service = yield* Operations.Operations
			yield* TestClock.adjust("150 millis")
			const [ended] = yield* service.wait(
				chat,
				[result!.operation],
				"5 seconds",
			)
			assert.strictEqual(ended?.status._tag, "Failed")
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					Toolkit.make(Slow).toLayer({
						Slow: () =>
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Effect.never),
							),
					}),
					model("Slow"),
					operations({ maxDuration: "200 millis" }),
				),
			),
		)
	}),
)

it.effect(
	"a call that passes its time limit inside its budget does not keep its Turn",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>()
			yield* Effect.gen(function* () {
				const { runtime, chat } = yield* ChatTest({
					toolkit: Toolkit.make(Slow),
				})
				const first = yield* executePast(
					runtime.execute({ chat, input: "go" }),
					started,
					"50 millis",
				)
				const [result] = toolResults(first) as ReadonlyArray<{
					readonly operation: Operation.Id
					readonly status: string
				}>
				assert.strictEqual(result?.status, "running")
				const service = yield* Operations.Operations
				const [ended] = yield* service.wait(
					chat,
					[result!.operation],
					"5 seconds",
				)
				assert.strictEqual(ended?.status._tag, "Failed")
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						Toolkit.make(Slow).toLayer({
							Slow: () =>
								Deferred.succeed(started, undefined).pipe(
									Effect.andThen(Effect.never),
								),
						}),
						model("Slow"),
						operations({ budget: "200 millis", maxDuration: "50 millis" }),
					),
				),
			)
		}),
)

it.effect(
	"a caller that stops while its call moves to the background leaves a whole Operation",
	() =>
		Effect.gen(function* () {
			const base = yield* Operation.memoryStore
			const inserting = yield* Deferred.make<void>()
			const gate = yield* Deferred.make<void>()
			const store: Operation.Store = {
				...base,
				insert: (record) =>
					Deferred.succeed(inserting, undefined).pipe(
						Effect.andThen(Deferred.await(gate)),
						Effect.andThen(base.insert(record)),
					),
			}
			const service = yield* Operations.make({
				store,
				settings: () =>
					Effect.succeed({
						...Operations.defaultSettings,
						budget: "50 millis",
					}),
			})
			const started = yield* Deferred.make<void>()
			const release = yield* Deferred.make<string>()
			const notified = yield* Deferred.make<Operation.Record>()
			const caller = yield* service
				.run(
					{
						chat: Chat.Id.make("chat"),
						turn: Turn.Id.make("turn"),
						callId: "call-1",
						tool: "Slow",
						notify: (record) =>
							Deferred.succeed(notified, record).pipe(Effect.asVoid),
					},
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					),
					(exit) =>
						Exit.isSuccess(exit)
							? Operation.Status.Completed({ result: exit.value })
							: Operation.Status.Failed({ message: "The call failed." }),
				)
				.pipe(Effect.forkChild)
			yield* Deferred.await(started)
			yield* TestClock.adjust("50 millis")
			yield* Deferred.await(inserting)
			// The caller stops while the insert waits.
			const stopping = yield* Fiber.interrupt(caller).pipe(
				Effect.forkChild({ startImmediately: true }),
			)
			yield* Deferred.succeed(gate, undefined)
			yield* Fiber.join(stopping)
			yield* Deferred.succeed(release, "done")
			const record = yield* Deferred.await(notified)
			assert.deepStrictEqual(
				record.status,
				Operation.Status.Completed({ result: "done" }),
			)
		}).pipe(Effect.provide(crypto)),
)

it.effect("an Operation of another Chat is not found", () =>
	Effect.gen(function* () {
		const store = yield* Operation.memoryStore
		const service = yield* Operations.make({ store })
		yield* store.insert({
			id: Operation.Id.make("op"),
			chat: Chat.Id.make("one"),
			turn: Turn.Id.make("turn"),
			callId: "call-1",
			tool: "Slow",
			kind: "tool",
			status: Operation.Status.Running(),
			startedAt: 0,
		})
		const error = yield* service
			.get(Chat.Id.make("other"), Operation.Id.make("op"))
			.pipe(Effect.flip)
		assert.strictEqual(error._tag, "OperationNotFound")
		assert.strictEqual(error.id, "op")
		const found = yield* service.get(
			Chat.Id.make("one"),
			Operation.Id.make("op"),
		)
		assert.strictEqual(found.chat, "one")
	}).pipe(Effect.scoped, Effect.provide(crypto)),
)

it.effect(
	"cancelChat asks other servers to stop the running Operations of the Chat",
	() =>
		Effect.gen(function* () {
			const base = yield* Operation.memoryStore
			const requested = yield* Ref.make<ReadonlyArray<Operation.Id>>([])
			const store: Operation.Store = {
				...base,
				requestCancel: (id) => Ref.update(requested, Arr.append(id)),
			}
			const service = yield* Operations.make({ store })
			const record = (
				id: string,
				chat: string,
				status: Operation.Status,
			): Operation.Record => ({
				id: Operation.Id.make(id),
				chat: Chat.Id.make(chat),
				turn: Turn.Id.make("turn"),
				callId: "call-1",
				tool: "Slow",
				kind: "tool",
				status,
				startedAt: 0,
			})
			yield* Effect.forEach(
				[
					record("running", "one", Operation.Status.Running()),
					record(
						"ended",
						"one",
						Operation.Status.Completed({ result: "done" }),
					),
					record("other", "two", Operation.Status.Running()),
				],
				store.insert,
				{ discard: true },
			)
			yield* service.cancelChat(Chat.Id.make("one"))
			assert.deepStrictEqual(yield* Ref.get(requested), [
				Operation.Id.make("running"),
			])
		}).pipe(Effect.scoped, Effect.provide(crypto)),
)

it.effect(
	"a background call that ends while its Chat is cancelled still tells the Chat once",
	() =>
		Effect.gen(function* () {
			const base = yield* Operation.memoryStore
			const finishing = yield* Deferred.make<void>()
			const gate = yield* Deferred.make<void>()
			const store: Operation.Store = {
				...base,
				// The store has the end, but it waits before it gives it back.
				finish: (id, status, endedAt) =>
					base.finish(id, status, endedAt).pipe(
						Effect.tap(() => Deferred.succeed(finishing, undefined)),
						Effect.tap(() => Deferred.await(gate)),
					),
			}
			const service = yield* Operations.make({
				store,
				settings: () =>
					Effect.succeed({
						...Operations.defaultSettings,
						budget: "50 millis",
					}),
			})
			const chat = Chat.Id.make("chat")
			const started = yield* Deferred.make<void>()
			const release = yield* Deferred.make<string>()
			const notices = yield* Ref.make<ReadonlyArray<Operation.Record>>([])
			const caller = yield* service
				.run(
					{
						chat,
						turn: Turn.Id.make("turn"),
						callId: "call-1",
						tool: "Slow",
						notify: (record) => Ref.update(notices, Arr.append(record)),
					},
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					),
					(exit) =>
						Exit.isSuccess(exit)
							? Operation.Status.Completed({ result: exit.value })
							: Operation.Status.Failed({ message: "The call failed." }),
				)
				.pipe(Effect.forkChild)
			yield* Deferred.await(started)
			yield* TestClock.adjust("50 millis")
			const outcome = yield* Fiber.join(caller)
			assert.strictEqual(outcome._tag, "Background")
			yield* Deferred.succeed(release, "done")
			yield* Deferred.await(finishing)
			// The cancel comes after the store has the end, and before the Chat has its notice.
			const cancelling = yield* service
				.cancelChat(chat)
				.pipe(Effect.forkChild({ startImmediately: true }))
			yield* Deferred.succeed(gate, undefined)
			yield* Fiber.join(cancelling)
			const sent = yield* Ref.get(notices)
			assert.strictEqual(sent.length, 1)
			assert.deepStrictEqual(
				sent[0]?.status,
				Operation.Status.Completed({ result: "done" }),
			)
		}).pipe(Effect.scoped, Effect.provide(crypto)),
)

it.effect(
	"a failed call gives a fixed message, so inside details do not reach the Chat",
	() =>
		Effect.sync(() => {
			const internal = "The call stopped because of an internal error."
			assert.strictEqual(
				Operations.failureMessage(
					Cause.die(new Error("The database at 10.0.0.5 did not answer")),
				),
				internal,
			)
			assert.strictEqual(
				Operations.failureMessage(Cause.fail("A private failure")),
				internal,
			)
			assert.strictEqual(
				Operations.failureMessage(Cause.interrupt()),
				"The call was stopped.",
			)
			const failure = AiError.make({
				module: "test",
				method: "streamText",
				reason: AiError.InternalProviderError.make({
					description: "the model broke",
				}),
			})
			assert.strictEqual(
				Operations.failureMessage(Cause.fail(failure)),
				failure.message,
			)
		}),
)
