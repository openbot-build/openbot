// Each test owns the Layers that it provides at the point where it runs.
// @effect-diagnostics strictEffectProvide:off

import {
	Array as EffectArray,
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
import assert from "node:assert/strict"
import { test } from "node:test"

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
const sse = streamEvents
	.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("")

test("the public Provider keeps identity, encodes options and continues after a tool runs", async () => {
	let requests: ReadonlyArray<Schema.JsonObject> = []
	let toolCalls = 0
	const HttpClientTest = Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request, url) =>
			Effect.gen(function* () {
				assert.equal(url.origin, "https://anthropic.test")
				assert.equal(url.pathname, "/v1/messages")
				assert.equal(request.headers["x-api-key"], "test-key")
				assert.equal(request.body._tag, "Uint8Array")
				return yield* Match.value(request.body).pipe(
					Match.tag("Uint8Array", (body) =>
						Effect.gen(function* () {
							requests = EffectArray.append(
								requests,
								yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
									JSON.parse(new TextDecoder().decode(body.body)),
								).pipe(Effect.orDie),
							)
							return HttpClientResponse.fromWeb(
								request,
								new globalThis.Response(
									JSON.stringify(requests.length === 1 ? toolAnswer : answer),
									{ headers: { "content-type": "application/json" } },
								),
							)
						}),
					),
					Match.orElse(() =>
						Effect.gen(function* () {
							throw new Error("Expected a JSON request")
						}),
					),
				)
			}),
		),
	)
	const provider = AnthropicProvider.make({
		max_tokens: 1024,
		output_config: { effort: "low" },
		service_tier: "auto",
	})
	assert.equal(provider.id, "anthropic")
	assert.equal(requests.length, 0)
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const model = yield* provider.model(selection)
				assert.equal(requests.length, 0)
				const prompt = Prompt.make([
					{ role: "system", content: "Follow instructions." },
					{ role: "user", content: "Echo hello." },
				])
				yield* Effect.gen(function* () {
					assert.equal(yield* AiModel.ProviderName, selection.provider)
					assert.equal(yield* AiModel.ModelName, selection.model)
					const first = yield* LanguageModel.generateText({
						prompt,
						toolkit: tools,
					})
					assert.equal(first.toolCalls.length, 1)
					assert.equal(first.toolResults[0]?.result, "hello")
					const second = yield* LanguageModel.generateText({
						prompt: Prompt.concat(
							prompt,
							Prompt.fromResponseParts(first.content),
						),
						toolkit: tools,
					})
					assert.equal(second.text, "answer")
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
				assert.equal(toolCalls, 1)
				assert.equal(requests[0]!["model"], selection.model)
				assert.equal(requests[0]!["max_tokens"], 1024)
				assert.deepEqual(requests[0]!["output_config"], { effort: "high" })
				assert.equal(requests[0]!["service_tier"], "standard_only")
				assert.match(JSON.stringify(requests[0]), /Follow instructions/)
				assert.match(JSON.stringify(requests[0]!["tools"]), /echo/)
				assert.match(JSON.stringify(requests[1]!["messages"]), /tool_result/)
				assert.match(JSON.stringify(requests[1]!["messages"]), /hello/)
				assert.deepEqual(requests[2]!["output_config"], { effort: "low" })
				assert.equal(requests[2]!["service_tier"], "auto")
			}),
		).pipe(
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
		),
	)
})

test("streamed text and tool results are visible, and cancellation interrupts HTTP work", async () => {
	let calls = 0,
		cancelled = false
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
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
								new globalThis.Response(sse, {
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
						parts.some(
							(part) => part.type === "text-delta" && part.delta === "hello",
						),
					)
					assert.ok(
						parts.some(
							(part) => part.type === "tool-result" && part.result === "hello",
						),
					)
					const fiber = yield* LanguageModel.streamText({
						prompt: "Wait.",
					}).pipe(Stream.runDrain, Effect.forkChild)
					yield* Deferred.await(started)
					yield* Fiber.interrupt(fiber)
					assert.equal(cancelled, true)
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
		),
	)
})

test("HTTP errors stay model errors", async () => {
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
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const model = yield* AnthropicProvider.make().model(selection)
			return yield* LanguageModel.generateText({ prompt: "Hello." }).pipe(
				Effect.provide(model),
				Effect.result,
			)
		}).pipe(
			Effect.provide(
				AnthropicProvider.layerClient({}).pipe(Layer.provide(HttpClientTest)),
			),
		),
	)
	assert.equal(result._tag, "Failure")
	return Match.value(result).pipe(
		Match.tag("Failure", (result) => {
			assert.equal(result.failure._tag, "AiError")
			assert.equal(calls, 1)
		}),
		Match.orElse(() => {
			throw new Error("Expected a model failure")
		}),
	)
})

test("unsupported selection options fail locally", async () => {
	for (const options of [
		{ reasoningEffort: "xhigh" },
		{ serviceTier: "priority" },
	]) {
		const result = await Effect.runPromise(
			AnthropicProvider.make()
				.model(Config.Selection.make({ ...selection, ...options }))
				.pipe(Effect.result),
		)
		assert.equal(result._tag, "Failure")
		Match.value(result).pipe(
			Match.tag("Failure", (result) =>
				assert.equal(result.failure.reason._tag, "InvalidRequestError"),
			),
			Match.orElse(() => {
				throw new Error("Expected invalid selection")
			}),
		)
	}
})

test("provider Layers keep service identity with direct and pipeable optional defaults", async () => {
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
		const provider = await Effect.runPromise(
			ProviderTest.pipe(Effect.provide(layer)),
		)
		assert.equal(provider.id, "anthropic")
		assert.equal(
			(await Effect.runPromise(provider.model(selection))).provider,
			selection.provider,
		)
	}
})

test("the API gets the upstream model name, and the model keeps the selected ID", async () => {
	let sent: unknown
	const HttpClientTest = Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request) => {
			if (request.body._tag === "Uint8Array")
				sent = JSON.parse(new TextDecoder().decode(request.body.body))
			return Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					new globalThis.Response("Gateway unavailable", { status: 503 }),
				),
			)
		}),
	)
	const name = await Effect.runPromise(
		Effect.gen(function* () {
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
		),
	)
	assert.equal((sent as { readonly model?: unknown }).model, "upstream-name")
	assert.equal(name, selection.model)
})
