import { assert, it } from "@effect/vitest"
import { Chat, Live, LiveDriver } from "@openbot-build/core"
import { Array as Arr, Effect, Option, PubSub, Ref, Schema } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/ai"
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

it.effect("a Turn answers through the Live connection", () =>
	Effect.gen(function* () {
		const { driver, inputs } = yield* scripted([said("answer_1", "Hello")])
		const { runtime, chat } = yield* ChatTest()
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
		const { runtime, chat } = yield* ChatTest()
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
		const { runtime, chat } = yield* ChatTest({ toolkit })
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
		const { runtime, chat } = yield* ChatTest()
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

it("unsupported inputs are found from the capabilities", () => {
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
	assert.strictEqual(
		Live.unsupported(capabilities, Live.Input.Text({ text: "Hi" })),
		undefined,
	)
	assert.strictEqual(
		Live.unsupported(
			capabilities,
			Live.Input.Image({ mediaType: "image/png", bytes: new Uint8Array() }),
		)?.reason,
		"unsupported",
	)
	assert.ok(Live.unsupported(capabilities, Live.Input.Commit()))
	assert.ok(
		Live.unsupported(
			capabilities,
			Live.Input.Truncate({ itemId: "a", audioEndMs: 10 }),
		),
	)
})
