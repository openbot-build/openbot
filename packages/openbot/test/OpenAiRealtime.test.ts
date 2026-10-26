import { assert, it } from "@effect/vitest"
import { Array as Arr, Effect, Fiber, Queue, Ref } from "effect"
import { Prompt } from "effect/ai"
import { TestClock } from "effect/testing"
import { Live } from "@openbot-build/core"
import * as OpenAiRealtime from "../src/providers/openai/OpenAiRealtime.ts"

const config: Live.Config = {
	instructions: "Be short.",
	tools: [
		{
			name: "Lookup",
			description: "Finds a word.",
			parameters: { type: "object" },
		},
	],
	voice: "marin",
	audio: {
		input: { encoding: "pcm16", sampleRate: 24000 },
		output: { encoding: "g711_ulaw", sampleRate: 8000 },
	},
	turnDetection: "server",
}

const event = (value: unknown) => JSON.stringify(value)

it("the session config asks for server turn detection without automatic answers", () => {
	const session = OpenAiRealtime.sessionOf(config)
	assert.strictEqual(session.instructions, "Be short.")
	assert.strictEqual(session.truncation, "disabled")
	assert.strictEqual(
		OpenAiRealtime.sessionOf({
			...config,
			providerOptions: { truncation: "auto" },
		}).truncation,
		"disabled",
	)
	assert.deepStrictEqual(session.audio.input.format, {
		type: "audio/pcm",
		rate: 24000,
	})
	assert.deepStrictEqual(session.audio.output.format, { type: "audio/pcmu" })
	assert.deepStrictEqual(session.audio.input.turn_detection, {
		type: "server_vad",
		create_response: false,
		interrupt_response: true,
	})
	assert.strictEqual(session.audio.output.voice, "marin")
	assert.deepStrictEqual(session.tools, [
		{
			type: "function",
			name: "Lookup",
			description: "Finds a word.",
			parameters: { type: "object" },
		},
	])
	assert.strictEqual(
		OpenAiRealtime.sessionOf({ ...config, turnDetection: "client" }).audio.input
			.turn_detection,
		null,
	)
})

it.effect(
	"portable context keeps tool work and images without starting a response",
	() =>
		Effect.gen(function* () {
			const prompt = Prompt.make([
				{
					role: "user",
					content: [Prompt.filePart({ mediaType: "image/png", data: "AQID" })],
				},
				{
					role: "assistant",
					content: [
						Prompt.toolCallPart({
							id: "call_1",
							name: "Lookup",
							params: { word: "tree" },
							providerExecuted: false,
						}),
					],
				},
				{
					role: "tool",
					content: [
						Prompt.toolResultPart({
							id: "call_1",
							name: "Lookup",
							result: "A plant",
							isFailure: false,
							providerExecuted: false,
						}),
					],
				},
			])
			const items = yield* Live.contextOf(prompt, OpenAiRealtime.capabilities)
			const encoded = OpenAiRealtime.encodeInput(
				Live.Input.Context({ id: "ctx", items }),
			)
			assert.deepStrictEqual(encoded, [
				{
					type: "conversation.item.create",
					item: {
						id: "ctx_0",
						type: "message",
						role: "user",
						content: [
							{ type: "input_image", image_url: "data:image/png;base64,AQID" },
						],
					},
				},
				{
					type: "conversation.item.create",
					item: {
						id: "ctx_1",
						type: "function_call",
						call_id: "call_1",
						name: "Lookup",
						arguments: '{"word":"tree"}',
					},
				},
				{
					type: "conversation.item.create",
					item: {
						id: "ctx_2",
						type: "function_call_output",
						call_id: "call_1",
						output: '"A plant"',
					},
				},
			])
		}),
)

it.effect(
	"context is ready only after configuration and every item are accepted",
	() =>
		Effect.gen(function* () {
			const writes = yield* Queue.unbounded<Live.Input>()
			const loaded = yield* Ref.make(false)
			const loader = yield* OpenAiRealtime.makeContextLoader((input) =>
				Queue.offer(writes, input).pipe(Effect.asVoid),
			)
			const prompt = Prompt.make([
				{ role: "user", content: "First" },
				{ role: "assistant", content: "Second" },
			])
			const fiber = yield* loader.load(prompt).pipe(
				Effect.tap(() => Ref.set(loaded, true)),
				Effect.forkScoped,
			)
			yield* loader.accept(event({ type: "session.updated" }))
			const input = yield* Queue.take(writes)
			assert.ok(input._tag === "Context")
			assert.strictEqual(yield* Ref.get(loaded), false)
			yield* loader.accept(
				event({
					type: "conversation.item.added",
					item: { id: OpenAiRealtime.contextItemId(input.id, 0) },
				}),
			)
			yield* loader.accept(
				event({
					type: "conversation.item.created",
					item: { id: "not_this_context" },
				}),
			)
			yield* loader.accept(
				event({
					type: "conversation.item.done",
					item: { id: OpenAiRealtime.contextItemId(input.id, 1) },
				}),
			)
			assert.strictEqual(yield* Ref.get(loaded), false)
			yield* loader.accept(
				event({
					type: "conversation.item.created",
					item: { id: OpenAiRealtime.contextItemId(input.id, 0) },
				}),
			)
			yield* Fiber.join(fiber)
			assert.strictEqual(yield* Ref.get(loaded), true)
			const repeated = yield* loader.load(prompt).pipe(Effect.flip)
			assert.strictEqual(repeated.reason, "protocol")
		}),
)

it.effect("a missing context acknowledgement fails the load", () =>
	Effect.gen(function* () {
		const writes = yield* Queue.unbounded<Live.Input>()
		const loader = yield* OpenAiRealtime.makeContextLoader(
			(input) => Queue.offer(writes, input).pipe(Effect.asVoid),
			100,
		)
		yield* loader.accept(event({ type: "session.updated" }))
		const fiber = yield* loader
			.load(Prompt.make("Keep this."))
			.pipe(Effect.flip, Effect.forkScoped)
		yield* Queue.take(writes)
		yield* TestClock.adjust("101 millis")
		const error = yield* Fiber.join(fiber)
		assert.strictEqual(error.reason, "protocol")
	}),
)

it.effect("provider refusal fails context loading without a retry", () =>
	Effect.gen(function* () {
		const writes = yield* Queue.unbounded<Live.Input>()
		const loader = yield* OpenAiRealtime.makeContextLoader((input) =>
			Queue.offer(writes, input).pipe(Effect.asVoid),
		)
		yield* loader.accept(event({ type: "session.updated" }))
		const fiber = yield* loader
			.load(Prompt.make("Keep this."))
			.pipe(Effect.flip, Effect.forkScoped)
		yield* Queue.take(writes)
		yield* loader.accept(
			event({ type: "error", error: { message: "Context is too large" } }),
		)
		const error = yield* Fiber.join(fiber)
		assert.strictEqual(error.reason, "provider")
		assert.strictEqual(error.message, "Context is too large")
	}),
)

it("inputs become Realtime client events", () => {
	assert.deepStrictEqual(
		OpenAiRealtime.encodeInput(
			Live.Input.Audio({ bytes: new Uint8Array([1, 2, 3]) }),
		),
		[{ type: "input_audio_buffer.append", audio: "AQID" }],
	)
	assert.deepStrictEqual(
		OpenAiRealtime.encodeInput(
			Live.Input.ToolResult({ callId: "call_1", output: '"ok"' }),
		),
		[
			{
				type: "conversation.item.create",
				item: {
					type: "function_call_output",
					call_id: "call_1",
					output: '"ok"',
				},
			},
		],
	)
	assert.deepStrictEqual(
		Arr.map(
			OpenAiRealtime.encodeInput(
				Live.Input.History({
					messages: [
						{ role: "user", text: "Hi" },
						{ role: "assistant", text: "Hello" },
					],
				}),
			),
			(value) => (value["item"] as { role: string }).role,
		),
		["user", "assistant"],
	)
	assert.deepStrictEqual(OpenAiRealtime.encodeInput(Live.Input.Respond()), [
		{ type: "response.create" },
	])
})

it.effect("Realtime server events become Live events", () =>
	Effect.gen(function* () {
		assert.deepStrictEqual(
			yield* OpenAiRealtime.decodeEvent(
				event({
					type: "conversation.item.input_audio_transcription.completed",
					item_id: "item_1",
					content_index: 0,
					transcript: "What time is it?",
				}),
			),
			[
				Live.Event.InputTranscript({
					itemId: "item_1",
					text: "What time is it?",
					final: true,
				}),
			],
		)
		const [audio] = yield* OpenAiRealtime.decodeEvent(
			event({
				type: "response.output_audio.delta",
				item_id: "a",
				delta: "AQID",
			}),
		)
		assert.ok(audio?._tag === "OutputAudio")
		assert.deepStrictEqual([...audio.bytes], [1, 2, 3])
		assert.deepStrictEqual(
			yield* OpenAiRealtime.decodeEvent(
				event({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						id: "fc_1",
						call_id: "call_1",
						name: "Lookup",
						arguments: '{"word":"sun"}',
					},
				}),
			),
			[
				Live.Event.ToolCall({
					callId: "call_1",
					name: "Lookup",
					arguments: '{"word":"sun"}',
				}),
			],
		)
		assert.deepStrictEqual(
			yield* OpenAiRealtime.decodeEvent(
				event({
					type: "response.done",
					response: {
						status: "completed",
						usage: {
							input_tokens: 30,
							output_tokens: 20,
							input_token_details: {
								text_tokens: 10,
								audio_tokens: 15,
								image_tokens: 0,
								cached_tokens: 5,
							},
							output_token_details: { text_tokens: 4, audio_tokens: 16 },
						},
					},
				}),
			),
			[
				Live.Event.ResponseDone({
					status: "completed",
					usage: {
						input: { text: 10, audio: 15, image: 0, cached: 5 },
						output: { text: 4, audio: 16 },
					},
				}),
			],
		)
		// A cancel when no answer runs is not a failure.
		assert.deepStrictEqual(
			yield* OpenAiRealtime.decodeEvent(
				event({
					type: "error",
					error: { code: "response_cancel_not_active", message: "No answer" },
				}),
			),
			[],
		)
		assert.deepStrictEqual(
			yield* OpenAiRealtime.decodeEvent(event({ type: "rate_limits.updated" })),
			[],
		)
		assert.deepStrictEqual(yield* OpenAiRealtime.decodeEvent("not json"), [])
	}),
)

it.effect(
	"a known Realtime event that OpenBot cannot read gives a protocol Failure",
	() =>
		Effect.gen(function* () {
			const texts = [
				event({ type: "response.done", response: null }),
				event({
					type: "response.output_audio.delta",
					item_id: "a",
					delta: "not base64!",
				}),
			]
			for (const text of texts) {
				const events = yield* OpenAiRealtime.decodeEvent(text)
				assert.strictEqual(events.length, 1)
				const [failure] = events
				assert.ok(failure?._tag === "Failure")
				assert.strictEqual(failure.error.reason, "protocol")
				assert.strictEqual(
					failure.error.message,
					"OpenAI Realtime sent an event that OpenBot cannot read.",
				)
			}
		}),
)

it("the WebSocket address comes from the endpoint of the provider", () => {
	assert.strictEqual(
		OpenAiRealtime.realtimeUrl(null, "gpt-realtime"),
		"wss://api.openai.com/v1/realtime?model=gpt-realtime",
	)
	assert.strictEqual(
		OpenAiRealtime.realtimeUrl("http://127.0.0.1:9000/v1/", "m"),
		"ws://127.0.0.1:9000/v1/realtime?model=m",
	)
})
