import {
	OpenAiClient,
	OpenAiConfig,
	OpenAiLanguageModel,
	OpenAiSchema,
} from "@effect/ai-openai"
import { type Config } from "@openbot-build/core"
import {
	Array as Arr,
	Effect,
	HashSet,
	Layer,
	Option,
	Predicate,
	Record as Rec,
	Redacted,
	Ref,
	Schema,
	Stream,
} from "effect"
import { AiError, LanguageModel } from "effect/ai"
import { HttpClient, HttpClientRequest } from "effect/http"
import * as ToolImages from "../ToolImages.ts"
import * as Request from "../openai/Request.ts"

/** The provider service reads and refreshes this token for each request. */
export interface Options {
	readonly accessToken: Effect.Effect<
		Redacted.Redacted<string>,
		AiError.AiError
	>
	readonly onUnauthorized?: (
		token: Redacted.Redacted<string>,
	) => Effect.Effect<void, AiError.AiError>
	readonly selection?: Config.Selection
	readonly upstreamModel?: string
}

const namespace = "openbot"
const unsupportedFields = HashSet.make(
	"background",
	"conversation",
	"max_output_tokens",
	"max_tool_calls",
	"metadata",
	"moderation",
	"multi_agent",
	"previous_response_id",
	"prompt",
	"prompt_cache_retention",
	"safety_identifier",
	"temperature",
	"top_logprobs",
	"top_p",
	"truncation",
	"user",
)

const invalidRequest = (description: string) =>
	AiError.AiError.make({
		module: "ChatGptProvider",
		method: "encodeRequest",
		reason: AiError.InvalidRequestError.make({ description }),
	})

const invalidResponse = (description: string) =>
	AiError.AiError.make({
		module: "ChatGptProvider",
		method: "createResponseStream",
		reason: AiError.InvalidResponseError.make({ description }),
	})

const decodeItems = Schema.decodeUnknownEffect(Schema.Array(Schema.JsonObject))
const decodeResponse = Schema.decodeUnknownEffect(OpenAiSchema.Response)
const decodeTerminal = Schema.decodeUnknownEffect(
	Schema.Struct({ response: OpenAiSchema.Response }),
)

const inputItem = (item: Schema.JsonObject): Schema.JsonObject => {
	if (item["role"] === "system") return { ...item, role: "developer" }
	// The SDK drops namespace fields from tool calls. Put back the name of our group in the history.
	if (item["type"] === "function_call" || item["type"] === "custom_tool_call")
		return { ...item, namespace }
	return item
}

const toolChoice = (choice: typeof OpenAiSchema.ToolChoice.Encoded) => {
	if (typeof choice === "string") return choice
	if (choice.type === "function" || choice.type === "custom")
		return { ...choice, namespace }
	if (choice.type === "allowed_tools")
		return {
			...choice,
			tools: Arr.map(choice.tools, (tool) =>
				tool["type"] === "function" || tool["type"] === "custom"
					? { ...tool, namespace }
					: tool,
			),
		}
	return choice
}

/** Change the Responses request to the fields accepted by ChatGPT plan usage. */
const prepare = (
	payload: typeof OpenAiSchema.CreateResponse.Encoded,
	selection: Config.Selection | undefined,
) =>
	Effect.gen(function* () {
		const input =
			typeof payload.input === "string"
				? [{ role: "user", content: payload.input }]
				: yield* decodeItems(payload.input ?? []).pipe(
						Effect.mapError((error) => invalidRequest(String(error))),
					)
		const native =
			selection === undefined ? [] : yield* Request.nativeInput(selection)
		const tools = payload.tools ?? []
		const functions = Arr.filter(
			tools,
			(tool) => tool.type === "function" || tool.type === "custom",
		)
		const hosted = Arr.filter(
			tools,
			(tool) => tool.type !== "function" && tool.type !== "custom",
		)
		if (
			Arr.some(
				hosted,
				(tool) =>
					tool.type !== "web_search" && tool.type !== "web_search_preview",
			)
		)
			return yield* invalidRequest(
				"ChatGPT does not support this hosted tool. Use an OpenBot function tool.",
			)
		const fields: Readonly<Record<string, unknown>> = payload
		// The SDK tool schema has no namespace group. Add it to the wire body and keep the tool names.
		return {
			...Rec.filter(
				fields,
				(value, key) =>
					value !== undefined && !HashSet.has(unsupportedFields, key),
			),
			input: Arr.map([...native, ...input], inputItem),
			store: false,
			stream: true,
			...(tools.length === 0
				? {}
				: {
						tools: [
							...hosted,
							...(functions.length === 0
								? []
								: [
										{
											type: "namespace",
											name: namespace,
											description: "OpenBot tools.",
											tools: functions,
										},
									]),
						],
					}),
			...(payload.tool_choice === undefined
				? {}
				: { tool_choice: toolChoice(payload.tool_choice) }),
		}
	})

type Event = OpenAiSchema.ResponseStreamEvent

const terminalError = (event: Event) =>
	Effect.gen(function* () {
		const { response } = yield* decodeTerminal(event).pipe(
			Effect.mapError((error) => invalidResponse(String(error))),
		)
		const metadata = {
			chatgpt: {
				error: response.error ?? null,
				incomplete: response.incomplete_details ?? null,
			},
		}
		return AiError.AiError.make({
			module: "ChatGptProvider",
			method: "createResponseStream",
			reason:
				response.error?.code === "subscription_sharing_usage_limit_exceeded" ||
				response.error?.code === "subscription_sharing_usage_unavailable"
					? AiError.QuotaExhaustedError.make({ metadata })
					: AiError.InvalidOutputError.make({
							description: "ChatGPT did not complete the response.",
							metadata,
						}),
		})
	})

/** A stream is complete only after its response.completed event. */
const checkedStream = (stream: Stream.Stream<Event, AiError.AiError>) =>
	Stream.unwrap(
		Effect.map(Ref.make(false), (completed) =>
			stream.pipe(
				Stream.mapEffect((event) => {
					if (
						event.type === "response.failed" ||
						event.type === "response.incomplete"
					)
						return terminalError(event).pipe(Effect.flatMap(Effect.fail))
					if (event.type === "error")
						return Effect.fail(
							AiError.AiError.make({
								module: "ChatGptProvider",
								method: "createResponseStream",
								reason: AiError.InvalidOutputError.make({
									description: "ChatGPT returned a stream error.",
									metadata: { chatgpt: { error: event } },
								}),
							}),
						)
					return event.type === "response.completed"
						? Ref.set(completed, true).pipe(Effect.as(event))
						: Effect.succeed(event)
				}),
				Stream.onEnd(
					Ref.get(completed).pipe(
						Effect.flatMap((done) =>
							done
								? Effect.void
								: Effect.fail(
										invalidResponse(
											"The ChatGPT stream ended before the response was complete.",
										),
									),
						),
					),
				),
			),
		),
	)

/** Reuse the SDK's event decoder, with a fresh provider token for each call. */
export const makeClient = (options: Options) =>
	Effect.gen(function* () {
		const upstream = yield* OpenAiClient.make({})
		const createResponseStream: OpenAiClient.Service["createResponseStream"] = (
			payload,
		) =>
			Effect.gen(function* () {
				const token = yield* options.accessToken
				const body = yield* prepare(payload, options.selection)
				const scoped = yield* OpenAiConfig.OpenAiConfig.getOrUndefined
				const [response, stream] = yield* upstream
					.createResponseStream(payload)
					.pipe(
						OpenAiConfig.withClientTransform((http) =>
							HttpClient.mapRequest(
								ToolImages.transformClient("openai")(
									scoped?.transformClient?.(http) ?? http,
								),
								(request) =>
									request.pipe(
										HttpClientRequest.bodyJsonUnsafe(body),
										HttpClientRequest.bearerToken(token),
									),
							),
						),
						Effect.tapError((error) =>
							error.reason._tag === "AuthenticationError" &&
							options.onUnauthorized !== undefined
								? options.onUnauthorized(token)
								: Effect.void,
						),
					)
				return [response, checkedStream(stream)] as const
			})
		const createResponse: OpenAiClient.Service["createResponse"] = (payload) =>
			Effect.gen(function* () {
				const [response, stream] = yield* createResponseStream(payload)
				const last = yield* Stream.runLast(stream)
				if (
					Option.isNone(last) ||
					!Predicate.hasProperty(last.value, "response")
				)
					return yield* invalidResponse("The ChatGPT response is missing.")
				const body = yield* decodeResponse(last.value.response).pipe(
					Effect.mapError((error) => invalidResponse(String(error))),
				)
				return [body, response] as const
			})
		return OpenAiClient.OpenAiClient.of({
			...upstream,
			createResponse,
			createResponseStream,
		})
	})

export const layerClient = (options: Options) =>
	Layer.effect(OpenAiClient.OpenAiClient, makeClient(options))

/** The same model methods and tool handling as the OpenAI provider. */
export const layer = (
	selection: Config.Selection,
	options: Omit<Options, "selection">,
) =>
	Layer.effect(
		LanguageModel.LanguageModel,
		Effect.gen(function* () {
			const client = yield* makeClient({ ...options, selection })
			const config = yield* Request.config(
				options.upstreamModel === undefined
					? {}
					: { upstreamModel: options.upstreamModel },
			)(selection)
			return yield* OpenAiLanguageModel.make({
				model: options.upstreamModel ?? selection.model,
				config,
			}).pipe(Effect.provideService(OpenAiClient.OpenAiClient, client))
		}),
	)
