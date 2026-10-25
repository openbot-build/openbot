// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Schedule, Schema, Stream } from "effect"
import { Response, Tool, Toolkit } from "effect/ai"
import {
	Chat,
	type ChatStore,
	Operation,
	Operations,
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

/** The first model step calls `tool`. Every later step gives text. */
const model = (tool: string) => {
	let calls = 0
	return LanguageModelTest({
		streamText: () =>
			Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
				calls++
				if (calls > 1) return Stream.fromArray(textParts("answer"))
				return Stream.make(
					Response.makePart("tool-call", {
						id: "call-1",
						name: tool,
						params: { text: "value" },
						providerExecuted: false,
					}),
					finish("tool-calls"),
				)
			}),
	})
}

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
	)

/** Waits until the Chat has the notice of an Operation, and it is at rest. */
const noticed = (
	runtime: Parameters<typeof settled>[0],
	store: Pick<ChatStore.Store<{}>, "items">,
	chat: Chat.Id,
	id?: Operation.Id,
) =>
	store.items(chat).pipe(
		Effect.filterOrFail(
			(items) =>
				items.some(
					(item) =>
						item.origin?.notice?.kind === "operation" &&
						(id === undefined || item.origin.notice.ref === id),
				),
			() => "The notice is not there yet.",
		),
		Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }),
		Effect.orDie,
		Effect.andThen(settled(runtime, chat)),
	)

/** The tool results that the model saw in the Chat. */
const toolResults = (view: Chat.View<{}>) =>
	view.state.conversation.context.prompt.content.flatMap((message) =>
		message.role === "tool"
			? message.content.flatMap((part) =>
					part.type === "tool-result" ? [part.result] : [],
				)
			: [],
	)

it.live("a call that ends inside its budget gives its result in the Turn", () =>
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

it.live(
	"a slow call goes to the background, and its end starts a new Turn",
	() => {
		const gate = Deferred.makeUnsafe<void>()
		return Effect.gen(function* () {
			const { runtime, runtimeStore, chat } = yield* ChatTest({
				toolkit: Toolkit.make(Slow),
			})
			const first = yield* runtime.execute({ chat, input: "go" })
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
							Deferred.await(gate).pipe(Effect.as(`done ${text}`)),
					}),
					model("Slow"),
					operations(),
				),
			),
		)
	},
)

it.live("a foreground tool keeps its Turn until it ends", () =>
	Effect.gen(function* () {
		const { runtime, chat } = yield* ChatTest({ toolkit: Toolkit.make(Held) })
		const view = yield* runtime.execute({ chat, input: "go" })
		assert.deepStrictEqual(toolResults(view), ["held value"])
		const service = yield* Operations.Operations
		assert.deepStrictEqual(yield* service.list(chat), [])
	}).pipe(
		Effect.provide(
			Layer.mergeAll(
				Toolkit.make(Held).toLayer({
					Held: ({ text }) =>
						Effect.sleep("200 millis").pipe(Effect.as(`held ${text}`)),
				}),
				model("Held"),
				operations(),
			),
		),
	),
)

it.live("a Chat at its limit keeps more calls in the Turn", () =>
	Effect.gen(function* () {
		const { runtime, chat } = yield* ChatTest({ toolkit: Toolkit.make(Slow) })
		const view = yield* runtime.execute({ chat, input: "go" })
		assert.deepStrictEqual(toolResults(view), ["done value"])
	}).pipe(
		Effect.provide(
			Layer.mergeAll(
				Toolkit.make(Slow).toLayer({
					Slow: ({ text }) =>
						Effect.sleep("200 millis").pipe(Effect.as(`done ${text}`)),
				}),
				model("Slow"),
				operations({ limit: 0 }),
			),
		),
	),
)

it.live("cancel stops a background call and tells its Chat", () =>
	Effect.gen(function* () {
		const { runtime, runtimeStore, chat } = yield* ChatTest({
			toolkit: Toolkit.make(Slow),
		})
		const first = yield* runtime.execute({ chat, input: "go" })
		const [result] = toolResults(first) as ReadonlyArray<{
			readonly operation: Operation.Id
		}>
		const service = yield* Operations.Operations
		const stopped = yield* service.cancel(chat, result!.operation)
		assert.strictEqual(stopped.status._tag, "Cancelled")
		yield* noticed(runtime, runtimeStore, chat, stopped.id)
	}).pipe(
		Effect.provide(
			Layer.mergeAll(
				Toolkit.make(Slow).toLayer({ Slow: () => Effect.never }),
				model("Slow"),
				operations(),
			),
		),
	),
)

it.live("a call that runs too long fails", () =>
	Effect.gen(function* () {
		const { runtime, chat } = yield* ChatTest({ toolkit: Toolkit.make(Slow) })
		const first = yield* runtime.execute({ chat, input: "go" })
		const [result] = toolResults(first) as ReadonlyArray<{
			readonly operation: Operation.Id
		}>
		const service = yield* Operations.Operations
		const [ended] = yield* service.wait(chat, [result!.operation], "5 seconds")
		assert.strictEqual(ended?.status._tag, "Failed")
	}).pipe(
		Effect.provide(
			Layer.mergeAll(
				Toolkit.make(Slow).toLayer({ Slow: () => Effect.never }),
				model("Slow"),
				operations({ maxDuration: "200 millis" }),
			),
		),
	),
)

it.live("an Operation of another Chat is not found", () =>
	Effect.gen(function* () {
		const service = yield* Operations.Operations
		const exit = yield* Effect.exit(
			service.get(Chat.Id.make("other"), Operation.Id.make("missing")),
		)
		assert.strictEqual(exit._tag, "Failure")
	}).pipe(Effect.provide(operations())),
)
