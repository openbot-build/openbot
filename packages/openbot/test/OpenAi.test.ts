// Each test owns the Layers that it provides at the point where it runs.
// @effect-diagnostics strictEffectProvide:off

import {
	Array as EffectArray,
	Match,
	Context,
	Effect,
	Fiber,
	Layer,
	Schema,
	Stream,
	Predicate,
} from "effect"
import { assert, it } from "@effect/vitest"

import {
	LanguageModel,
	Model as AiModel,
	Prompt,
	Tool,
	Toolkit,
} from "effect/ai"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { OpenAiClient, OpenAiConfig } from "@effect/ai-openai"
import { Config, ContextWindow, Model, Provider } from "@openbot-build/core"
import * as OpenAiProvider from "../src/providers/openai/OpenAiProvider.ts"
import * as ResponsesCompaction from "../src/providers/openai/ResponsesCompaction.ts"

const selection = Config.Selection.make({
	provider: Provider.Id.make("openai"),
	model: Model.Id.make("gpt-5.4"),
	reasoningEffort: "high",
})
const tools = Toolkit.make(
	Tool.make("echo", {
		description: "Echo text",
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.String,
	}),
)
const output = [
	{
		type: "message",
		id: "answer",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "answer", annotations: [] }],
	},
]
const nativeItems = [
	{
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: "retained user" }],
		extension: { keep: true },
	},
	{
		type: "compaction",
		id: "cmp_1",
		encrypted_content: "opaque.encrypted",
		extension: [1, 2],
	},
	{
		type: "reasoning",
		id: "rs_1",
		encrypted_content: "reasoning.encrypted",
		summary: [],
	},
] satisfies ReadonlyArray<Schema.JsonObject>
const response = {
	id: "response",
	object: "response",
	model: selection.model,
	created_at: 1,
	output,
}

it.effect(
	"generation, counting and compaction share encoded input, and the full native output stays for the next request",
	() =>
		Effect.gen(function* () {
			let requests: ReadonlyArray<{ path: string; body: Schema.JsonObject }> =
				[]
			let toolCalls = 0
			const HttpClientTest = Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make((request, url) =>
					Effect.sync(() => {
						assert.strictEqual(request.body._tag, "Uint8Array")
						const body = JSON.parse(
							new TextDecoder().decode(
								Match.value(request.body).pipe(
									Match.tag("Uint8Array", (body) => body.body),
									Match.orElse(() => new Uint8Array()),
								),
							),
						) as Schema.JsonObject
						requests = EffectArray.append(requests, {
							path: url.pathname,
							body,
						})
						if (body["stream"] === true) {
							assert.strictEqual(
								request.headers["x-sdk-transform"],
								"preserved",
							)
							const events = [
								{
									type: "response.created",
									response: { ...response, output: [] },
								},
								{
									type: "response.completed",
									response: { ...response, output: [] },
								},
							]
							return HttpClientResponse.fromWeb(
								request,
								new globalThis.Response(
									events
										.map((event) => `data: ${JSON.stringify(event)}\n\n`)
										.join(""),
									{ headers: { "content-type": "text/event-stream" } },
								),
							)
						}
						const payload = url.pathname.endsWith("input_tokens")
							? { input_tokens: 21, object: "response.input_tokens" }
							: url.pathname.endsWith("compact")
								? { object: "response.compaction", output: nativeItems }
								: response
						return HttpClientResponse.fromWeb(
							request,
							new globalThis.Response(JSON.stringify(payload), {
								headers: { "content-type": "application/json" },
							}),
						)
					}),
				),
			)
			yield* Effect.gen(function* () {
				const defaults = {
					instructions: "Use the shared request instructions.",
				}
				const provider = OpenAiProvider.make(defaults),
					model = yield* provider.model(selection),
					compaction = yield* ResponsesCompaction.make(defaults)
				const window = ContextWindow.fromPrompt(
					Prompt.make([
						{
							role: "user",
							content: [
								Prompt.textPart({ text: "hello" }),
								Prompt.filePart({
									mediaType: "image/png",
									data: Uint8Array.from([1, 2]),
								}),
							],
						},
					]),
				)
				const instructions = Prompt.make([
						{ role: "system", content: "You are helpful." },
					]),
					request = { selection, window, instructions, toolkit: tools }
				assert.strictEqual(yield* compaction.count(request), 21)
				const compacted = yield* compaction.compact(request)
				const result = yield* LanguageModel.generateText({
					prompt: Prompt.concat(instructions, window.prompt),
					toolkit: tools,
				}).pipe(
					Effect.provide(model),
					Effect.provideService(ContextWindow.CurrentWindow, window),
				)
				assert.strictEqual(result.text, "answer")
				assert.deepStrictEqual(
					requests[0]!.body["input"],
					requests[1]!.body["input"],
				)
				assert.deepStrictEqual(
					requests[0]!.body["input"],
					requests[2]!.body["input"],
				)
				assert.deepStrictEqual(
					requests[0]!.body["tools"],
					requests[2]!.body["tools"],
				)
				assert.strictEqual(
					requests[0]!.body["instructions"],
					defaults.instructions,
				)
				assert.strictEqual(
					requests[1]!.body["instructions"],
					defaults.instructions,
				)
				assert.strictEqual(
					requests[2]!.body["instructions"],
					defaults.instructions,
				)
				assert.strictEqual(
					Predicate.hasProperty(requests[1]!.body, "tools"),
					false,
				)
				assert.strictEqual(compacted._tag, "Native")
				return yield* Match.value(compacted).pipe(
					Match.tag("Native", (compacted) =>
						Effect.gen(function* () {
							assert.deepStrictEqual(compacted.items, nativeItems)
							const continued = ContextWindow.append(compacted, "continue")
							yield* compaction.count({ ...request, window: continued })
							yield* LanguageModel.generateText({
								prompt: Prompt.concat(instructions, continued.prompt),
								toolkit: tools,
							}).pipe(
								Effect.provide(model),
								Effect.provideService(ContextWindow.CurrentWindow, continued),
							)
							const input = requests.at(-1)!.body[
								"input"
							] as ReadonlyArray<Schema.Json>
							assert.deepStrictEqual(
								input.slice(0, nativeItems.length),
								nativeItems,
							)
							assert.deepStrictEqual(requests.at(-2)!.body["input"], input)
							yield* LanguageModel.streamText({
								prompt: Prompt.concat(instructions, continued.prompt),
								toolkit: tools,
							}).pipe(
								Stream.runDrain,
								OpenAiConfig.withClientTransform((http) =>
									HttpClient.mapRequest(http, (request) =>
										HttpClientRequest.setHeader(
											request,
											"x-sdk-transform",
											"preserved",
										),
									),
								),
								Effect.provide(model),
								Effect.provideService(ContextWindow.CurrentWindow, continued),
							)
							assert.deepStrictEqual(requests.at(-1)!.body["input"], input)
							assert.deepStrictEqual(
								requests.at(-1)!.body["tools"],
								requests.at(-2)!.body["tools"],
							)
							assert.deepStrictEqual(
								requests.map(({ path }) => path),
								[
									"/v1/responses/input_tokens",
									"/v1/responses/compact",
									"/v1/responses",
									"/v1/responses/input_tokens",
									"/v1/responses",
									"/v1/responses",
								],
							)
							assert.strictEqual(toolCalls, 0)
						}),
					),
					Match.orElse(() =>
						Effect.gen(function* () {
							throw new Error("Expected native compaction")
						}),
					),
				)
			}).pipe(
				Effect.provide(
					Layer.merge(
						OpenAiClient.layer({ apiUrl: "https://openai.test/v1" }).pipe(
							Layer.provide(HttpClientTest),
						),
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

it.effect("native SDK streaming runs a tool and keeps cancellation", () =>
	Effect.gen(function* () {
		let toolCalls = 0,
			requests = 0,
			cancelled = false
		const HttpClientTest = Layer.succeed(
			HttpClient.HttpClient,
			HttpClient.make((request) => {
				requests++
				if (requests === 2)
					return Effect.never.pipe(
						Effect.onInterrupt(() =>
							Effect.sync(() => {
								cancelled = true
							}),
						),
					)
				const events = [
					{ type: "response.created", response: { ...response, output: [] } },
					{
						type: "response.output_item.added",
						output_index: 0,
						item: {
							type: "function_call",
							id: "call_item",
							call_id: "call_1",
							name: "echo",
							arguments: "",
						},
					},
					{
						type: "response.function_call_arguments.delta",
						item_id: "call_item",
						output_index: 0,
						delta: '{"text":"hello"}',
					},
					{
						type: "response.function_call_arguments.done",
						item_id: "call_item",
						output_index: 0,
						arguments: '{"text":"hello"}',
						name: "echo",
					},
					{ type: "response.completed", response: { ...response, output: [] } },
				]
				const text = events
					.map((event) => `data: ${JSON.stringify(event)}\n\n`)
					.join("")
				return Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						new globalThis.Response(text, {
							headers: { "content-type": "text/event-stream" },
						}),
					),
				)
			}),
		)
		yield* Effect.gen(function* () {
			const model = yield* OpenAiProvider.make().model(selection)
			const events = yield* LanguageModel.streamText({
				prompt: "echo",
				toolkit: tools,
			}).pipe(Stream.runCollect, Effect.provide(model))
			assert.ok(events.some((part) => part.type === "tool-result"))
			assert.strictEqual(toolCalls, 1)
			const fiber = yield* LanguageModel.streamText({ prompt: "wait" }).pipe(
				Stream.runDrain,
				Effect.provide(model),
				Effect.forkChild,
			)
			yield* Effect.yieldNow
			yield* Fiber.interrupt(fiber)
			assert.strictEqual(cancelled, true)
		}).pipe(
			Effect.provide(
				Layer.merge(
					OpenAiClient.layer({ apiUrl: "https://openai.test/v1" }).pipe(
						Layer.provide(HttpClientTest),
					),
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
	"count and compaction report HTTP and response-schema failures and do not retry",
	() =>
		Effect.gen(function* () {
			for (const scenario of [
				{ status: 400, payload: { error: "bad request" } },
				{ status: 200, payload: { input_tokens: -1, output: "invalid" } },
			]) {
				let calls = 0
				const HttpClientTest = Layer.succeed(
					HttpClient.HttpClient,
					HttpClient.make((request) =>
						Effect.sync(() => {
							calls++
							return HttpClientResponse.fromWeb(
								request,
								new globalThis.Response(JSON.stringify(scenario.payload), {
									status: scenario.status,
									headers: { "content-type": "application/json" },
								}),
							)
						}),
					),
				)
				yield* Effect.gen(function* () {
					const service = yield* ResponsesCompaction.make()
					const request = {
						selection,
						window: ContextWindow.fromPrompt(Prompt.make("input")),
						instructions: Prompt.empty,
						toolkit: Toolkit.empty,
					}
					const countError = yield* service.count(request).pipe(Effect.flip)
					const compactError = yield* service.compact(request).pipe(Effect.flip)
					assert.strictEqual(countError.reason, "request-failed")
					assert.strictEqual(compactError.reason, "request-failed")
					assert.strictEqual(calls, 2)
				}).pipe(
					Effect.provide(
						OpenAiClient.layer({ apiUrl: "https://openai.test/v1" }).pipe(
							Layer.provide(HttpClientTest),
						),
					),
				)
			}
		}),
)

it.effect(
	"counting keeps transformed tool schemas and restricted tool choice without handlers",
	() =>
		Effect.gen(function* () {
			const toolkit = Toolkit.make(
				tools.tools.echo,
				Tool.make("convert", {
					description: "Convert a numeric string",
					parameters: Schema.Struct({ value: Schema.FiniteFromString }),
					success: Schema.Finite,
				}),
			)
			let bodies: ReadonlyArray<Schema.JsonObject> = []
			const HttpClientTest = Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make((request, url) =>
					Effect.gen(function* () {
						assert.strictEqual(request.body._tag, "Uint8Array")
						return yield* Match.value(request.body).pipe(
							Match.tag("Uint8Array", (body) =>
								Effect.gen(function* () {
									bodies = EffectArray.append(
										bodies,
										yield* Schema.decodeEffect(
											Schema.fromJsonString(Schema.JsonObject),
										)(new TextDecoder().decode(body.body)),
									)
									const payload = url.pathname.endsWith("input_tokens")
										? { input_tokens: 21 }
										: url.pathname.endsWith("compact")
											? { output: nativeItems }
											: response
									return HttpClientResponse.fromWeb(
										request,
										new globalThis.Response(JSON.stringify(payload), {
											headers: { "content-type": "application/json" },
										}),
									)
								}),
							),
							Match.orElse(() =>
								Effect.gen(function* () {
									throw new Error("Expected a JSON request")
								}),
							),
						)
					}).pipe(Effect.orDie),
				),
			)
			yield* Effect.gen(function* () {
				const service = yield* ResponsesCompaction.make()
				const model = yield* OpenAiProvider.make().model(selection)
				const request = {
					selection,
					window: ContextWindow.fromPrompt(Prompt.make("Convert 42")),
					instructions: Prompt.empty,
					toolkit,
					toolChoice: { mode: "required", oneOf: ["convert"] } as const,
				}
				// Count and compact do not need the tool handler Layer.
				yield* service.count(request)
				yield* service.compact(request)
				yield* LanguageModel.generateText({
					prompt: request.window.prompt,
					toolkit,
					toolChoice: request.toolChoice,
				}).pipe(
					Effect.provide(
						Layer.merge(
							model,
							toolkit.toLayer({
								echo: ({ text }) => Effect.succeed(text),
								convert: () =>
									Effect.die("Request encoding must not run a tool"),
							}),
						),
					),
				)
				assert.strictEqual(bodies.length, 3)
				assert.deepStrictEqual(bodies[0]!["input"], bodies[1]!["input"])
				assert.deepStrictEqual(bodies[0]!["input"], bodies[2]!["input"])
				assert.deepStrictEqual(bodies[0]!["tools"], bodies[2]!["tools"])
				assert.deepStrictEqual(
					bodies[0]!["tool_choice"],
					bodies[2]!["tool_choice"],
				)
				assert.strictEqual(Predicate.hasProperty(bodies[1]!, "tools"), false)
				const definitions = yield* Schema.decodeUnknownEffect(
					Schema.Array(Schema.JsonObject),
				)(bodies[0]!["tools"])
				assert.deepStrictEqual(
					definitions.map((tool) => tool["name"]),
					["convert"],
				)
			}).pipe(
				Effect.provide(
					OpenAiClient.layer({ apiUrl: "https://openai.test/v1" }).pipe(
						Layer.provide(HttpClientTest),
					),
				),
			)
		}),
)

it.effect(
	"window mismatches and SDK encoding failures fail before the request is sent",
	() =>
		Effect.gen(function* () {
			let calls = 0
			const HttpClientTest = Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make(() => {
					calls++
					return Effect.die("Invalid requests must not be sent")
				}),
			)
			const windows: ReadonlyArray<ContextWindow.Window> = [
				{
					_tag: "Native",
					provider: Provider.Id.make("other"),
					model: selection.model,
					items: nativeItems,
					prompt: Prompt.empty,
				},
				{
					_tag: "Native",
					provider: selection.provider,
					model: Model.Id.make("other"),
					items: nativeItems,
					prompt: Prompt.empty,
				},
				ContextWindow.fromPrompt(
					Prompt.make([
						{
							role: "user",
							content: [
								Prompt.filePart({
									mediaType: "application/zip",
									data: new Uint8Array([1]),
								}),
							],
						},
					]),
				),
			]
			yield* Effect.gen(function* () {
				const service = yield* ResponsesCompaction.make()
				const model = yield* OpenAiProvider.make().model(selection)
				for (const window of windows) {
					const request = {
						selection,
						window,
						instructions: Prompt.empty,
						toolkit: Toolkit.empty,
					}
					const countError = yield* service.count(request).pipe(Effect.flip)
					const compactError = yield* service.compact(request).pipe(Effect.flip)
					assert.strictEqual(countError.reason, "request-failed")
					assert.strictEqual(compactError.reason, "request-failed")
					const generatedError = yield* LanguageModel.generateText({
						prompt: window.prompt,
					}).pipe(
						Effect.provide(model),
						Effect.provideService(ContextWindow.CurrentWindow, window),
						Effect.flip,
					)
					const streamedError = yield* LanguageModel.streamText({
						prompt: window.prompt,
					}).pipe(
						Stream.runDrain,
						Effect.provide(model),
						Effect.provideService(ContextWindow.CurrentWindow, window),
						Effect.flip,
					)
					assert.strictEqual(generatedError.reason._tag, "InvalidRequestError")
					assert.strictEqual(streamedError.reason._tag, "InvalidRequestError")
				}
				assert.strictEqual(calls, 0)
			}).pipe(
				Effect.provide(
					OpenAiClient.layer({ apiUrl: "https://openai.test/v1" }).pipe(
						Layer.provide(HttpClientTest),
					),
				),
			)
		}),
)

it.effect(
	"provider Layers keep service identity with direct and pipeable optional defaults",
	() =>
		Effect.gen(function* () {
			class ProviderTest extends Context.Service<
				ProviderTest,
				OpenAiProvider.Provider
			>()("@openbot-build/openbot/test/OpenAi.test/ProviderTest") {}
			const defaults: OpenAiProvider.Defaults = { temperature: 0.25 }
			const layers: ReadonlyArray<Layer.Layer<ProviderTest>> = [
				OpenAiProvider.layer(ProviderTest),
				OpenAiProvider.layer(ProviderTest, undefined),
				OpenAiProvider.layer(ProviderTest, defaults),
				ProviderTest.pipe(OpenAiProvider.layer()),
				ProviderTest.pipe(OpenAiProvider.layer(undefined)),
				ProviderTest.pipe(OpenAiProvider.layer(defaults)),
			]
			for (const layer of layers) {
				const provider = yield* ProviderTest.pipe(Effect.provide(layer))
				assert.strictEqual(provider.id, "openai")
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
			const name = yield* Effect.gen(function* () {
				const model = yield* OpenAiProvider.make({
					upstreamModel: "upstream-name",
				}).model(selection)
				yield* LanguageModel.generateText({ prompt: "Hello." }).pipe(
					Effect.provide(model),
					Effect.exit,
				)
				return yield* AiModel.ModelName.pipe(Effect.provide(model))
			}).pipe(
				Effect.provide(
					OpenAiClient.layer({ apiUrl: "https://openai.test/v1" }).pipe(
						Layer.provide(HttpClientTest),
					),
				),
			)
			assert.strictEqual(
				(sent as { readonly model?: unknown }).model,
				"upstream-name",
			)
			assert.strictEqual(name, selection.model)
		}),
)
