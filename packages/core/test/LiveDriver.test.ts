import { assert, it } from "@effect/vitest"
import { Chat, Live, LiveDriver } from "@openbot-build/core"
import { Array as Arr, Effect, Option, PubSub, Ref, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { ChatTest } from "./ChatTest.ts"

const usage: Live.Usage = {
	input: { total: 15, text: 5, audio: 10, image: 0, cached: 2 },
	output: { total: 24, text: 4, audio: 20 },
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
		assert.strictEqual(turn.usage?.[0]?.inputTokens.uncached, 13)
		assert.strictEqual(turn.usage?.[0]?.inputTokens.cacheRead, 2)
		assert.strictEqual(turn.usage?.[0]?.outputTokens.total, 24)
		const tags = Arr.map(yield* Ref.get(inputs), (input) => input._tag)
		assert.deepStrictEqual(tags, ["Configure", "Text", "Respond"])
	}),
)

it.effect("a finished Live answer keeps missing usage unknown", () =>
	Effect.gen(function* () {
		const { driver } = yield* scripted([
			[
				Live.Event.OutputTranscript({ itemId: "answer", delta: "Hello" }),
				Live.Event.OutputDone({ itemId: "answer" }),
				Live.Event.ResponseDone({
					status: "completed",
					usage: {
						input: {
							total: undefined,
							text: 5,
							audio: 10,
							image: 0,
							cached: 2,
						},
						output: { total: undefined, text: 4, audio: 20 },
					},
				}),
			],
		])
		const answer = yield* driver.model.generateText({ prompt: "Hi" })
		assert.strictEqual(answer.text, "Hello")
		assert.isUndefined(answer.usage.inputTokens.total)
		assert.isUndefined(answer.usage.inputTokens.uncached)
		assert.isUndefined(answer.usage.outputTokens.total)
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

it.effect(
	"a new Live connection restores calls before sending their result and does not repeat text",
	() =>
		Effect.gen(function* () {
			const { driver, inputs } = yield* scripted([
				said("after-restart", "Done"),
			])
			const prompt = Prompt.make([
				{ role: "user", content: [{ type: "text", text: "Find the word" }] },
				{
					role: "assistant",
					content: [
						{
							type: "tool-call",
							id: "lookup",
							name: "Lookup",
							params: { word: "sun" },
							providerExecuted: false,
						},
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							id: "lookup",
							name: "Lookup",
							result: "a star",
							isFailure: false,
							providerExecuted: false,
						},
					],
				},
			])
			yield* driver.model.generateText({ prompt })
			const sent = yield* Ref.get(inputs)
			assert.deepStrictEqual(
				Arr.map(sent, (input) => input._tag),
				["Configure", "History", "ToolResult", "Respond"],
			)
			const restored = Arr.findFirst(sent, Live.Input.$is("History"))
			assert.ok(Option.isSome(restored))
			assert.deepStrictEqual(restored.value.messages, [
				{ role: "user", text: "Find the word" },
				{
					role: "assistant",
					callId: "openbot_history_call_0",
					name: "Lookup",
					arguments: '{"word":"sun"}',
				},
			])
			const fresh = yield* scripted([said("new", "Hello")])
			yield* fresh.driver.model.generateText({ prompt: "New input" })
			const once = yield* Ref.get(fresh.inputs)
			assert.deepStrictEqual(Arr.filter(once, Live.Input.$is("Text")), [
				Live.Input.Text({ text: "New input" }),
			])
			assert.strictEqual(Arr.filter(once, Live.Input.$is("History")).length, 0)
		}),
)

it.effect(
	"restored calls with the same provider ID keep separate results",
	() =>
		Effect.gen(function* () {
			const { driver, inputs } = yield* scripted([said("restored", "Done")])
			const call = (word: string) =>
				Prompt.makeMessage("assistant", {
					content: [
						Prompt.makePart("tool-call", {
							id: "same",
							name: "Lookup",
							params: { word },
							providerExecuted: false,
						}),
					],
				})
			const result = (value: string) =>
				Prompt.makeMessage("tool", {
					content: [
						Prompt.makePart("tool-result", {
							id: "same",
							name: "Lookup",
							result: value,
							isFailure: false,
							providerExecuted: false,
						}),
					],
				})
			yield* driver.model.generateText({
				prompt: Prompt.make([
					call("one"),
					result("first"),
					call("two"),
					result("second"),
				]),
			})
			const sent = yield* Ref.get(inputs)
			const history = Arr.findFirst(sent, Live.Input.$is("History"))
			assert.ok(Option.isSome(history))
			assert.deepStrictEqual(history.value.messages, [
				{
					role: "assistant",
					callId: "openbot_history_call_0",
					name: "Lookup",
					arguments: '{"word":"one"}',
				},
				{ role: "tool", callId: "openbot_history_call_0", output: '"first"' },
				{
					role: "assistant",
					callId: "openbot_history_call_1",
					name: "Lookup",
					arguments: '{"word":"two"}',
				},
			])
			assert.deepStrictEqual(Arr.filter(sent, Live.Input.$is("ToolResult")), [
				Live.Input.ToolResult({
					callId: "openbot_history_call_1",
					output: '"second"',
				}),
			])
		}),
)
