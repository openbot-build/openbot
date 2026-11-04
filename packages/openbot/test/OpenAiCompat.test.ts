import {
	Array as Arr,
	Cause,
	Option,
	Match,
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Redacted,
	Ref,
	Schema,
	Stream,
} from "effect"
import { assert, it } from "@effect/vitest"
import { OpenAiClient, OpenAiConfig } from "@effect/ai-openai-compat"
import { Execution } from "@openbot-build/domain"
import {
	CurrentModelReadFailure,
	FinalModelRead,
	fromCause,
	type ModelReadFailureReason,
} from "../src/models/ModelFailure.ts"

import {
	LanguageModel,
	Model as AiModel,
	Prompt,
	Tool,
	Toolkit,
} from "effect/ai"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Config, Model, Provider } from "@openbot-build/core"
import * as OpenAiCompatProvider from "../src/providers/openai-compat/OpenAiCompatProvider.ts"

const selection = Config.Selection.make({
	provider: Provider.Id.make("openai-compat"),
	model: Model.Id.make("chat-model"),
	reasoningEffort: "high",
	serviceTier: "priority",
})
const tools = Toolkit.make(
	Tool.make("echo", {
		description: "Echo text",
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.String,
	}),
)
const answer = {
	id: "chat_1",
	model: selection.model,
	created: 1,
	choices: [
		{
			index: 0,
			finish_reason: "stop",
			message: { role: "assistant", content: "answer" },
		},
	],
	usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}
const toolAnswer = {
	...answer,
	choices: [
		{
			index: 0,
			finish_reason: "tool_calls",
			message: {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "echo", arguments: '{"text":"hello"}' },
					},
				],
			},
		},
	],
}
const streamEvents = [
	{
		...answer,
		choices: [
			{
				index: 0,
				delta: { role: "assistant", content: "hello" },
				finish_reason: null,
			},
		],
	},
	{
		...answer,
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "echo", arguments: "" },
						},
					],
				},
				finish_reason: null,
			},
		],
	},
	{
		...answer,
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{ index: 0, function: { arguments: '{"text":"hello"}' } },
					],
				},
				finish_reason: null,
			},
		],
	},
	{
		...answer,
		choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
	},
]
const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const RequestBody = Schema.fromJsonString(Schema.JsonObject)
/** The stream events as the text of a server-sent event stream. */
const sse = Effect.map(
	Effect.forEach(streamEvents, (event) =>
		Effect.map(toJson(event), (data) => `data: ${data}\n\n`),
	),
	(events) => Arr.join(events, "") + "data: [DONE]\n\n",
)

it.effect(
	"the public Provider keeps identity, encodes options and continues after a tool runs",
	() =>
		Effect.gen(function* () {
			const requests = yield* Ref.make<ReadonlyArray<Schema.JsonObject>>([])
			const toolCalls = yield* Ref.make(0)
			const HttpClientTest = Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make((request, url) =>
					Effect.gen(function* () {
						assert.strictEqual(url.origin, "https://openai-compat.test")
						assert.strictEqual(url.pathname, "/v1/chat/completions")
						assert.strictEqual(
							request.headers["authorization"],
							"Bearer test-key",
						)
						assert.strictEqual(request.body._tag, "Uint8Array")
						return yield* Match.value(request.body).pipe(
							Match.tag("Uint8Array", (body) =>
								Effect.gen(function* () {
									const decoded = yield* Schema.decodeEffect(RequestBody)(
										new TextDecoder().decode(body.body),
									)
									const sent = yield* Ref.updateAndGet(
										requests,
										Arr.append(decoded),
									)
									return HttpClientResponse.fromWeb(
										request,
										new globalThis.Response(
											yield* toJson(sent.length === 1 ? toolAnswer : answer),
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
			const provider = OpenAiCompatProvider.make({
				max_output_tokens: 1024,
				reasoning_effort: "low",
				service_tier: "auto",
				custom_option: "retained",
			})
			assert.strictEqual(provider.id, "openai-compat")
			assert.strictEqual((yield* Ref.get(requests)).length, 0)
			yield* Effect.gen(function* () {
				const model = yield* provider.model(selection)
				assert.strictEqual((yield* Ref.get(requests)).length, 0)
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
				assert.strictEqual(yield* Ref.get(toolCalls), 1)
				const sent = yield* Ref.get(requests)
				assert.strictEqual(sent[0]!["model"], selection.model)
				assert.strictEqual(sent[0]!["max_tokens"], 1024)
				assert.strictEqual(sent[0]!["reasoning_effort"], "high")
				assert.strictEqual(sent[0]!["custom_option"], "retained")
				assert.strictEqual(sent[0]!["service_tier"], "priority")
				assert.match(yield* toJson(sent[0]), /Follow instructions/)
				assert.match(yield* toJson(sent[0]!["tools"]), /echo/)
				assert.match(yield* toJson(sent[1]!["messages"]), /tool_call_id/)
				assert.match(yield* toJson(sent[1]!["messages"]), /hello/)
				assert.strictEqual(sent[2]!["reasoning_effort"], "low")
				assert.strictEqual(sent[2]!["service_tier"], "auto")
			}).pipe(
				Effect.provide(
					Layer.merge(
						OpenAiCompatProvider.layerClient({
							apiUrl: "https://openai-compat.test/v1",
							apiKey: Redacted.make("test-key"),
						}).pipe(Layer.provide(HttpClientTest)),
						tools.toLayer({
							echo: ({ text }) =>
								Ref.update(toolCalls, (n) => n + 1).pipe(Effect.as(text)),
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
			const calls = yield* Ref.make(0)
			const cancelled = yield* Ref.make(false)
			const events = yield* sse
			const started = yield* Deferred.make<void>()
			const HttpClientTest = Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make((request) =>
					Ref.updateAndGet(calls, (n) => n + 1).pipe(
						Effect.flatMap((n) =>
							n === 2
								? Deferred.succeed(started, undefined).pipe(
										Effect.andThen(Effect.never),
										Effect.onInterrupt(() => Ref.set(cancelled, true)),
									)
								: Effect.succeed(
										HttpClientResponse.fromWeb(
											request,
											new globalThis.Response(events, {
												headers: { "content-type": "text/event-stream" },
											}),
										),
									),
						),
					),
				),
			)
			const model = yield* OpenAiCompatProvider.make().model(selection)
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
				assert.strictEqual(yield* Ref.get(cancelled), true)
			}).pipe(
				Effect.provide(
					Layer.merge(
						model,
						tools.toLayer({ echo: ({ text }) => Effect.succeed(text) }),
					).pipe(
						Layer.provide(
							OpenAiCompatProvider.layerClient({
								apiUrl: "https://openai-compat.test/v1",
							}).pipe(Layer.provide(HttpClientTest)),
						),
					),
				),
			)
		}),
)

const apiUrl = "https://model.test/v1"
const completionUrl = apiUrl + "/chat/completions"

it.effect(
	"an exact model route reports only gateway and network failures",
	() =>
		Effect.gen(function* () {
			for (const [mode, bodyError, expected] of [
				["504", null, "gateway_timeout"],
				["other model", null, null],
				["other URL", null, null],
				["redirect", null, null],
				["custom client", null, null],
				["scoped client", null, null],
				["socket reset", { code: "ECONNRESET" }, "socket_reset"],
				["body timeout", { code: "UND_ERR_BODY_TIMEOUT" }, "body_timeout"],
				["different MIME", { code: "ECONNRESET" }, null],
				["unknown error", { code: "OTHER" }, null],
				["abort", { code: "ABORT_ERR" }, null],
				["caller timeout", { name: "TimeoutError" }, null],
			] as const) {
				const http = Layer.succeed(
					HttpClient.HttpClient,
					HttpClient.make((request) =>
						Effect.sync(() => {
							const body =
								bodyError === null
									? null
									: new ReadableStream<Uint8Array>({
											start(controller) {
												controller.error(
													Object.assign(new Error("Read failed"), bodyError),
												)
											},
										})
							const response = new globalThis.Response(body, {
								status: bodyError === null ? 504 : 200,
								headers: {
									"content-type":
										mode === "different MIME"
											? "application/json"
											: "text/event-stream",
								},
							})
							if (mode === "redirect")
								Object.defineProperty(response, "url", {
									value: "https://other.test/chat/completions",
								})
							return HttpClientResponse.fromWeb(request, response)
						}),
					),
				)
				const pass = (client: HttpClient.HttpClient) => client
				const client = OpenAiCompatProvider.layerClient({
					apiUrl,
					modelReadRetryRoutes: [
						{
							completionUrl:
								mode === "other URL"
									? "https://other.test/chat/completions"
									: completionUrl,
							model: mode === "other model" ? "other" : selection.model,
						},
					],
					...(mode === "custom client" ? { transformClient: pass } : {}),
				}).pipe(Layer.provide(http))
				const reasons = yield* Ref.make<ReadonlyArray<ModelReadFailureReason>>(
					[],
				)
				const read = Effect.gen(function* () {
					const api = yield* OpenAiClient.OpenAiClient
					const [, stream] = yield* api.createResponseStream({
						model: selection.model,
						messages: [],
					})
					return yield* Stream.runDrain(stream)
				})
				yield* (
					mode === "scoped client"
						? OpenAiConfig.withClientTransform(read, pass)
						: read
				).pipe(
					Effect.provide(client),
					Effect.provideService(CurrentModelReadFailure, (reason) =>
						Ref.update(reasons, Arr.append(reason)),
					),
					Effect.flip,
				)
				assert.deepStrictEqual(
					yield* Ref.get(reasons),
					expected === null ? [] : [expected],
					mode,
				)
			}
		}),
)

it.effect("a change to the retry request is reported as not sent", () =>
	Effect.gen(function* () {
		const dispatches = yield* Ref.make(0)
		const sent = yield* Ref.make(false)
		const http = Layer.succeed(
			HttpClient.HttpClient,
			HttpClient.make((request) =>
				Ref.update(dispatches, (n) => n + 1).pipe(
					Effect.as(
						HttpClientResponse.fromWeb(
							request,
							new globalThis.Response(null, { status: 504 }),
						),
					),
				),
			),
		)
		const client = OpenAiCompatProvider.layerClient({
			apiUrl,
			modelReadRetryRoutes: [{ completionUrl, model: selection.model }],
		}).pipe(Layer.provide(http))
		const failure = {
			errorId: Execution.ErrorId.make("first-read"),
			category: "external" as const,
		}
		const error = yield* Effect.gen(function* () {
			const api = yield* OpenAiClient.OpenAiClient
			const [, stream] = yield* api.createResponseStream({
				model: selection.model,
				messages: [],
			})
			return yield* Stream.runDrain(stream)
		}).pipe(
			Effect.provide(client),
			Effect.provideService(FinalModelRead, {
				request: { url: completionUrl, body: '{"messages":["different"]}' },
				sent,
				failure,
			}),
			Effect.flip,
		)
		assert.deepStrictEqual(fromCause(Cause.fail(error)), Option.some(failure))
		assert.strictEqual(yield* Ref.get(dispatches), 0)
		assert.strictEqual(yield* Ref.get(sent), false)
	}),
)

it.effect("HTTP errors stay model errors", () =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const HttpClientTest = Layer.succeed(
			HttpClient.HttpClient,
			HttpClient.make((request) =>
				Ref.update(calls, (n) => n + 1).pipe(
					Effect.map(() =>
						HttpClientResponse.fromWeb(
							request,
							new globalThis.Response("Gateway unavailable", { status: 503 }),
						),
					),
				),
			),
		)
		const error = yield* Effect.gen(function* () {
			const model = yield* OpenAiCompatProvider.make().model(selection)
			return yield* LanguageModel.generateText({ prompt: "Hello." }).pipe(
				Effect.provide(model),
				Effect.flip,
			)
		}).pipe(
			Effect.provide(
				OpenAiCompatProvider.layerClient({}).pipe(
					Layer.provide(HttpClientTest),
				),
			),
		)
		assert.strictEqual(error._tag, "AiError")
		assert.strictEqual(yield* Ref.get(calls), 1)
	}),
)

it.effect(
	"provider Layers keep service identity with direct and pipeable optional defaults",
	() =>
		Effect.gen(function* () {
			class ProviderTest extends Context.Service<
				ProviderTest,
				OpenAiCompatProvider.Provider
			>()("@openbot-build/openbot/test/OpenAiCompat.test/ProviderTest") {}
			const defaults: OpenAiCompatProvider.Defaults = { temperature: 0.25 }
			const layers: ReadonlyArray<Layer.Layer<ProviderTest>> = [
				OpenAiCompatProvider.layer(ProviderTest),
				OpenAiCompatProvider.layer(ProviderTest, undefined),
				OpenAiCompatProvider.layer(ProviderTest, defaults),
				ProviderTest.pipe(OpenAiCompatProvider.layer()),
				ProviderTest.pipe(OpenAiCompatProvider.layer(undefined)),
				ProviderTest.pipe(OpenAiCompatProvider.layer(defaults)),
			]
			for (const layer of layers) {
				const provider = yield* ProviderTest.pipe(Effect.provide(layer))
				assert.strictEqual(provider.id, "openai-compat")
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
			const sent = yield* Ref.make<Schema.JsonObject>({})
			const HttpClientTest = Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make((request) =>
					Effect.gen(function* () {
						if (request.body._tag === "Uint8Array")
							yield* Ref.set(
								sent,
								yield* Schema.decodeEffect(RequestBody)(
									new TextDecoder().decode(request.body.body),
								).pipe(Effect.orDie),
							)
						return HttpClientResponse.fromWeb(
							request,
							new globalThis.Response("Gateway unavailable", { status: 503 }),
						)
					}),
				),
			)
			const name = yield* Effect.gen(function* () {
				const model = yield* OpenAiCompatProvider.make({
					upstreamModel: "upstream-name",
				}).model(selection)
				yield* LanguageModel.generateText({ prompt: "Hello." }).pipe(
					Effect.provide(model),
					Effect.exit,
				)
				return yield* AiModel.ModelName.pipe(Effect.provide(model))
			}).pipe(
				Effect.provide(
					OpenAiCompatProvider.layerClient({}).pipe(
						Layer.provide(HttpClientTest),
					),
				),
			)
			assert.strictEqual((yield* Ref.get(sent))["model"], "upstream-name")
			assert.strictEqual(name, selection.model)
		}),
)
