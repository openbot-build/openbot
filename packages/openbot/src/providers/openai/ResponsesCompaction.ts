import { Effect, Layer, Option, Schema, String as Str } from "effect"
import { Prompt } from "effect/ai"
import { HttpBody, HttpClientError, HttpClientRequest } from "effect/http"
import { OpenAiClient } from "@effect/ai-openai"
import { ContextCompaction } from "@openbot-build/core"
import * as Request from "./Request.ts"
import type * as OpenAiProvider from "./OpenAiProvider.ts"

const Tokens = Schema.Struct({ input_tokens: Schema.Natural })
const Compacted = Schema.Struct({ output: Schema.Array(Schema.JsonObject) })

/**
 * A failed request keeps its error as the cause. When OpenAI answers with an
 * error status, the message also gets the body of the answer, because only the
 * body says why OpenAI refused the request.
 */
const failed = (message: string) => (error: unknown) =>
	Effect.gen(function* () {
		const body =
			HttpClientError.isHttpClientError(error) &&
			error.reason._tag === "StatusCodeError"
				? yield* Effect.option(error.reason.response.text)
				: Option.none<string>()
		return yield* ContextCompaction.ContextCompactionError.make({
			reason: "request-failed",
			message: Option.match(
				Option.filter(Option.map(body, Str.trim), Str.isNonEmpty),
				{
					onNone: () => message,
					onSome: (text) => `${message}: ${text}`,
				},
			),
			cause: error,
		})
	})

export const make = (
	defaults: OpenAiProvider.Defaults = {},
): Effect.Effect<
	typeof ContextCompaction.ContextCompaction.Service,
	never,
	OpenAiClient.OpenAiClient
> =>
	Effect.gen(function* () {
		const client = yield* OpenAiClient.OpenAiClient
		const encode = Request.encode({ upstream: client, defaults })
		// `client.client` already fails when the status is not 2xx.
		const post = (path: string, body: unknown) =>
			client.client
				.execute(
					HttpClientRequest.post(path, { body: HttpBody.jsonUnsafe(body) }),
				)
				.pipe(Effect.flatMap((response) => response.json))
		return ContextCompaction.ContextCompaction.of({
			count: (request) =>
				Effect.gen(function* () {
					const encoded = yield* encode(request)
					const response = yield* post("/responses/input_tokens", {
						model: encoded.model,
						input: encoded.input,
						instructions: encoded.instructions,
						tools: encoded.tools,
						tool_choice: encoded.tool_choice,
						text: encoded.text,
					})
					return (yield* Schema.decodeUnknownEffect(Tokens)(response))
						.input_tokens
				}).pipe(Effect.catch(failed("The token count request failed"))),
			compact: (request) =>
				Effect.gen(function* () {
					const encoded = yield* encode(request)
					const response = yield* post("/responses/compact", {
						model: encoded.model,
						input: encoded.input,
						instructions: encoded.instructions,
						service_tier: encoded.service_tier,
						prompt_cache_key: encoded.prompt_cache_key,
					})
					const compacted =
						yield* Schema.decodeUnknownEffect(Compacted)(response)
					return {
						_tag: "Native" as const,
						provider: request.selection.provider,
						model: request.selection.model,
						items: compacted.output,
						prompt: Prompt.empty,
					}
				}).pipe(Effect.catch(failed("The compaction request failed"))),
		})
	})

export const layer = (defaults: OpenAiProvider.Defaults = {}) =>
	Layer.effect(ContextCompaction.ContextCompaction, make(defaults))
