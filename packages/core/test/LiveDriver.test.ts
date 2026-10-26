import { assert, it } from "@effect/vitest"
import { Chat, ContextWindow, Live, LiveDriver } from "@openbot-build/core"
import {
	Array as Arr,
	Deferred,
	Effect,
	Fiber,
	Option,
	PubSub,
	Ref,
	Schema,
} from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { ChatTest } from "./ChatTest.ts"

const usage: Live.Usage = {
	input: { text: 3, audio: 10, image: 0, cached: 2 },
	output: { text: 4, audio: 20 },
}

const base: LiveDriver.Options["base"] = {
	audio: {
		input: { encoding: "pcm16", sampleRate: 24000 },
		output: { encoding: "pcm16", sampleRate: 24000 },
	},
	turnDetection: "server",
}

/**
 * A connection that gives one scripted answer for each Respond input. It keeps every
 * input, so a test can check what the driver sent.
 */
const scripted = (answers: ReadonlyArray<ReadonlyArray<Live.Event>>) =>
	Effect.gen(function* () {
		const events = yield* PubSub.unbounded<Live.Event>()
		const inputs = yield* Ref.make<ReadonlyArray<Live.Input>>([])
		const next = yield* Ref.make(0)
		const send = (input: Live.Input) =>
			Effect.gen(function* () {
				yield* Ref.update(inputs, (all) => [...all, input])
				if (input._tag !== "Respond") return
				const index = yield* Ref.getAndUpdate(next, (n) => n + 1)
				yield* PubSub.publishAll(events, answers[index] ?? [])
			})
		const driver = yield* LiveDriver.make({ send, events, base })
		return { driver, inputs }
	})

const said = (itemId: string, text: string) => [
	Live.Event.OutputTranscript({ itemId, delta: text }),
	Live.Event.OutputDone({ itemId }),
	Live.Event.ResponseDone({ status: "completed", usage }),
]

it.effect(
	"an interrupted write cannot resend an input with an unknown result",
	() =>
		Effect.gen(function* () {
			const events = yield* PubSub.unbounded<Live.Event>()
			const inputs = yield* Ref.make<ReadonlyArray<Live.Input>>([])
			const writing = yield* Deferred.make<void>()
			const driver = yield* LiveDriver.make({
				events,
				base,
				send: (input) =>
					Ref.update(inputs, (all) => [...all, input]).pipe(
						Effect.andThen(
							input._tag === "Text"
								? Deferred.succeed(writing, undefined).pipe(
										Effect.andThen(Effect.never),
									)
								: Effect.void,
						),
					),
			})
			const request = LanguageModel.generateText({ prompt: "Read" }).pipe(
				Effect.provideService(LanguageModel.LanguageModel, driver.model),
			)
			const running = yield* Effect.forkScoped(request)
			yield* Deferred.await(writing)
			yield* Fiber.interrupt(running)
			const error = yield* request.pipe(Effect.flip)
			assert.ok(error.reason._tag === "InternalProviderError")
			assert.deepStrictEqual(
				Arr.map(yield* Ref.get(inputs), (input) => input._tag),
				["Configure", "Text"],
			)
		}),
)

it.effect("a partial input send cannot be retried on the same connection", () =>
	Effect.gen(function* () {
		const events = yield* PubSub.unbounded<Live.Event>()
		const inputs = yield* Ref.make<ReadonlyArray<Live.Input>>([])
		const driver = yield* LiveDriver.make({
			events,
			base,
			send: (input) =>
				Ref.update(inputs, (all) => [...all, input]).pipe(
					Effect.andThen(
						input._tag === "Image"
							? Effect.fail(
									Live.LiveError.make({
										reason: "closed",
										message: "The send result is unknown.",
									}),
								)
							: Effect.void,
					),
				),
		})
		const prompt = Prompt.make([
			{
				role: "user",
				content: [
					Prompt.textPart({ text: "Read" }),
					Prompt.filePart({ mediaType: "image/png", data: "AQID" }),
				],
			},
		])
		for (let attempt = 0; attempt < 2; attempt++) {
			yield* LanguageModel.generateText({ prompt }).pipe(
				Effect.provideService(LanguageModel.LanguageModel, driver.model),
				Effect.flip,
			)
		}
		assert.deepStrictEqual(
			Arr.map(yield* Ref.get(inputs), (input) => input._tag),
			["Configure", "Text", "Image"],
		)
	}),
)

it.effect(
	"a runtime-added tool result is sent once before it becomes saved history",
	() =>
		Effect.gen(function* () {
			const { driver, inputs } = yield* scripted([
				said("one", "Okay"),
				said("two", "Okay"),
			])
			const saved = Prompt.make([
				{ role: "user", content: "Read" },
				{
					role: "assistant",
					content: [
						Prompt.toolCallPart({
							id: "closed",
							name: "Read",
							params: {},
							providerExecuted: false,
						}),
					],
				},
			])
			const withResult = Prompt.concat(
				saved,
				Prompt.make([
					{
						role: "tool",
						content: [
							Prompt.toolResultPart({
								id: "closed",
								name: "Read",
								result: "The tool is closed.",
								isFailure: true,
								providerExecuted: false,
							}),
						],
					},
				]),
			)
			yield* driver.loaded(saved)
			yield* LanguageModel.generateText({ prompt: withResult }).pipe(
				Effect.provideService(LanguageModel.LanguageModel, driver.model),
				Effect.provideService(
					ContextWindow.CurrentWindow,
					ContextWindow.fromPrompt(saved),
				),
			)
			yield* LanguageModel.generateText({ prompt: withResult }).pipe(
				Effect.provideService(LanguageModel.LanguageModel, driver.model),
				Effect.provideService(
					ContextWindow.CurrentWindow,
					ContextWindow.fromPrompt(withResult),
				),
			)
			assert.strictEqual(
				Arr.filter(yield* Ref.get(inputs), Live.Input.$is("ToolResult")).length,
				1,
			)
		}),
)

it.effect(
	"raw history positions survive file loading and temporary text enrichment",
	() =>
		Effect.gen(function* () {
			const { driver, inputs } = yield* scripted([
				said("one", "Okay"),
				said("two", "Okay"),
			])
			const rawImage = Prompt.make([
				{
					role: "user",
					content: [
						Prompt.filePart({
							mediaType: "image/png",
							data: new URL("https://files.example/image"),
						}),
					],
				},
			])
			const loadedImage = Prompt.make([
				{
					role: "user",
					content: [
						Prompt.filePart({
							mediaType: "image/png",
							data: new Uint8Array([1, 2, 3]),
						}),
					],
				},
			])
			yield* driver.loaded(rawImage)
			const first = Prompt.concat(
				rawImage,
				Prompt.make([{ role: "user", content: "First" }]),
			)
			yield* LanguageModel.generateText({
				prompt: Prompt.concat(
					loadedImage,
					Prompt.make([{ role: "user", content: "First with memory" }]),
				),
			}).pipe(
				Effect.provideService(LanguageModel.LanguageModel, driver.model),
				Effect.provideService(
					ContextWindow.CurrentWindow,
					ContextWindow.fromPrompt(first),
				),
			)
			yield* LanguageModel.generateText({
				prompt: Prompt.concat(
					loadedImage,
					Prompt.make([
						{ role: "user", content: "First" },
						{ role: "user", content: "Second with memory" },
					]),
				),
			}).pipe(
				Effect.provideService(LanguageModel.LanguageModel, driver.model),
				Effect.provideService(
					ContextWindow.CurrentWindow,
					ContextWindow.fromPrompt(
						Prompt.concat(
							first,
							Prompt.make([{ role: "user", content: "Second" }]),
						),
					),
				),
			)
			const sent = yield* Ref.get(inputs)
			assert.deepStrictEqual(Arr.filter(sent, Live.Input.$is("Text")), [
				Live.Input.Text({ text: "First with memory" }),
				Live.Input.Text({ text: "Second with memory" }),
			])
			assert.deepStrictEqual(Arr.filter(sent, Live.Input.$is("Image")), [])
		}),
)

it.effect(
	"loaded history tails are not sent again and equal new input is kept",
	() =>
		Effect.gen(function* () {
			const { driver, inputs } = yield* scripted([said("new", "Okay")])
			const history = Prompt.make([
				{ role: "user", content: "Earlier" },
				{
					role: "assistant",
					content: [
						Prompt.toolCallPart({
							id: "old",
							name: "Lookup",
							params: {},
							providerExecuted: false,
						}),
					],
				},
				{
					role: "tool",
					content: [
						Prompt.toolResultPart({
							id: "old",
							name: "Lookup",
							result: "saved",
							isFailure: false,
							providerExecuted: false,
						}),
					],
				},
				{ role: "user", content: "Again" },
			])
			yield* driver.loaded(history)
			yield* LanguageModel.generateText({
				prompt: Prompt.concat(
					history,
					Prompt.make([{ role: "user", content: "Again" }]),
				),
			}).pipe(Effect.provideService(LanguageModel.LanguageModel, driver.model))
			const sent = yield* Ref.get(inputs)
			assert.deepStrictEqual(
				Arr.map(sent, (input) => input._tag),
				["Configure", "Text", "Respond"],
			)
			assert.deepStrictEqual(Arr.filter(sent, Live.Input.$is("Text")), [
				Live.Input.Text({ text: "Again" }),
			])
		}),
)

it.effect(
	"input before an interrupted answer is not resent on the next request",
	() =>
		Effect.gen(function* () {
			const { driver, inputs } = yield* scripted([
				[Live.Event.ResponseDone({ status: "cancelled", usage })],
				said("next", "Okay"),
			])
			const provide = Effect.provideService(
				LanguageModel.LanguageModel,
				driver.model,
			)
			const first = Prompt.make([{ role: "user", content: "Again" }])
			yield* driver.loaded(Prompt.empty)
			yield* LanguageModel.generateText({ prompt: first }).pipe(provide)
			yield* LanguageModel.generateText({
				prompt: Prompt.concat(
					first,
					Prompt.make([{ role: "user", content: "Again" }]),
				),
			}).pipe(provide)
			assert.deepStrictEqual(
				Arr.filter(yield* Ref.get(inputs), Live.Input.$is("Text")),
				[
					Live.Input.Text({ text: "Again" }),
					Live.Input.Text({ text: "Again" }),
				],
			)
		}),
)

it.effect("a changed loaded prefix fails without sending another input", () =>
	Effect.gen(function* () {
		const { driver, inputs } = yield* scripted([])
		yield* driver.loaded(Prompt.make([{ role: "user", content: "Saved" }]))
		const error = yield* LanguageModel.generateText({
			prompt: "Replaced",
		}).pipe(
			Effect.provideService(LanguageModel.LanguageModel, driver.model),
			Effect.flip,
		)
		assert.ok(error.reason._tag === "InternalProviderError")
		assert.deepStrictEqual(yield* Ref.get(inputs), [])
	}),
)

it.effect("a Turn answers through the Live connection", () =>
	Effect.gen(function* () {
		const { driver, inputs } = yield* scripted([said("answer_1", "Hello")])
		const { runtime, chat } = yield* ChatTest().pipe(
			Effect.provideService(LanguageModel.LanguageModel, driver.model),
		)
		const view = yield* runtime
			.execute({ chat, input: "Hi" })
			.pipe(Effect.provideService(LanguageModel.LanguageModel, driver.model))
		const turn = Chat.currentTurn(view.chat)!
		assert.strictEqual(turn.status._tag, "Completed")
		assert.ok(turn.status._tag === "Completed")
		assert.strictEqual(turn.status.result.text, "Hello")
		assert.strictEqual(turn.usage?.[0]?.inputTokens.total, 15)
		assert.strictEqual(turn.usage?.[0]?.outputTokens.total, 24)
		const tags = Arr.map(yield* Ref.get(inputs), (input) => input._tag)
		assert.deepStrictEqual(tags, ["Configure", "Text", "Respond"])
	}),
)

it.effect("text that the person said is not sent again", () =>
	Effect.gen(function* () {
		const { driver, inputs } = yield* scripted([
			said("answer_1", "One"),
			said("answer_2", "Two"),
		])
		const { runtime, chat } = yield* ChatTest().pipe(
			Effect.provideService(LanguageModel.LanguageModel, driver.model),
		)
		const provide = Effect.provideService(
			LanguageModel.LanguageModel,
			driver.model,
		)
		yield* driver.expect("spoken words")
		yield* runtime.execute({ chat, input: "spoken words" }).pipe(provide)
		yield* runtime.execute({ chat, input: "spoken words" }).pipe(provide)
		const tags = Arr.map(yield* Ref.get(inputs), (input) => input._tag)
		// The config does not change, so it goes only once. The second input is new text.
		assert.deepStrictEqual(tags, ["Configure", "Respond", "Text", "Respond"])
	}),
)

it.effect("a tool call runs in OpenBot and its result goes back", () => {
	const lookup = Tool.make("Lookup", {
		description: "Finds a word.",
		parameters: Schema.Struct({ word: Schema.String }),
		success: Schema.String,
	})
	const toolkit = Toolkit.make(lookup)
	return Effect.gen(function* () {
		const { driver, inputs } = yield* scripted([
			[
				Live.Event.ToolCall({
					callId: "call_1",
					name: "Lookup",
					arguments: '{"word":"sun"}',
				}),
				Live.Event.ResponseDone({ status: "completed", usage }),
			],
			said("answer_2", "The sun is a star."),
		])
		const { runtime, chat } = yield* ChatTest({ toolkit }).pipe(
			Effect.provideService(LanguageModel.LanguageModel, driver.model),
		)
		const view = yield* runtime
			.execute({ chat, input: "What is the sun?" })
			.pipe(Effect.provideService(LanguageModel.LanguageModel, driver.model))
		const turn = Chat.currentTurn(view.chat)!
		assert.ok(turn.status._tag === "Completed")
		assert.strictEqual(turn.status.result.text, "The sun is a star.")
		assert.strictEqual(turn.steps, 2)
		const sent = yield* Ref.get(inputs)
		const configure = Arr.findFirst(sent, Live.Input.$is("Configure"))
		assert.ok(Option.isSome(configure))
		assert.deepStrictEqual(
			Arr.map(configure.value.config.tools, (tool) => tool.name),
			["Lookup"],
		)
		const result = Arr.findFirst(sent, Live.Input.$is("ToolResult"))
		assert.ok(Option.isSome(result))
		assert.strictEqual(result.value.callId, "call_1")
		assert.strictEqual(result.value.output, '"Word: sun"')
	}).pipe(
		Effect.provide(
			toolkit.toLayer({
				Lookup: ({ word }) => Effect.succeed("Word: " + word),
			}),
		),
	)
})

it.effect("a failure of the connection fails the Turn", () =>
	Effect.gen(function* () {
		const { driver } = yield* scripted([
			[
				Live.Event.Failure({
					error: Live.LiveError.make({
						reason: "closed",
						message: "The connection closed.",
					}),
				}),
			],
		])
		const { runtime, chat } = yield* ChatTest().pipe(
			Effect.provideService(LanguageModel.LanguageModel, driver.model),
		)
		const error = yield* runtime
			.execute({ chat, input: "Hi" })
			.pipe(
				Effect.provideService(LanguageModel.LanguageModel, driver.model),
				Effect.flip,
			)
		assert.ok(error._tag === "AiError")
		assert.ok(error.reason._tag === "InternalProviderError")
		assert.strictEqual(error.reason.description, "The connection closed.")
		const view = yield* runtime.status(chat)
		const status = Chat.status(view.chat)
		assert.ok(status._tag === "Failed")
		assert.strictEqual(status.code, "model_error")
	}),
)

it.effect(
	"new image input goes through the driver instead of being dropped",
	() =>
		Effect.gen(function* () {
			const { driver, inputs } = yield* scripted([said("answer", "A tree.")])
			const { runtime, chat } = yield* ChatTest().pipe(
				Effect.provideService(LanguageModel.LanguageModel, driver.model),
			)
			yield* runtime
				.execute({
					chat,
					input: Prompt.make([
						{
							role: "user",
							content: [
								Prompt.textPart({ text: "What is here?" }),
								Prompt.filePart({ mediaType: "image/png", data: "AQID" }),
							],
						},
					]),
				})
				.pipe(Effect.provideService(LanguageModel.LanguageModel, driver.model))
			const image = Arr.findFirst(
				yield* Ref.get(inputs),
				Live.Input.$is("Image"),
			)
			assert.ok(Option.isSome(image))
			assert.strictEqual(image.value.mediaType, "image/png")
			assert.deepStrictEqual([...image.value.bytes], [1, 2, 3])
		}),
)

it.effect(
	"unsupported files fail before any new input reaches the Live model",
	() =>
		Effect.gen(function* () {
			const { driver, inputs } = yield* scripted([])
			const { runtime, chat } = yield* ChatTest().pipe(
				Effect.provideService(LanguageModel.LanguageModel, driver.model),
			)
			yield* runtime
				.execute({
					chat,
					input: Prompt.make([
						{
							role: "user",
							content: [
								Prompt.textPart({ text: "Read this." }),
								Prompt.filePart({ mediaType: "application/pdf", data: "AQID" }),
							],
						},
					]),
				})
				.pipe(
					Effect.provideService(LanguageModel.LanguageModel, driver.model),
					Effect.flip,
				)
			assert.deepStrictEqual(yield* Ref.get(inputs), [])
		}),
)

it.effect("unsupported inputs are found from the capabilities", () =>
	Effect.gen(function* () {
		const capabilities: Live.Capabilities = {
			audio: { input: [base.audio.input], output: [base.audio.output] },
			turnDetection: ["server"],
			inputTranscription: true,
			tools: true,
			interruption: true,
			truncate: false,
			inputs: { text: true, image: false },
			voices: [],
		}
		yield* Live.check(capabilities, Live.Input.Text({ text: "Hi" }))
		for (const input of [
			Live.Input.Image({ mediaType: "image/png", bytes: new Uint8Array() }),
			Live.Input.Commit(),
			Live.Input.Truncate({ itemId: "a", audioEndMs: 10 }),
		]) {
			const error = yield* Live.check(capabilities, input).pipe(Effect.flip)
			assert.strictEqual(error.reason, "unsupported")
		}
	}),
)
