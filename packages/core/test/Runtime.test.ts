import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Layer,
	Option,
	Order,
	pipe,
	Schema,
	Stream,
} from "effect"
import { AiError, Response, Tool, Toolkit } from "effect/ai"
import { Bot, Chat, ChatState } from "@openbot-build/core"
import { ChatTest } from "./ChatTest.ts"
import { LanguageModelTest, finish, textParts } from "./LanguageModelTest.ts"

it.effect("execute saves the input and the completed Turn", () => {
	let calls = 0
	return Effect.gen(function* () {
		const { runtime, runtimeStore, chat } = yield* ChatTest()
		const result = yield* runtime.execute({ chat, input: "hello" })
		const turn = Chat.currentTurn(result.chat)!
		assert.strictEqual(turn.status._tag, "Completed")
		assert.ok(turn.status._tag === "Completed")
		assert.strictEqual(turn.status.result.text, "answer")
		assert.strictEqual(turn.steps, 1)
		assert.strictEqual(turn.usage?.length, 1)
		assert.ok(turn.completedAt !== undefined)
		assert.strictEqual(result.state.conversation.closed, true)
		assert.deepStrictEqual(
			Arr.map(
				result.state.conversation.context.prompt.content,
				(message) => message.role,
			),
			["user", "assistant"],
		)
		const items = yield* runtimeStore.items(chat)
		assert.strictEqual(items.length, 2)
		assert.deepStrictEqual(
			Arr.map(items, (item) => item.origin?.turn),
			[turn.id, turn.id],
		)
		assert.deepStrictEqual(yield* runtimeStore.turns(chat), [turn])
		assert.strictEqual(calls, 1)
	}).pipe(
		Effect.provide(
			LanguageModelTest({
				streamText: () =>
					Stream.suspend(() => {
						calls++
						return Stream.fromArray(textParts("answer"))
					}),
			}),
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
		error: Option.some(failure),
	},
	{
		name: "a defect",
		stream: Stream.die("broken"),
		code: "internal_error",
		error: Option.none(),
	},
] as const)
	it.effect(
		`${scenario.name} ends the Turn as Failed with ${scenario.code}, and every open call gets a result`,
		() =>
			Effect.gen(function* () {
				const { runtime, runtimeStore, chat } = yield* ChatTest({
					toolkit: tools,
				})
				const exit = yield* Effect.exit(
					runtime.execute({ chat, input: "fail" }),
				)
				assert.ok(Exit.isFailure(exit))
				assert.deepStrictEqual(Exit.findErrorOption(exit), scenario.error)
				assert.strictEqual(
					Exit.hasDies(exit),
					scenario.code === "internal_error",
				)
				const view = yield* runtimeStore.read(chat)
				const status = Chat.status(view.chat)
				assert.strictEqual(status._tag, "Failed")
				assert.ok(status._tag === "Failed")
				assert.strictEqual(status.code, scenario.code)
				assert.strictEqual(view.state.conversation.closed, true)
				const items = yield* runtimeStore.items(chat)
				const calls = pipe(
					items,
					Arr.flatMap((item) => item.content.content),
					Arr.flatMap((message) =>
						message.role === "assistant" ? message.content : [],
					),
					Arr.filter((part) => part.type === "tool-call"),
					Arr.map((part) => part.name),
				)
				assert.deepStrictEqual(calls, ["Echo"])
				assert.strictEqual(HashMap.size(ChatState.unansweredCalls(items)), 0)
			}).pipe(
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

const position = (event: Bot.Event) =>
	"view" in event ? Chat.position(event.view.chat) : event.at

it.effect(
	"events after a revision give the changes and Turn events of one Chat only",
	() =>
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
			const tags = Arr.map(events, (event) => event._tag)
			assert.ok(tags.includes("TurnStarted"))
			assert.ok(tags.includes("ModelStepStarted"))
			assert.ok(tags.includes("ResponsePart"))
			assert.strictEqual(tags.at(-1), "TurnCompleted")
			assert.ok(Arr.every(events, (event) => position(event).chat === chat))
			const revisions = pipe(
				events,
				Arr.filter((event) => event._tag === "ChatUpdated"),
				Arr.map((event) => event.view.chat.revision),
			)
			assert.ok(revisions.length > 0)
			assert.ok(
				Arr.every(revisions, (revision) => revision > view.chat.revision),
			)
			assert.deepStrictEqual(
				revisions,
				Arr.sort(Arr.dedupe(revisions), Order.Number),
			)
			assert.strictEqual(revisions.at(-1), done.chat.revision)
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.fromArray(textParts("answer")),
				}),
			),
		),
)

it.effect(
	"a late subscriber gets the recent events of one Chat after a revision, each one once",
	() =>
		Effect.gen(function* () {
			const { runtime, runtimeStore, chat, view } = yield* ChatTest()
			const other = yield* runtimeStore.create({})
			yield* runtime.execute({ chat: other.chat.id, input: "elsewhere" })
			const done = yield* runtime.execute({ chat, input: "here" })
			// The Turn has ended, so every event comes from the replay.
			const events = yield* runtime
				.events({ chat, after: view.chat.revision })
				.pipe(
					Stream.takeUntil((event) => event._tag === "TurnCompleted"),
					Stream.runCollect,
				)
			const tags = Arr.map(events, (event) => event._tag)
			assert.strictEqual(tags[0], "ChatUpdated")
			assert.strictEqual(tags.at(-1), "TurnCompleted")
			assert.deepStrictEqual(
				Arr.filter(tags, (tag) => tag !== "ChatUpdated"),
				[
					"TurnStarted",
					"ModelStepStarted",
					"ResponsePart",
					"ResponsePart",
					"ResponsePart",
					"ResponsePart",
					"TurnCompleted",
				],
			)
			assert.deepStrictEqual(
				Arr.flatMap(events, (event) =>
					event._tag === "ResponsePart" ? [event.part.type] : [],
				),
				["text-start", "text-delta", "text-end", "finish"],
			)
			assert.ok(Arr.every(events, (event) => position(event).chat === chat))
			assert.ok(
				Arr.every(
					events,
					(event) => position(event).revision > view.chat.revision,
				),
			)
			const revisions = pipe(
				events,
				Arr.filter((event) => event._tag === "ChatUpdated"),
				Arr.map((event) => event.view.chat.revision),
			)
			assert.deepStrictEqual(
				revisions,
				Arr.sort(Arr.dedupe(revisions), Order.Number),
			)
			assert.strictEqual(revisions.at(-1), done.chat.revision)
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.fromArray(textParts("answer")),
				}),
			),
		),
)

it.effect(
	"a slow subscriber misses old events but gets the newest ones and the end of the Turn",
	() => {
		const parts = 5000
		const delta = (index: number) => `delta-${index};`
		return Effect.gen(function* () {
			const { runtime, chat, view } = yield* ChatTest()
			const gate = yield* Deferred.make<void>()
			// The subscriber reads one event, and then it reads nothing while the Turn runs.
			const observed = yield* runtime
				.events({ chat, after: view.chat.revision })
				.pipe(
					Stream.tap(() => Deferred.await(gate)),
					Stream.takeUntil((event) => event._tag === "TurnCompleted"),
					Stream.runCollect,
					Effect.forkChild({ startImmediately: true }),
				)
			const done = yield* runtime.execute({ chat, input: "many parts" })
			assert.strictEqual(Chat.status(done.chat)._tag, "Completed")
			yield* Deferred.succeed(gate, undefined)
			const events = yield* Fiber.join(observed)
			const deltas = Arr.flatMap(events, (event) =>
				event._tag === "ResponsePart" && event.part.type === "text-delta"
					? [event.part.delta]
					: [],
			)
			assert.ok(deltas.length > 0)
			assert.ok(
				deltas.length < parts,
				`The subscriber kept ${deltas.length} of ${parts} parts`,
			)
			assert.strictEqual(deltas.at(-1), delta(parts - 1))
			assert.strictEqual(events.at(-1)?._tag, "TurnCompleted")
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () =>
						Stream.fromIterable([
							Response.makePart("text-start", { id: "answer" }),
							...Arr.makeBy(parts, (index) =>
								Response.makePart("text-delta", {
									id: "answer",
									delta: delta(index),
								}),
							),
							Response.makePart("text-end", { id: "answer" }),
							finish(),
						]),
				}),
			),
		)
	},
)
