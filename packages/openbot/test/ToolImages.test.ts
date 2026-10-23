import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { imageKey, transformClient } from "../src/providers/ToolImages.ts"

/** A client that keeps the JSON body of the last request. */
const capture = () => {
	let body: unknown
	const client = HttpClient.make((request) =>
		Effect.sync(() => {
			const sent = request.body
			if (sent._tag === "Uint8Array")
				body = JSON.parse(new TextDecoder().decode(sent.body))
			return HttpClientResponse.fromWeb(request, new Response("{}"))
		}),
	)
	return { client, body: () => body }
}

const result = JSON.stringify({
	width: 2,
	height: 1,
	[imageKey]: { mediaType: "image/png", data: "aW1n" },
})

test("an Anthropic tool result with an image is sent as an image block", async () => {
	const fake = capture()
	const client = transformClient("anthropic")(fake.client)
	await Effect.runPromise(
		client.execute(
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
		),
	)
	const sent = fake.body() as {
		messages: Array<{ content: Array<{ content: unknown }> }>
	}
	assert.deepEqual(sent.messages[0]!.content[0]!.content, [
		{ type: "text", text: '{"width":2,"height":1}' },
		{
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "aW1n" },
		},
	])
	assert.equal(sent.messages[0]!.content[1]!.content, "plain")
})

test("an OpenAI tool output with an image is sent as an image part", async () => {
	const fake = capture()
	const client = transformClient("openai")(fake.client)
	await Effect.runPromise(
		client.execute(
			HttpClientRequest.post("https://api.example.com/v1/responses").pipe(
				HttpClientRequest.bodyJsonUnsafe({
					input: [
						{ type: "function_call_output", call_id: "a", output: result },
					],
				}),
			),
		),
	)
	const sent = fake.body() as { input: Array<{ output: unknown }> }
	assert.deepEqual(sent.input[0]!.output, [
		{ type: "input_text", text: '{"width":2,"height":1}' },
		{ type: "input_image", image_url: "data:image/png;base64,aW1n" },
	])
})
