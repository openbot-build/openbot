import { Option, Predicate, Schema } from "effect"
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http"

/**
 * A tool result that holds an image, such as a screenshot of a Computer, has this key.
 * The model must see the image itself, not its Base64 text.
 */
export const imageKey = "openbot_image"

export interface ToolImage {
	readonly mediaType: string
	/** Base64 bytes of the image. */
	readonly data: string
}

/** The image of a tool result, when it has one. */
export const imageOf = (result: unknown): ToolImage | undefined => {
	if (typeof result !== "object" || result === null) return undefined
	const image = (result as Record<string, unknown>)[imageKey]
	if (typeof image !== "object" || image === null) return undefined
	const { mediaType, data } = image as Record<string, unknown>
	return typeof mediaType === "string" && typeof data === "string"
		? { mediaType, data }
		: undefined
}

const decodeJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Unknown),
)

const parsed = (text: unknown) => {
	if (typeof text !== "string" || !text.includes(imageKey)) return undefined
	const value = Option.getOrUndefined(decodeJson(text))
	const image = imageOf(value)
	if (image === undefined) return undefined
	const rest = { ...(value as Record<string, unknown>) }
	delete rest[imageKey]
	return { image, rest: JSON.stringify(rest) }
}

/** Anthropic: a `tool_result` can hold text and image blocks. */
const anthropic = (body: Record<string, unknown>) => {
	const messages = body["messages"]
	if (!Array.isArray(messages)) return false
	let changed = false
	for (const message of messages) {
		const content = (message as Record<string, unknown>)["content"]
		if (!Array.isArray(content)) continue
		for (const block of content as Array<Record<string, unknown>>) {
			if (block["type"] !== "tool_result") continue
			const found = parsed(block["content"])
			if (found === undefined) continue
			block["content"] = [
				{ type: "text", text: found.rest },
				{
					type: "image",
					source: {
						type: "base64",
						media_type: found.image.mediaType,
						data: found.image.data,
					},
				},
			]
			changed = true
		}
	}
	return changed
}

/** OpenAI Responses: a `function_call_output` can hold text and image parts. */
const openai = (body: Record<string, unknown>) => {
	const input = body["input"]
	if (!Array.isArray(input)) return false
	let changed = false
	for (const item of input as Array<Record<string, unknown>>) {
		if (item["type"] !== "function_call_output") continue
		const found = parsed(item["output"])
		if (found === undefined) continue
		item["output"] = [
			{ type: "input_text", text: found.rest },
			{
				type: "input_image",
				image_url: `data:${found.image.mediaType};base64,${found.image.data}`,
			},
		]
		changed = true
	}
	return changed
}

const decoder = new TextDecoder()

/**
 * Sends the images of tool results as images.
 *
 * Workaround: `@effect/ai-anthropic` and `@effect/ai-openai` turn every tool result into
 * JSON text (`JSON.stringify(part.result)`), so a model never sees an image that a tool
 * returns. Both APIs take images in tool results. So this changes the JSON body of the
 * request just before it goes out. Remove it when the SDKs send image results.
 */
export const transformClient =
	(api: "anthropic" | "openai") =>
	(client: HttpClient.HttpClient): HttpClient.HttpClient =>
		HttpClient.mapRequest(client, (request) => {
			const body = request.body
			if (body._tag !== "Uint8Array" || !body.contentType.includes("json"))
				return request
			const text = body.text ?? decoder.decode(body.body)
			if (!text.includes(imageKey)) return request
			const parsedBody = Option.getOrUndefined(decodeJson(text))
			if (!Predicate.isObject(parsedBody)) return request
			const json = parsedBody as Record<string, unknown>
			const changed = api === "anthropic" ? anthropic(json) : openai(json)
			return changed
				? HttpClientRequest.setBody(request, HttpBody.jsonUnsafe(json))
				: request
		})
