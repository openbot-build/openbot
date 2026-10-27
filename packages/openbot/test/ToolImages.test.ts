import { assert, it } from "@effect/vitest"
import { Effect, Ref, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { imageKey, transformClient } from "../src/providers/ToolImages.ts"

/** A client that keeps the body of the last request, and reads it as JSON with a schema. */
const capture = Effect.gen(function* () {
	const body = yield* Ref.make("")
	const client = HttpClient.make((request) =>
		Effect.gen(function* () {
			const sent = request.body
			if (sent._tag === "Uint8Array")
				yield* Ref.set(body, new TextDecoder().decode(sent.body))
			return HttpClientResponse.fromWeb(request, new Response("{}"))
		}),
	)
	const read = <S extends Schema.Constraint>(schema: S) =>
		Effect.flatMap(
			Ref.get(body),
			Schema.decodeEffect(Schema.fromJsonString(schema)),
		)
	return { client, read }
})

/** The part of an Anthropic request that the test checks. */
const AnthropicBody = Schema.Struct({
	messages: Schema.Array(
		Schema.Struct({
			content: Schema.Array(Schema.Struct({ content: Schema.Unknown })),
		}),
	),
})

/** The part of an OpenAI request that the test checks. */
const OpenAiBody = Schema.Struct({
	input: Schema.Array(Schema.Struct({ output: Schema.Unknown })),
})

const result = JSON.stringify({
	width: 2,
	height: 1,
	[imageKey]: { mediaType: "image/png", data: "aW1n" },
})

it.effect(
	"an Anthropic tool result with an image is sent as an image block",
	() =>
		Effect.gen(function* () {
			const fake = yield* capture
			const client = transformClient("anthropic")(fake.client)
			yield* client.execute(
				HttpClientRequest.post("https://api.example.com/v1/messages").pipe(
					HttpClientRequest.bodyJsonUnsafe({
						messages: [
							{
								role: "user",
								content: [
									{ type: "tool_result", tool_use_id: "a", content: result },
									{ type: "tool_result", tool_use_id: "b", content: "plain" },
								],
							},
						],
					}),
				),
			)
			const sent = yield* fake.read(AnthropicBody)
			assert.deepStrictEqual(sent.messages[0]!.content[0]!.content, [
				{ type: "text", text: '{"width":2,"height":1}' },
				{
					type: "image",
					source: { type: "base64", media_type: "image/png", data: "aW1n" },
				},
			])
			assert.strictEqual(sent.messages[0]!.content[1]!.content, "plain")
		}),
)

it.effect("an OpenAI tool output with an image is sent as an image part", () =>
	Effect.gen(function* () {
		const fake = yield* capture
		const client = transformClient("openai")(fake.client)
		yield* client.execute(
			HttpClientRequest.post("https://api.example.com/v1/responses").pipe(
				HttpClientRequest.bodyJsonUnsafe({
					input: [
						{ type: "function_call_output", call_id: "a", output: result },
					],
				}),
			),
		)
		const sent = yield* fake.read(OpenAiBody)
		assert.deepStrictEqual(sent.input[0]!.output, [
			{ type: "input_text", text: '{"width":2,"height":1}' },
			{ type: "input_image", image_url: "data:image/png;base64,aW1n" },
		])
	}),
)
