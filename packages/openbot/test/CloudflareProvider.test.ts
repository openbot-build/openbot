import { assert, it } from "@effect/vitest"
import { OpenAiClient } from "@effect/ai-openai-compat"
import { Array as Arr, Effect, Layer, Ref, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Provider from "../src/providers/openai-compat/OpenAiCompatProvider.ts"

const call = {
	id: "call-test",
	type: "function",
	function: { name: "echo", arguments: "{}" },
} as const
const messages = [
	{ role: "system", content: "Give a short answer." },
	{ role: "user", content: "Call echo." },
	{ role: "assistant", content: null, tool_calls: [call] },
	{ role: "tool", tool_call_id: call.id, content: "done" },
	{ role: "assistant", content: "Text stays", tool_calls: [call] },
	{ role: "assistant", content: null },
] as const
const answer = {
	id: "answer",
	model: "test-model",
	created: 1,
	choices: [
		{
			index: 0,
			finish_reason: "stop",
			message: { role: "assistant", content: "done" },
		},
	],
}
const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

for (const endpoint of [
	{
		url: "https://api.cloudflare.com/client/v4/accounts/test/ai/v1",
		changes: true,
	},
	{
		url: "https://api.cloudflare.com/client/v4/accounts/test/ai/v1/",
		changes: true,
	},
	{ url: "https://api.openai.com/v1", changes: false },
	{
		url: "https://api.cloudflare.com/client/v4/accounts/test/other/v1",
		changes: false,
	},
	{
		url: "https://api.cloudflare.com.other.test/client/v4/accounts/test/ai/v1",
		changes: false,
	},
]) {
	it.effect(`tool messages keep their form at ${endpoint.url}`, () =>
		Effect.gen(function* () {
			const requests = yield* Ref.make<ReadonlyArray<Schema.JsonObject>>([])
			const http = Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make((request) =>
					Effect.gen(function* () {
						if (request.body._tag !== "Uint8Array")
							return assert.fail("Expected a JSON body")
						const body = yield* Schema.decodeEffect(
							Schema.fromJsonString(Schema.JsonObject),
						)(new TextDecoder().decode(request.body.body))
						yield* Ref.update(requests, Arr.append(body))
						const data =
							body["stream"] === true
								? `data: ${yield* toJson({ ...answer, choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
								: yield* toJson(answer)
						return HttpClientResponse.fromWeb(
							request,
							new globalThis.Response(data, {
								headers: {
									"content-type":
										body["stream"] === true
											? "text/event-stream"
											: "application/json",
								},
							}),
						)
					}).pipe(Effect.orDie),
				),
			)
			yield* Effect.gen(function* () {
				const client = yield* OpenAiClient.OpenAiClient
				yield* client.createResponse({ model: "test-model", messages })
				const [, stream] = yield* client.createResponseStream({
					model: "test-model",
					messages,
				})
				yield* Stream.runDrain(stream)
			}).pipe(
				Effect.provide(
					Provider.layerClient({ apiUrl: endpoint.url }).pipe(
						Layer.provide(http),
					),
				),
			)
			const sent = yield* Ref.get(requests)
			assert.strictEqual(sent.length, 2)
			for (const request of sent)
				assert.deepStrictEqual(
					request["messages"],
					Arr.map(messages, (message, index) =>
						endpoint.changes && index === 2
							? { ...message, content: "" }
							: message,
					),
				)
			assert.strictEqual(messages[2].content, null)
		}),
	)
}
