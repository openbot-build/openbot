import { Effect, Layer, Schema } from "effect"
import { Prompt } from "effect/ai"
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http"
import { OpenAiClient } from "@effect/ai-openai"
import { ContextCompaction } from "@openbot-build/core"
import * as Request from "./Request.ts"
import type * as OpenAiProvider from "./OpenAiProvider.ts"

const Tokens = Schema.Struct({ input_tokens: Schema.Natural })
const Compacted = Schema.Struct({ output: Schema.Array(Schema.JsonObject) })

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
		const post = (path: string, body: unknown) =>
			HttpClient.filterStatusOk(client.client)
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
				}).pipe(
					Effect.mapError((error) =>
						ContextCompaction.ContextCompactionError.make({
							reason: "request-failed",
							message: String(error),
						}),
					),
				),
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
				}).pipe(
					Effect.mapError((error) =>
						ContextCompaction.ContextCompactionError.make({
							reason: "request-failed",
							message: String(error),
						}),
					),
				),
		})
	})

export const layer = (defaults: OpenAiProvider.Defaults = {}) =>
	Layer.effect(ContextCompaction.ContextCompaction, make(defaults))
