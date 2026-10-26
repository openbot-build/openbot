import {
	Array as Arr,
	Match,
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Redacted,
	Schema,
	Stream,
} from "effect"
import { assert, it } from "@effect/vitest"

import {
	LanguageModel,
	Model as AiModel,
	Prompt,
	Tool,
	Toolkit,
} from "effect/ai"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Config, Model, Provider } from "@openbot-build/core"
import * as AnthropicProvider from "../src/providers/anthropic/AnthropicProvider.ts"

const selection = Config.Selection.make({
	provider: Provider.Id.make("anthropic"),
	model: Model.Id.make("claude-sonnet-4-5"),
	reasoningEffort: "high",
	serviceTier: "standard_only",
})
const tools = Toolkit.make(
	Tool.make("echo", {
		description: "Echo text",
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.String,
	}),
)
const usage = {
	input_tokens: 5,
	output_tokens: 2,
	cache_creation: null,
	cache_creation_input_tokens: null,
	cache_read_input_tokens: null,
	service_tier: "standard",
}
const answer = {
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: selection.model,
	content: [{ type: "text", text: "answer", citations: null }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage,
}
const toolAnswer = {
	...answer,
	content: [
		{ type: "tool_use", id: "call_1", name: "echo", input: { text: "hello" } },
	],
	stop_reason: "tool_use",
}
const streamEvents = [
	{
		type: "message_start",
		message: { ...answer, content: [], stop_reason: null },
	},
	{
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "", citations: null },
	},
	{
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "hello" },
	},
	{ type: "content_block_stop", index: 0 },
	{
		type: "content_block_start",
		index: 1,
		content_block: { type: "tool_use", id: "call_1", name: "echo", input: {} },
	},
	{
		type: "content_block_delta",
		index: 1,
		delta: { type: "input_json_delta", partial_json: '{"text":"hello"}' },
	},
	{ type: "content_block_stop", index: 1 },
	{
		type: "message_delta",
		delta: { stop_reason: "tool_use", stop_sequence: null },
		usage: { ...usage, output_tokens: 2 },
	},
	{ type: "message_stop" },
]
const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const RequestBody = Schema.fromJsonString(Schema.JsonObject)
/** The stream events as the text of a server-sent event stream. */
const sse = Effect.map(
	Effect.forEach(streamEvents, (event) =>
		Effect.map(
			toJson(event),
			(data) => `event: ${event.type}\ndata: ${data}\n\n`,
		),
	),
	Arr.join(""),
)

it.effect(
	"the public Provider keeps identity, encodes options and continues after a tool runs",
	() =>
		Effect.gen(function* () {
			let requests: ReadonlyArray<Schema.JsonObject> = []
			let toolCalls = 0
			const HttpClientTest = Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make((request, url) =>
					Effect.gen(function* () {
						assert.strictEqual(url.origin, "https://anthropic.test")
						assert.strictEqual(url.pathname, "/v1/messages")
						assert.strictEqual(request.headers["x-api-key"], "test-key")
						assert.strictEqual(request.body._tag, "Uint8Array")
						return yield* Match.value(request.body).pipe(
							Match.tag("Uint8Array", (body) =>
								Effect.gen(function* () {
									requests = Arr.append(
										requests,
										yield* Schema.decodeEffect(RequestBody)(
											new TextDecoder().decode(body.body),
										),
									)
									return HttpClientResponse.fromWeb(
										request,
										new globalThis.Response(
											yield* toJson(
												requests.length === 1 ? toolAnswer : answer,
											),
											{ headers: { "content-type": "application/json" } },
										),
									)
								}).pipe(Effect.orDie),
							),
							Match.orElse(() => assert.fail("Expected a JSON request")),
						)
					}),
				),
			)
			const provider = AnthropicProvider.make({
				max_tokens: 1024,
				output_config: { effort: "low" },
				service_tier: "auto",
			})
			assert.strictEqual(provider.id, "anthropic")
			assert.strictEqual(requests.length, 0)
			yield* Effect.gen(function* () {
				const model = yield* provider.model(selection)
				assert.strictEqual(requests.length, 0)
				const prompt = Prompt.make([
					{ role: "system", content: "Follow instructions." },
					{ role: "user", content: "Echo hello." },
				])
				yield* Effect.gen(function* () {
					assert.strictEqual(yield* AiModel.ProviderName, selection.provider)
					assert.strictEqual(yield* AiModel.ModelName, selection.model)
					const first = yield* LanguageModel.generateText({
						prompt,
						toolkit: tools,
					})
					assert.strictEqual(first.toolCalls.length, 1)
					assert.strictEqual(first.toolResults[0]?.result, "hello")
					const second = yield* LanguageModel.generateText({
						prompt: Prompt.concat(
							prompt,
							Prompt.fromResponseParts(first.content),
						),
						toolkit: tools,
					})
					assert.strictEqual(second.text, "answer")
				}).pipe(Effect.provide(model))
				const defaultModel = yield* provider.model(
					Config.Selection.make({
						provider: selection.provider,
						model: selection.model,
					}),
				)
				yield* LanguageModel.generateText({ prompt: "Use defaults." }).pipe(
					Effect.provide(defaultModel),
				)
				assert.strictEqual(toolCalls, 1)
				assert.strictEqual(requests[0]!["model"], selection.model)
				assert.strictEqual(requests[0]!["max_tokens"], 1024)
				assert.deepStrictEqual(requests[0]!["output_config"], {
					effort: "high",
				})
				assert.strictEqual(requests[0]!["service_tier"], "standard_only")
				assert.match(yield* toJson(requests[0]), /Follow instructions/)
				assert.match(yield* toJson(requests[0]!["tools"]), /echo/)
				assert.match(yield* toJson(requests[1]!["messages"]), /tool_result/)
				assert.match(yield* toJson(requests[1]!["messages"]), /hello/)
				assert.deepStrictEqual(requests[2]!["output_config"], { effort: "low" })
				assert.strictEqual(requests[2]!["service_tier"], "auto")
			}).pipe(
				Effect.provide(
					Layer.merge(
						AnthropicProvider.layerClient({
							apiUrl: "https://anthropic.test",
							apiKey: Redacted.make("test-key"),
						}).pipe(Layer.provide(HttpClientTest)),
						tools.toLayer({
							echo: ({ text }) =>
								Effect.sync(() => {
									toolCalls++
									return text
								}),
						}),
					),
				),
			)
		}),
)

it.effect(
	"streamed text and tool results are visible, and cancellation interrupts HTTP work",
	() =>
		Effect.gen(function* () {
			let calls = 0,
				cancelled = false
			const events = yield* sse
			const started = yield* Deferred.make<void>()
			const HttpClientTest = Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make((request) => {
					calls++
					if (calls === 2)
						return Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.onInterrupt(() =>
								Effect.sync(() => {
									cancelled = true
								}),
							),
						)
					return Effect.succeed(
						HttpClientResponse.fromWeb(
							request,
							new globalThis.Response(events, {
								headers: { "content-type": "text/event-stream" },
							}),
						),
					)
				}),
			)
			const model = yield* AnthropicProvider.make().model(selection)
			yield* Effect.gen(function* () {
				const parts = yield* LanguageModel.streamText({
					prompt: "Echo hello.",
					toolkit: tools,
				}).pipe(Stream.runCollect)
				assert.ok(
					Arr.some(
						parts,
						(part) => part.type === "text-delta" && part.delta === "hello",
					),
				)
				assert.ok(
					Arr.some(
						parts,
						(part) => part.type === "tool-result" && part.result === "hello",
					),
				)
				const fiber = yield* LanguageModel.streamText({
					prompt: "Wait.",
				}).pipe(Stream.runDrain, Effect.forkChild)
				yield* Deferred.await(started)
				yield* Fiber.interrupt(fiber)
				assert.strictEqual(cancelled, true)
			}).pipe(
				Effect.provide(
					Layer.merge(
						model,
						tools.toLayer({ echo: ({ text }) => Effect.succeed(text) }),
					).pipe(
						Layer.provide(
							AnthropicProvider.layerClient({
								apiUrl: "https://anthropic.test",
							}).pipe(Layer.provide(HttpClientTest)),
						),
					),
				),
			)
		}),
)

it.effect("HTTP errors stay model errors", () =>
	Effect.gen(function* () {
		let calls = 0
		const HttpClientTest = Layer.succeed(
			HttpClient.HttpClient,
			HttpClient.make((request) => {
				calls++
				return Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						new globalThis.Response("Gateway unavailable", { status: 503 }),
					),
				)
			}),
		)
		const error = yield* Effect.gen(function* () {
			const model = yield* AnthropicProvider.make().model(selection)
			return yield* LanguageModel.generateText({ prompt: "Hello." }).pipe(
				Effect.provide(model),
				Effect.flip,
			)
		}).pipe(
			Effect.provide(
				AnthropicProvider.layerClient({}).pipe(Layer.provide(HttpClientTest)),
			),
		)
		assert.strictEqual(error._tag, "AiError")
		assert.strictEqual(calls, 1)
	}),
)

it.effect("unsupported selection options fail locally", () =>
	Effect.gen(function* () {
		for (const options of [
			{ reasoningEffort: "xhigh" },
			{ serviceTier: "priority" },
		]) {
			const error = yield* AnthropicProvider.make()
				.model(Config.Selection.make({ ...selection, ...options }))
				.pipe(Effect.flip)
			assert.strictEqual(error.reason._tag, "InvalidRequestError")
		}
	}),
)

it.effect(
	"provider Layers keep service identity with direct and pipeable optional defaults",
	() =>
		Effect.gen(function* () {
			class ProviderTest extends Context.Service<
				ProviderTest,
				AnthropicProvider.Provider
			>()("@openbot-build/openbot/test/Anthropic.test/ProviderTest") {}
			const defaults: AnthropicProvider.Defaults = { temperature: 0.25 }
			const layers: ReadonlyArray<Layer.Layer<ProviderTest>> = [
				AnthropicProvider.layer(ProviderTest),
				AnthropicProvider.layer(ProviderTest, undefined),
				AnthropicProvider.layer(ProviderTest, defaults),
				ProviderTest.pipe(AnthropicProvider.layer()),
				ProviderTest.pipe(AnthropicProvider.layer(undefined)),
				ProviderTest.pipe(AnthropicProvider.layer(defaults)),
			]
			for (const layer of layers) {
				const provider = yield* ProviderTest.pipe(Effect.provide(layer))
				assert.strictEqual(provider.id, "anthropic")
				assert.strictEqual(
					(yield* provider.model(selection)).provider,
					selection.provider,
				)
			}
		}),
)

it.effect(
	"the API gets the upstream model name, and the model keeps the selected ID",
	() =>
		Effect.gen(function* () {
			let sent: Schema.JsonObject = {}
			const HttpClientTest = Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make((request) =>
					Effect.gen(function* () {
						if (request.body._tag === "Uint8Array")
							sent = yield* Schema.decodeEffect(RequestBody)(
								new TextDecoder().decode(request.body.body),
							).pipe(Effect.orDie)
						return HttpClientResponse.fromWeb(
							request,
							new globalThis.Response("Gateway unavailable", { status: 503 }),
						)
					}),
				),
			)
			const name = yield* Effect.gen(function* () {
				const model = yield* AnthropicProvider.make({
					upstreamModel: "upstream-name",
				}).model(selection)
				yield* LanguageModel.generateText({ prompt: "Hello." }).pipe(
					Effect.provide(model),
					Effect.exit,
				)
				return yield* AiModel.ModelName.pipe(Effect.provide(model))
			}).pipe(
				Effect.provide(
					AnthropicProvider.layerClient({}).pipe(Layer.provide(HttpClientTest)),
				),
			)
			assert.strictEqual(sent["model"], "upstream-name")
			assert.strictEqual(name, selection.model)
		}),
)
