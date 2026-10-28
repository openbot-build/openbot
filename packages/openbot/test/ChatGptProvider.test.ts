import { Execution } from "@openbot-build/domain"
import {
	ModelProviders,
	organizationOwner,
	platformOwner,
	type Stored,
} from "../src/models/ModelProviders.ts"
import { Models } from "../src/models/Models.ts"
import { ProviderOAuth } from "../src/models/ProviderOAuth.ts"
import * as ModelRegistry from "../src/models/ModelRegistry.ts"
import * as LiveBackends from "../src/models/LiveBackends.ts"
import {
	Billing,
	SpendingBlocked,
	type Call,
	type Tokens,
} from "../src/billing/Billing.ts"
import { attribute } from "../src/billing/MeteredModel.ts"
import { TokenThrottle } from "../src/billing/TokenThrottle.ts"
import { Settings } from "../src/settings/Settings.ts"
import { organizationDefaults } from "../src/settings/Documents.ts"
import * as ErrorRecordsFixture from "./ErrorRecordsFixture.ts"
import { assert, it } from "@effect/vitest"
import { Config, ContextWindow, Model, Provider } from "@openbot-build/core"
import {
	Array as Arr,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Redacted,
	Ref,
	Schema,
	Stream,
} from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as ChatGptProvider from "../src/providers/chatgpt/ChatGptProvider.ts"

const selection = Config.Selection.make({
	provider: Provider.Id.make("prov_chatgpt"),
	model: Model.Id.make("test-model"),
})
const accessToken = Effect.succeed(Redacted.make("test-access"))
const nativeReasoning = {
	type: "reasoning",
	id: "retained-reasoning",
	encrypted_content: "retained.encrypted",
	summary: [],
}
const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const fromJson = Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))
const isObjectFormat = Schema.is(
	Schema.Struct({
		format: Schema.Struct({ type: Schema.Literal("json_schema") }),
	}),
)
const message = (text: string) => ({
	type: "message",
	id: "answer",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text, annotations: [] }],
})
const answer = (text: string) => ({
	id: "response",
	object: "response",
	model: selection.model,
	created_at: 1,
	output: [message(text)],
	usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
})
const eventsText = (events: ReadonlyArray<unknown>) =>
	Effect.forEach(events, (event) =>
		Effect.map(toJson(event), (data) => `data: ${data}\n\n`),
	).pipe(Effect.map(Arr.join("")))

interface Sent {
	readonly url: string
	readonly authorization: string | undefined
	readonly body: Schema.JsonObject
}

const http = (
	sent: Ref.Ref<ReadonlyArray<Sent>>,
	events: (body: Schema.JsonObject) => ReadonlyArray<unknown>,
) =>
	Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request, url) =>
			Effect.gen(function* () {
				if (request.body._tag !== "Uint8Array")
					return assert.fail("Expected a JSON request")
				const body = yield* fromJson(
					new TextDecoder().decode(request.body.body),
				)
				yield* Ref.update(
					sent,
					Arr.append({
						url: url.toString(),
						authorization: request.headers["authorization"],
						body,
					}),
				)
				return HttpClientResponse.fromWeb(
					request,
					new globalThis.Response(yield* eventsText(events(body)), {
						headers: { "content-type": "text/event-stream" },
					}),
				)
			}).pipe(Effect.orDie),
		),
	)

it.effect(
	"text and objects use streams and read the current access token",
	() =>
		Effect.gen(function* () {
			const sent = yield* Ref.make<ReadonlyArray<Sent>>([])
			const tokens = yield* Ref.make(0)
			const currentToken = Ref.updateAndGet(tokens, (count) => count + 1).pipe(
				Effect.map((count) => Redacted.make(`test-access-${count}`)),
			)
			const model = ChatGptProvider.layer(selection, {
				accessToken: currentToken,
				upstreamModel: "upstream-model",
			}).pipe(
				Layer.provide(
					http(sent, (body) => [
						{
							type: "response.completed",
							response: answer(
								isObjectFormat(body["text"]) ? '{"value":"done"}' : "done",
							),
						},
					]),
				),
			)
			yield* Effect.gen(function* () {
				const text = yield* LanguageModel.generateText({
					prompt: Prompt.make([
						{
							role: "user",
							content: [
								Prompt.textPart({ text: "Hello" }),
								Prompt.filePart({
									mediaType: "image/png",
									data: Uint8Array.from([1, 2]),
								}),
							],
						},
					]),
				}).pipe(
					Effect.provideService(ContextWindow.CurrentWindow, {
						_tag: "Native",
						provider: selection.provider,
						model: selection.model,
						items: [nativeReasoning],
						prompt: Prompt.empty,
					}),
				)
				assert.strictEqual(text.text, "done")
				assert.strictEqual(text.usage.inputTokens.total, 8)
				const object = yield* LanguageModel.generateObject({
					prompt: "Give a value",
					objectName: "answer",
					schema: Schema.Struct({ value: Schema.String }),
				})
				assert.deepStrictEqual(object.value, { value: "done" })
			}).pipe(Effect.provide(model))
			const requests = yield* Ref.get(sent)
			assert.strictEqual(requests.length, 2)
			const firstInput = requests[0]!.body[
				"input"
			] as ReadonlyArray<Schema.Json>
			assert.deepStrictEqual(firstInput[0], nativeReasoning)
			assert.include(yield* toJson(firstInput), "data:image/png;base64,AQI=")
			assert.deepStrictEqual(
				Arr.map(requests, (request) => request.authorization),
				["Bearer test-access-1", "Bearer test-access-2"],
			)
			for (const request of requests) {
				assert.strictEqual(request.url, "https://api.openai.com/v1/responses")
				assert.strictEqual(request.body["model"], "upstream-model")
				assert.strictEqual(request.body["stream"], true)
				assert.strictEqual(request.body["store"], false)
			}
		}),
)

it.effect("requests keep history and put local tools in a namespace", () =>
	Effect.gen(function* () {
		const sent = yield* Ref.make<ReadonlyArray<Sent>>([])
		const client = yield* ChatGptProvider.makeClient({ accessToken }).pipe(
			Effect.provide(
				http(sent, () => [
					{ type: "response.completed", response: answer("done") },
				]),
			),
		)
		const history = [
			{
				type: "message" as const,
				role: "system" as const,
				content: [{ type: "input_text" as const, text: "Be brief" }],
			},
			{
				type: "function_call" as const,
				call_id: "old-call",
				name: "echo",
				arguments: '{"text":"old"}',
			},
			{
				type: "function_call_output" as const,
				call_id: "old-call",
				output: "old",
			},
		] as const
		yield* client.createResponse({
			model: selection.model,
			input: history,
			tools: [
				{
					type: "function",
					name: "echo",
					parameters: { type: "object", properties: {} },
				},
			],
			temperature: 0.5,
			top_p: 0.5,
			max_output_tokens: 20,
			previous_response_id: "old-response",
		})
		const [request] = yield* Ref.get(sent)
		assert.isDefined(request)
		const input = request!.body["input"]
		assert.isArray(input)
		assert.deepStrictEqual(Arr.drop(input as ReadonlyArray<Schema.Json>, 1), [
			{ ...history[1], namespace: "openbot" },
			history[2],
		])
		assert.notInclude(yield* toJson(input), '"role":"system"')
		assert.include(yield* toJson(input), "Be brief")
		for (const field of [
			"temperature",
			"top_p",
			"max_output_tokens",
			"previous_response_id",
		])
			assert.notProperty(request!.body, field)
		const tools = request!.body["tools"] as ReadonlyArray<Schema.JsonObject>
		assert.strictEqual(tools[0]?.["type"], "namespace")
		assert.include(yield* toJson(tools[0]?.["tools"]), '"name":"echo"')
	}),
)

it.effect("function calls still run the local tool handler", () =>
	Effect.gen(function* () {
		const sent = yield* Ref.make<ReadonlyArray<Sent>>([])
		const calls = yield* Ref.make<ReadonlyArray<string>>([])
		const tools = Toolkit.make(
			Tool.make("echo", {
				description: "Return the text",
				parameters: Schema.Struct({ text: Schema.String }),
				success: Schema.String,
			}),
		)
		const model = ChatGptProvider.layer(selection, { accessToken }).pipe(
			Layer.provide(
				http(sent, () => [
					{
						type: "response.completed",
						response: {
							...answer(""),
							output: [
								{
									type: "function_call",
									id: "call-item",
									call_id: "call-one",
									name: "echo",
									arguments: '{"text":"hello"}',
								},
							],
						},
					},
				]),
			),
		)
		const result = yield* LanguageModel.generateText({
			prompt: "Call echo",
			toolkit: tools,
		}).pipe(
			Effect.provide(
				Layer.merge(
					model,
					tools.toLayer({
						echo: ({ text }) =>
							Ref.update(calls, Arr.append(text)).pipe(Effect.as(text)),
					}),
				),
			),
		)
		assert.deepStrictEqual(yield* Ref.get(calls), ["hello"])
		assert.strictEqual(result.finishReason, "tool-calls")
		assert.strictEqual(result.toolResults[0]?.result, "hello")
	}),
)

it.effect("streamed text keeps its parts and token counts", () =>
	Effect.gen(function* () {
		const sent = yield* Ref.make<ReadonlyArray<Sent>>([])
		const response = answer("done")
		const parts = yield* LanguageModel.streamText({ prompt: "Hello" }).pipe(
			Stream.runCollect,
			Effect.provide(
				ChatGptProvider.layer(selection, { accessToken }).pipe(
					Layer.provide(
						http(sent, () => [
							{
								type: "response.created",
								response: { ...response, output: [] },
							},
							{
								type: "response.output_item.added",
								output_index: 0,
								item: message(""),
							},
							{
								type: "response.output_text.delta",
								item_id: "answer",
								output_index: 0,
								content_index: 0,
								delta: "done",
							},
							{
								type: "response.output_item.done",
								output_index: 0,
								item: message("done"),
							},
							{ type: "response.completed", response },
						]),
					),
				),
			),
		)
		assert.deepStrictEqual(
			Arr.map(
				Arr.filter(parts, (part) => part.type === "text-delta"),
				(part) => part.delta,
			),
			["done"],
		)
		const finish = Arr.findFirst(parts, (part) => part.type === "finish")
		assert.strictEqual(finish._tag, "Some")
		if (finish._tag === "Some" && finish.value.type === "finish")
			assert.strictEqual(finish.value.usage.outputTokens.total, 3)
	}),
)

for (const end of [
	"response.failed",
	"response.incomplete",
	"missing",
] as const) {
	it.effect(`a ${end} end does not count as a full response`, () =>
		Effect.gen(function* () {
			const sent = yield* Ref.make<ReadonlyArray<Sent>>([])
			const events = [
				{ type: "response.created", response: { ...answer(""), output: [] } },
				...(end === "missing"
					? []
					: [
							{
								type: end,
								response: {
									...answer("partial"),
									...(end === "response.failed"
										? {
												error: {
													code: "subscription_sharing_usage_limit_exceeded",
													message: "The limit was reached",
												},
											}
										: { incomplete_details: { reason: "max_output_tokens" } }),
								},
							},
						]),
			]
			const model = ChatGptProvider.layer(selection, { accessToken }).pipe(
				Layer.provide(http(sent, () => events)),
			)
			const normal = yield* LanguageModel.generateText({
				prompt: "Hello",
			}).pipe(Effect.flip, Effect.provide(model))
			assert.strictEqual(normal._tag, "AiError")
			const streamed = yield* LanguageModel.streamText({
				prompt: "Hello",
			}).pipe(Stream.runDrain, Effect.flip, Effect.provide(model))
			assert.strictEqual(streamed._tag, "AiError")
			if (end === "response.failed")
				for (const error of [normal, streamed]) {
					assert.strictEqual(error.reason._tag, "QuotaExhaustedError")
					assert.strictEqual(error.reason.isRetryable, false)
				}
		}),
	)
}

it.effect("canceling a stream closes the response body", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const bytes = new TextEncoder().encode(
			yield* eventsText([{ type: "response.created", response: answer("") }]),
		)
		let cancelled = false
		const client = Layer.succeed(
			HttpClient.HttpClient,
			HttpClient.make((request) =>
				Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						new globalThis.Response(
							new ReadableStream<Uint8Array>({
								start: (controller) => controller.enqueue(bytes),
								cancel: () => {
									cancelled = true
								},
							}),
							{ headers: { "content-type": "text/event-stream" } },
						),
					),
				),
			),
		)
		const fiber = yield* LanguageModel.streamText({ prompt: "Wait" }).pipe(
			Stream.tap(() => Deferred.succeed(started, undefined)),
			Stream.runDrain,
			Effect.provide(
				ChatGptProvider.layer(selection, { accessToken }).pipe(
					Layer.provide(client),
				),
			),
			Effect.forkChild,
		)
		yield* Deferred.await(started)
		yield* Fiber.interrupt(fiber)
		assert.strictEqual(cancelled, true)
	}),
)

it.effect(
	"the registry shares provider tokens and meters calls from each source",
	() =>
		Effect.gen(function* () {
			for (const owner of [organizationOwner("org"), platformOwner]) {
				const sent = yield* Ref.make<ReadonlyArray<Sent>>([])
				const calls = yield* Ref.make<ReadonlyArray<Call>>([])
				const counts = yield* Ref.make<ReadonlyArray<Tokens>>([])
				const tokenReads = yield* Ref.make(0)
				const blocked = yield* Ref.make(false)
				const provider: Stored = {
					id: selection.provider,
					owner,
					kind: "chatgpt",
					name: "ChatGPT",
					endpoint: null,
					apiKey: null,
					apiKeyHint: null,
					version: 1,
					createdAt: 1,
					updatedAt: 1,
					availability: owner.kind === "platform" ? { _tag: "All" } : null,
					models: [
						{
							model: selection.model,
							modelOwner: owner.kind,
							upstream: "upstream",
						},
					],
				}
				const registry = ModelRegistry.layer().pipe(
					Layer.provide([
						Layer.mock(ModelProviders, {
							available: (org) =>
								Effect.succeed(org === "org" ? [provider] : []),
						}),
						Layer.mock(Models, {
							available: () =>
								Effect.succeed([
									{
										id: selection.model,
										owner,
										type: "language",
										name: "Test model",
										reasoningEfforts: [],
										serviceTiers: [],
										contextWindow: null,
										maxOutputTokens: null,
										availability: null,
										version: 1,
										createdAt: 1,
										updatedAt: 1,
									},
								]),
						}),
						Layer.mock(ProviderOAuth, {
							accessToken: (id) => {
								assert.strictEqual(id, provider.id)
								return Ref.updateAndGet(tokenReads, (count) => count + 1).pipe(
									Effect.map((count) => Redacted.make("shared-" + count)),
								)
							},
						}),
						Layer.mock(Settings, {
							organization: () =>
								Effect.succeed({
									document: {
										...organizationDefaults,
										rulesModel: selection,
										botMemoryModel: selection,
									},
									version: 1,
									updatedAt: 1,
								}),
							changes: Stream.empty,
						}),
						Layer.mock(Billing, {
							reserve: (call) =>
								Effect.gen(function* () {
									if (yield* Ref.get(blocked))
										return yield* SpendingBlocked.make({
											reason: "credits",
											message: "No credits.",
										})
									yield* Ref.update(calls, Arr.append(call))
									return { id: Execution.CallId.make("call"), startedAt: 0 }
								}),
							record: (_id, tokens) => Ref.update(counts, Arr.append(tokens)),
							unknown: () => Effect.void,
						}),
						Layer.mock(TokenThrottle, {
							scopes: () => Effect.succeed([]),
							take: () => Effect.void,
							charge: () => Effect.succeed(0),
						}),
						LiveBackends.layer([]),
						ErrorRecordsFixture.layer,
						http(sent, () => [
							{ type: "response.completed", response: answer("done") },
						]),
					]),
				)
				yield* Effect.gen(function* () {
					const models = yield* ModelRegistry.ModelRegistry
					const chat = yield* models.resolve("org", selection)
					const rules = yield* models.rulesModel("org")
					assert.strictEqual(rules._tag, "Language")
					if (rules._tag !== "Language")
						return assert.fail("Expected a language model.")
					const memory = yield* models.botMemoryModel("org")
					for (const [model, source, userId] of [
						[chat, "other", "alice"],
						[chat, "other", "bob"],
						[rules.model, "judge", "alice"],
						[memory, "bot_memory", "bob"],
					] as const) {
						yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
							Effect.provideService(LanguageModel.LanguageModel, model),
							attribute({ source, userId }),
						)
					}
					assert.strictEqual((yield* Ref.get(calls)).length, 4)
					assert.ok(
						Arr.every(
							yield* Ref.get(calls),
							(call) =>
								call.providerId === provider.id &&
								call.providerOwner === owner.kind,
						),
					)
					assert.ok(
						Arr.every(
							yield* Ref.get(counts),
							(count) => count.inputUncached === 8 && count.outputText === 3,
						),
					)
					assert.strictEqual(yield* Ref.get(tokenReads), 4)
					yield* Ref.set(blocked, true)
					const error = yield* LanguageModel.generateText({
						prompt: "Hello",
					}).pipe(
						Effect.provideService(LanguageModel.LanguageModel, chat),
						Effect.flip,
					)
					assert.strictEqual(error.reason._tag, "QuotaExhaustedError")
					assert.strictEqual((yield* Ref.get(sent)).length, 4)
					assert.strictEqual(
						(yield* models.resolve("other", selection).pipe(Effect.flip))
							.reason,
						"provider-not-found",
					)
				}).pipe(Effect.provide(registry))
			}
		}).pipe(Effect.scoped),
)

it.effect("only a rejected access token changes the sign-in state", () =>
	Effect.gen(function* () {
		for (const status of [401, 503]) {
			const rejected = yield* Ref.make(0)
			const model = ChatGptProvider.layer(selection, {
				accessToken,
				onUnauthorized: (token) => {
					assert.strictEqual(Redacted.value(token), "test-access")
					return Ref.update(rejected, (count) => count + 1)
				},
			}).pipe(
				Layer.provide(
					Layer.succeed(
						HttpClient.HttpClient,
						HttpClient.make((request) =>
							Effect.succeed(
								HttpClientResponse.fromWeb(
									request,
									new globalThis.Response(
										'{"error":{"message":"Request refused","type":"error","param":null,"code":"invalid_api_key"}}',
										{ status, headers: { "content-type": "application/json" } },
									),
								),
							),
						),
					),
				),
			)
			yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
				Effect.flip,
				Effect.provide(model),
			)
			assert.strictEqual(yield* Ref.get(rejected), status === 401 ? 1 : 0)
		}
	}),
)
