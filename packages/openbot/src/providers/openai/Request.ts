import {
	Deferred,
	Effect,
	Option,
	Schema,
	Predicate,
	Record as Rec,
} from "effect"
import { AiError, Prompt } from "effect/ai"
import {
	OpenAiClient,
	OpenAiConfig,
	OpenAiLanguageModel,
	OpenAiSchema,
} from "@effect/ai-openai"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
	ContextWindow,
	type Config,
	type ContextCompaction,
} from "@openbot-build/core"
import { type Defaults, type Options } from "./OpenAiProvider.ts"

const invalidRequest = (description: string) =>
	AiError.AiError.make({
		module: "OpenAiProvider",
		method: "encodeRequest",
		reason: AiError.InvalidRequestError.make({ description }),
	})

const decodeJsonObjects = Schema.decodeUnknownEffect(
	Schema.Array(Schema.JsonObject),
)

const decodeItems = (input: unknown) =>
	decodeJsonObjects(input).pipe(
		Effect.mapError((error) => invalidRequest(String(error))),
	)

export const config =
	({ upstreamModel, ...defaults }: Defaults & Options) =>
	(selection: Config.Selection) =>
		Effect.gen(function* () {
			const reasoning =
				selection.reasoningEffort === undefined
					? defaults.reasoning
					: yield* Schema.decodeUnknownEffect(
							OpenAiSchema.CreateResponse.fields.reasoning,
						)({
							...defaults.reasoning,
							effort: selection.reasoningEffort,
						}).pipe(Effect.mapError((error) => invalidRequest(String(error))))
			return {
				store: false,
				...defaults,
				model: upstreamModel ?? selection.model,
				reasoning,
				...Rec.filter(
					{ service_tier: selection.serviceTier },
					Predicate.isNotUndefined,
				),
			} satisfies typeof OpenAiLanguageModel.Config.Service
		})

/**
 * The native items of the context window of the current model call. The Chat
 * runtime gives the window to each call that it makes. Other calls, such as
 * those of a helper model, have none, so they send no native items.
 */
export const nativeInput = (
	selection: Config.Selection,
): Effect.Effect<ReadonlyArray<Schema.JsonObject>, AiError.AiError> =>
	Effect.serviceOption(ContextWindow.CurrentWindow).pipe(
		Effect.flatMap((window) =>
			Option.match(
				Option.filter(window, (window) => window._tag === "Native"),
				{
					onNone: () => Effect.succeed([]),
					onSome: (window) =>
						window.provider !== selection.provider ||
						window.model !== selection.model
							? Effect.fail(
									invalidRequest(
										"The native context window provider or model does not match the request",
									),
								)
							: decodeItems(window.items),
				},
			),
		),
	)

type Request = Omit<typeof OpenAiSchema.CreateResponse.Encoded, "input"> & {
	readonly input: ReadonlyArray<Schema.JsonObject>
}

const prependNativeInput = (
	selection: Config.Selection,
	payload: typeof OpenAiSchema.CreateResponse.Encoded,
): Effect.Effect<Request, AiError.AiError> =>
	Effect.gen(function* () {
		const native = yield* nativeInput(selection)
		const input = yield* decodeItems(payload.input)
		return { ...payload, input: [...native, ...input] }
	})

/** Add to encoded HTTP requests, and keep the SDK's handling of responses and streams. */
export const client = (
	selection: Config.Selection,
): Effect.Effect<OpenAiClient.Service, never, OpenAiClient.OpenAiClient> =>
	Effect.gen(function* () {
		const upstream = yield* OpenAiClient.OpenAiClient
		const send = <A>(
			payload: typeof OpenAiSchema.CreateResponse.Encoded,
			operation: Effect.Effect<A, AiError.AiError>,
		): Effect.Effect<A, AiError.AiError> =>
			Effect.gen(function* () {
				const body = yield* prependNativeInput(selection, payload)
				// The SDK has a config only when the caller set one for this call. It is
				// replaced below, so its own change of the client must still run.
				const scoped = yield* Effect.serviceOption(OpenAiConfig.OpenAiConfig)
				return yield* operation.pipe(
					OpenAiConfig.withClientTransform((http) => {
						const extended = HttpClient.mapRequest(http, (request) =>
							HttpClientRequest.bodyJsonUnsafe(request, body),
						)
						return Option.match(scoped, {
							onNone: () => extended,
							// transformClient is an optional field of the SDK config.
							onSome: (config) =>
								config.transformClient?.(extended) ?? extended,
						})
					}),
				)
			})
		return {
			...upstream,
			createResponse: (payload) =>
				send(payload, upstream.createResponse(payload)),
			createResponseStream: (payload) =>
				send(
					{ ...payload, stream: true },
					upstream.createResponseStream(payload),
				),
		}
	})

/** Capture the SDK request before it is sent, without generating output or running tools. */
export const encode =
	({
		upstream,
		defaults,
	}: {
		readonly upstream: OpenAiClient.Service
		readonly defaults: Defaults
	}) =>
	(request: ContextCompaction.Request) =>
		Effect.gen(function* () {
			const settings = yield* config(defaults)(request.selection)
			const captured = yield* Deferred.make<Request>()
			const model = yield* OpenAiLanguageModel.make({
				model: request.selection.model,
				config: settings,
			}).pipe(
				Effect.provideService(OpenAiClient.OpenAiClient, {
					...upstream,
					// Keep the request and never send it. The race below stops the model call.
					createResponse: (payload) =>
						prependNativeInput(request.selection, payload).pipe(
							Effect.flatMap((encoded) => Deferred.succeed(captured, encoded)),
							Effect.andThen(Effect.never),
						),
				}),
			)
			const generate = model
				.generateText({
					prompt: Prompt.concat(request.instructions, request.window.prompt),
					toolkit: {
						// Encoding needs only the wire schema. It does not need parameter codec services.
						tools: Rec.map(request.toolkit.tools, (tool) =>
							tool.setParameters(Schema.toEncoded(tool.parametersSchema)),
						),
						handle: () =>
							Effect.fail(invalidRequest("Request encoding cannot run tools")),
					},
					toolChoice: request.toolChoice ?? "auto",
					disableToolCallResolution: true,
				})
				.pipe(
					// createResponse never returns, so the model call cannot finish with a value.
					Effect.andThen(Effect.never),
					Effect.provideService(ContextWindow.CurrentWindow, request.window),
				)
			return yield* Effect.raceFirst(Deferred.await(captured), generate)
		})
