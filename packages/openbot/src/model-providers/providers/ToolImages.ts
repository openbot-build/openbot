import {
	Array as Arr,
	Option,
	pipe,
	Predicate,
	Record as Rec,
	Schema,
	String as Str,
} from "effect"
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http"

/**
 * A tool result that holds an image, such as a screenshot of a Computer, has this key.
 * The model must see the image itself, not its Base64 text.
 */
export const imageKey = "openbot_image"

const ToolImage = Schema.Struct({
	mediaType: Schema.String,
	/** Base64 bytes of the image. */
	data: Schema.String,
})

/** A tool result that holds an image, such as a screenshot of a Computer. */
const WithImage = Schema.Struct({ [imageKey]: ToolImage })

/** Tells if a tool result holds an image. */
export const hasImage = Schema.is(WithImage)

const decodeJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Unknown),
)

/** The image of a tool result, and the JSON text of its other keys. */
const parsed = (text: unknown) =>
	Predicate.isString(text) && Str.includes(imageKey)(text)
		? pipe(
				decodeJson(text),
				Option.filter(hasImage),
				Option.map((value) => ({
					image: value[imageKey],
					rest: JSON.stringify(Rec.remove(value, imageKey)),
				})),
			)
		: Option.none()

/** Anthropic: a `tool_result` can hold text and image blocks. */
const anthropic = (body: { readonly [x: PropertyKey]: unknown }) => {
	const messages = body["messages"]
	if (!Arr.isArray(messages)) return false
	let changed = false
	for (const message of messages) {
		if (!Predicate.isObject(message)) continue
		const content = message["content"]
		if (!Arr.isArray(content)) continue
		for (const block of content) {
			if (!Predicate.isObject(block) || block["type"] !== "tool_result")
				continue
			const found = parsed(block["content"])
			if (Option.isNone(found)) continue
			block["content"] = [
				{ type: "text", text: found.value.rest },
				{
					type: "image",
					source: {
						type: "base64",
						media_type: found.value.image.mediaType,
						data: found.value.image.data,
					},
				},
			]
			changed = true
		}
	}
	return changed
}

/** OpenAI Responses: a `function_call_output` can hold text and image parts. */
const openai = (body: { readonly [x: PropertyKey]: unknown }) => {
	const input = body["input"]
	if (!Arr.isArray(input)) return false
	let changed = false
	for (const item of input) {
		if (!Predicate.isObject(item) || item["type"] !== "function_call_output")
			continue
		const found = parsed(item["output"])
		if (Option.isNone(found)) continue
		item["output"] = [
			{ type: "input_text", text: found.value.rest },
			{
				type: "input_image",
				image_url: `data:${found.value.image.mediaType};base64,${found.value.image.data}`,
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
 * request just before it goes out. The body is a new copy that only this request uses,
 * so the change happens in place. Remove it when the SDKs send image results.
 */
export const transformClient =
	(api: "anthropic" | "openai") =>
	(client: HttpClient.HttpClient): HttpClient.HttpClient =>
		HttpClient.mapRequest(client, (request) => {
			const body = request.body
			if (body._tag !== "Uint8Array" || !Str.includes("json")(body.contentType))
				return request
			const text = body.text ?? decoder.decode(body.body)
			if (!Str.includes(imageKey)(text)) return request
			const json = Option.filter(decodeJson(text), Predicate.isObject)
			if (Option.isNone(json)) return request
			const changed =
				api === "anthropic" ? anthropic(json.value) : openai(json.value)
			return changed
				? HttpClientRequest.setBody(request, HttpBody.jsonUnsafe(json.value))
				: request
		})
