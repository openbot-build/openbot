import { Effect, Match, Option, Schema, Predicate, Record } from "effect"
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
import { type Defaults } from "./OpenAiProvider.ts"

const invalid = (description: string) =>
	AiError.AiError.make({
		module: "provider-openai",
		method: "encodeRequest",
		reason: AiError.InvalidRequestError.make({ description }),
	})
export const config =
	(defaults: Defaults = {}) =>
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
						}).pipe(Effect.mapError((e) => invalid(String(e))))
			return {
				store: false,
				...defaults,
				model: selection.model,
				reasoning,
				...Record.filter(
					{ service_tier: selection.serviceTier },
					Predicate.isNotUndefined,
				),
			} satisfies typeof OpenAiLanguageModel.Config.Service
		})

export const nativeInput = (
	selection: Config.Selection,
): Effect.Effect<ReadonlyArray<Schema.JsonObject>, AiError.AiError> =>
	Effect.gen(function* () {
		const window = Option.getOrUndefined(
			yield* Effect.serviceOption(ContextWindow.CurrentWindow),
		)
		return yield* Match.value(window).pipe(
			Match.when({ _tag: "Native" }, (window) =>
				Effect.gen(function* () {
					if (
						window.provider !== selection.provider ||
						window.model !== selection.model
					)
						return yield* invalid(
							"The native context window provider or model does not match the request",
						)
					return yield* Schema.decodeUnknownEffect(
						Schema.Array(Schema.JsonObject),
					)(window.items).pipe(Effect.mapError((e) => invalid(String(e))))
				}),
			),
			Match.orElse(() => Effect.succeed([])),
		)
	})

type Request = Omit<typeof OpenAiSchema.CreateResponse.Encoded, "input"> & {
	readonly input: ReadonlyArray<Schema.JsonObject>
}

const prependNativeInput = (
	selection: Config.Selection,
	payload: typeof OpenAiSchema.CreateResponse.Encoded,
): Effect.Effect<Request, AiError.AiError> =>
	Effect.gen(function* () {
		const native = yield* nativeInput(selection)
		const input = yield* Schema.decodeUnknownEffect(
			Schema.Array(Schema.JsonObject),
		)(payload.input).pipe(Effect.mapError((e) => invalid(String(e))))
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
				const scoped = yield* OpenAiConfig.OpenAiConfig.getOrUndefined
				return yield* operation.pipe(
					OpenAiConfig.withClientTransform((http) => {
						const extended = HttpClient.mapRequest(http, (request) =>
							HttpClientRequest.bodyJsonUnsafe(request, body),
						)
						return scoped?.transformClient?.(extended) ?? extended
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
		defaults = {},
	}: {
		readonly upstream: OpenAiClient.Service
		readonly defaults?: Defaults
	}) =>
	(request: ContextCompaction.Request) =>
		Effect.gen(function* () {
			const settings = yield* config(defaults)(request.selection)
			const captured = invalid("Request captured before it was sent")
			let encoded: Request | undefined
			const model = yield* OpenAiLanguageModel.make({
				model: request.selection.model,
				config: settings,
			}).pipe(
				Effect.provideService(OpenAiClient.OpenAiClient, {
					...upstream,
					createResponse: (payload) =>
						Effect.gen(function* () {
							encoded = yield* prependNativeInput(request.selection, payload)
							return yield* captured
						}),
				}),
			)
			return yield* model
				.generateText({
					prompt: Prompt.concat(request.instructions, request.window.prompt),
					toolkit: {
						// Encoding needs only the wire schema. It does not need parameter codec services.
						tools: Object.fromEntries(
							Object.entries(request.toolkit.tools).map(([name, tool]) => [
								name,
								tool.setParameters(Schema.toEncoded(tool.parametersSchema)),
							]),
						),
						handle: () =>
							Effect.fail(invalid("Request encoding cannot run tools")),
					},
					toolChoice: request.toolChoice ?? "auto",
					disableToolCallResolution: true,
				})
				.pipe(
					Effect.matchEffect({
						onFailure: (error) =>
							error === captured && encoded !== undefined
								? Effect.succeed(encoded)
								: Effect.fail(error),
						onSuccess: () =>
							Effect.die("Request capture unexpectedly generated a response"),
					}),
					Effect.provideService(ContextWindow.CurrentWindow, request.window),
				)
		})
