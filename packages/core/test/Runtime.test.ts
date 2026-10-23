// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import {
	Array as EffectArray,
	Effect,
	Fiber,
	HashMap,
	Layer,
	Order,
	Schema,
	Stream,
} from "effect"
import { AiError, Response, Tool, Toolkit } from "effect/ai"
import { Bot, Chat, ChatState } from "@openbot-build/core"
import { ChatTest } from "./ChatTest.ts"
import { LanguageModelTest, textParts } from "./LanguageModelTest.ts"

test("execute saves the input and the completed Turn", async () => {
	let calls = 0
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, chat } = yield* ChatTest()
				const result = yield* runtime.execute({ chat, input: "hello" })
				const turn = Chat.currentTurn(result.chat)!
				assert.equal(turn.status._tag, "Completed")
				assert.ok(turn.status._tag === "Completed")
				assert.equal(turn.status.result.text, "answer")
				assert.equal(turn.steps, 1)
				assert.equal(turn.usage?.length, 1)
				assert.ok(turn.completedAt !== undefined)
				assert.equal(result.state.conversation.closed, true)
				assert.deepEqual(
					result.state.conversation.context.prompt.content.map(
						(message) => message.role,
					),
					["user", "assistant"],
				)
				const items = yield* runtimeStore.items(chat)
				assert.equal(items.length, 2)
				assert.deepEqual(
					items.map((item) => item.origin?.turn),
					[turn.id, turn.id],
				)
				assert.deepEqual(yield* runtimeStore.turns(chat), [turn])
				assert.equal(calls, 1)
			}),
		).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () =>
						Stream.suspend(() => {
							calls++
							return Stream.fromArray(textParts("answer"))
						}),
				}),
			),
		),
	)
})

const Echo = Tool.make("Echo", {
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.String,
})
const tools = Toolkit.make(Echo)
const failure = AiError.make({
	module: "test",
	method: "streamText",
	reason: AiError.InternalProviderError.make({
		description: "the model broke",
	}),
})

for (const scenario of [
	{
		name: "a model failure",
		stream: Stream.fail(failure),
		code: "model_error",
	},
	{ name: "a defect", stream: Stream.die("broken"), code: "internal_error" },
] as const)
	test(`${scenario.name} ends the Turn as Failed with ${scenario.code}, and every open call gets a result`, async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { runtime, runtimeStore, chat } = yield* ChatTest({
						toolkit: tools,
					})
					const exit = yield* Effect.exit(
						runtime.execute({ chat, input: "fail" }),
					)
					assert.equal(exit._tag, "Failure")
					const view = yield* runtimeStore.read(chat)
					const status = Chat.status(view.chat)
					assert.equal(status._tag, "Failed")
					assert.ok(status._tag === "Failed")
					assert.equal(status.code, scenario.code)
					assert.equal(view.state.conversation.closed, true)
					const items = yield* runtimeStore.items(chat)
					assert.match(JSON.stringify(items), /"name":"Echo"/)
					assert.equal(HashMap.size(ChatState.unansweredCalls(items)), 0)
				}),
			).pipe(
				Effect.provide(
					Layer.merge(
						tools.toLayer({ Echo: () => Effect.never }),
						LanguageModelTest({
							streamText: () =>
								Stream.concat(
									Stream.make(
										Response.makePart("tool-call", {
											id: "echo-1",
											name: "Echo",
											params: { text: "value" },
											providerExecuted: false,
										}),
									),
									scenario.stream,
								),
						}),
					),
				),
			),
		)
	})

test("events after a revision give the changes and Turn events of one Chat only", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, chat, view } = yield* ChatTest()
				const other = yield* runtimeStore.create({})
				const observed = yield* runtime
					.events({ chat, after: view.chat.revision })
					.pipe(
						Stream.takeUntil((event) => event._tag === "TurnCompleted"),
						Stream.runCollect,
						Effect.forkChild({ startImmediately: true }),
					)
				yield* runtime.execute({ chat: other.chat.id, input: "elsewhere" })
				const done = yield* runtime.execute({ chat, input: "here" })
				const events = yield* Fiber.join(observed)
				const tags = events.map((event) => event._tag)
				assert.ok(tags.includes("TurnStarted"))
				assert.ok(tags.includes("ModelStepStarted"))
				assert.ok(tags.includes("ResponsePart"))
				assert.equal(tags.at(-1), "TurnCompleted")
				const position = (event: Bot.Event) =>
					"view" in event ? Chat.position(event.view.chat) : event.at
				assert.ok(events.every((event) => position(event).chat === chat))
				const revisions = events
					.filter((event) => event._tag === "ChatUpdated")
					.map((event) => event.view.chat.revision)
				assert.ok(revisions.length > 0)
				assert.ok(revisions.every((revision) => revision > view.chat.revision))
				assert.deepEqual(
					revisions,
					EffectArray.sort(EffectArray.dedupe(revisions), Order.Number),
				)
				assert.equal(revisions.at(-1), done.chat.revision)
			}),
		).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.fromArray(textParts("answer")),
				}),
			),
		),
	)
})
