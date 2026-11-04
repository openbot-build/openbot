import { OpenAiConfig } from "@effect/ai-openai-compat"
import {
	Array as Arr,
	Context,
	Effect,
	Option,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import {
	FetchHttpClient,
	HttpClient,
	HttpClientError,
	type HttpClientRequest,
} from "effect/http"
import {
	CurrentModelReadFailure,
	FinalModelRead,
	type ModelReadFailureReason,
	type ModelReadRequest,
} from "../../models/ModelFailure.ts"

// Only a known socket failure can start a retry. An abort further down the cause chain rules it out.
const readReason = (cause: unknown): ModelReadFailureReason | undefined => {
	let current = cause
	let match: ModelReadFailureReason | undefined
	for (
		let depth = 0;
		depth < 8 && typeof current === "object" && current !== null;
		depth++
	) {
		const code = "code" in current ? current.code : undefined
		const name = "name" in current ? current.name : undefined
		if (
			code === "ABORT_ERR" ||
			name === "AbortError" ||
			name === "TimeoutError"
		)
			return undefined
		if (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET")
			match = "socket_reset"
		if (code === "UND_ERR_BODY_TIMEOUT") match = "body_timeout"
		current = "cause" in current ? current.cause : undefined
	}
	return current === undefined ||
		current === null ||
		typeof current !== "object"
		? match
		: undefined
}

/** Only list routes that cannot run provider tools or other outside work. */
export interface ModelReadRetryRoute {
	readonly completionUrl: string
	readonly model: string
}
const opt = Schema.optionalKey
const FunctionName = Schema.Struct({ name: Schema.NonEmptyString })
const FunctionTool = Schema.Struct({
	type: Schema.Literal("function"),
	function: Schema.Struct({
		...FunctionName.fields,
		description: opt(Schema.NullOr(Schema.String)),
		parameters: opt(Schema.JsonObject),
		strict: opt(Schema.Boolean),
	}),
})
const Message = Schema.Union([
	Schema.Struct({
		role: Schema.Literals(["system", "developer", "user"]),
		content: Schema.Union([
			Schema.String,
			Schema.Array(
				Schema.Struct({
					type: Schema.Literal("text"),
					text: Schema.String,
				}),
			),
		]),
	}),
	Schema.Struct({
		role: Schema.Literal("assistant"),
		content: Schema.NullOr(Schema.String),
		reasoning: opt(Schema.String),
		reasoning_content: opt(Schema.String),
		tool_calls: opt(
			Schema.Array(
				Schema.Struct({
					type: Schema.Literal("function"),
					id: Schema.String,
					function: Schema.Struct({
						...FunctionName.fields,
						arguments: Schema.String,
					}),
				}),
			),
		),
	}),
	Schema.Struct({
		role: Schema.Literal("tool"),
		tool_call_id: Schema.String,
		content: Schema.String,
	}),
])
// Reject extra fields inside tool definitions and messages as well as at the top level.
const localCompletion = Schema.decodeUnknownOption(
	Schema.fromJsonString(
		Schema.Struct({
			model: Schema.NonEmptyString,
			messages: Schema.Array(Message),
			stream: Schema.Literal(true),
			stream_options: Schema.Struct({ include_usage: Schema.Literal(true) }),
			tools: opt(Schema.Array(FunctionTool)),
			tool_choice: opt(
				Schema.Union([
					Schema.Literals(["auto", "none", "required"]),
					Schema.Struct({
						type: Schema.Literal("function"),
						function: FunctionName,
					}),
				]),
			),
			temperature: opt(Schema.Finite),
			top_p: opt(Schema.Finite),
			max_tokens: opt(Schema.Finite),
			max_completion_tokens: opt(Schema.Finite),
			user: opt(Schema.String),
			seed: opt(Schema.Finite),
			parallel_tool_calls: opt(Schema.Boolean),
			service_tier: opt(Schema.String),
			reasoning_effort: opt(Schema.String),
			reasoning: opt(
				Schema.Struct({
					effort: opt(Schema.String),
					summary: opt(Schema.String),
				}),
			),
			response_format: opt(
				Schema.Union([
					Schema.Struct({ type: Schema.Literals(["text", "json_object"]) }),
					Schema.Struct({
						type: Schema.Literal("json_schema"),
						json_schema: Schema.Struct({
							name: Schema.NonEmptyString,
							schema: Schema.JsonObject,
							description: opt(Schema.String),
							strict: opt(Schema.Boolean),
						}),
					}),
				]),
			),
			frequency_penalty: opt(Schema.Finite),
			presence_penalty: opt(Schema.Finite),
			stop: opt(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
		}),
	),
	{ onExcessProperty: "error" },
)

// Check the final bytes prepared by the client, including nested provider options.
const approvedRequest = (
	request: HttpClientRequest.HttpClientRequest,
	routes: ReadonlyArray<ModelReadRetryRoute>,
): ModelReadRequest | undefined => {
	if (
		request.method !== "POST" ||
		request.urlParams.params.length > 0 ||
		Option.isSome(request.hash) ||
		request.body._tag !== "Uint8Array" ||
		request.body.contentType !== "application/json"
	)
		return undefined
	const body = new TextDecoder().decode(request.body.body)
	const payload = localCompletion(body)
	if (
		Option.isNone(payload) ||
		!Arr.some(
			routes,
			(route) =>
				route.completionUrl === request.url &&
				route.model === payload.value.model,
		)
	)
		return undefined
	return { url: request.url, body }
}

/** Observe the transport before the SDK maps HTTP or stream errors to model errors. */
export const observeResponse =
	(routes: ReadonlyArray<ModelReadRetryRoute>) =>
	(client: HttpClient.HttpClient) =>
		HttpClient.transform(client, (send, request) =>
			Effect.gen(function* () {
				const final = yield* FinalModelRead
				const record = yield* CurrentModelReadFailure
				if (final === undefined && record === undefined) return yield* send
				const scoped = yield* OpenAiConfig.OpenAiConfig.getOrUndefined
				if (final === undefined && scoped?.transformClient !== undefined)
					return yield* send
				const wire = approvedRequest(request, routes)
				if (final === undefined && wire === undefined) return yield* send
				if (final !== undefined) {
					if (
						scoped?.transformClient !== undefined ||
						wire?.url !== final.request.url ||
						wire.body !== final.request.body ||
						(yield* Ref.getAndSet(final.sent, true))
					) {
						return yield* new HttpClientError.HttpClientError({
							reason: new HttpClientError.EncodeError({
								request,
								description:
									"The model retry no longer matches its first request.",
							}),
						})
					}
				}
				// A redirect can send a second POST to a different endpoint before its URL is known.
				const init = Context.getOrUndefined(
					yield* Effect.context<never>(),
					FetchHttpClient.RequestInit,
				)
				const response = yield* send.pipe(
					Effect.provideService(FetchHttpClient.RequestInit, {
						...init,
						redirect: "manual",
					}),
				)
				if (final !== undefined || response.url !== request.url) return response
				const mark = (reason: ModelReadFailureReason) =>
					wire !== undefined && record !== undefined
						? record(reason, wire)
						: Effect.void
				if (response.status === 504) {
					yield* mark("gateway_timeout")
					return response
				}
				const mime = Str.toLowerCase(
					Str.trim(Str.split(response.headers["content-type"] ?? "", ";")[0]),
				)
				if (
					response.status < 200 ||
					response.status >= 300 ||
					mime !== "text/event-stream"
				)
					return response
				const stream = response.stream.pipe(
					Stream.tapError((error) => {
						const reason =
							error.reason._tag === "DecodeError"
								? readReason(error.reason.cause)
								: undefined
						return reason === undefined ? Effect.void : mark(reason)
					}),
				)
				return Object.create(response, {
					stream: { value: stream },
				}) as typeof response
			}),
		)
