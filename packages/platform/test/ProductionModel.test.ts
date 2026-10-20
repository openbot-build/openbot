// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { Config as ModelConfig, Model, Provider } from "@openbot-build/core"
import { ConfigProvider, Effect, Match, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as ProductionModel from "../src/app/ProductionModel.ts"

const settings = {
	endpoint: "https://model.test/v1/",
	apiKey: Redacted.make("fixture-key"),
	model: "deepseek-v4-flash",
}

test("production model configuration is optional, all-or-nothing and redacted", async () => {
	const parse = (values: Record<string, string>) =>
		ProductionModel.load.parse(ConfigProvider.fromUnknown(values))
	assert.equal(await Effect.runPromise(parse({})), undefined)
	assert.equal(
		await Effect.runPromise(
			parse({
				OPENBOT_MODEL_ENDPOINT: "",
				OPENBOT_MODEL_API_KEY: "",
				OPENBOT_MODEL_ID: "",
			}),
		),
		undefined,
	)
	const values = {
		OPENBOT_MODEL_ENDPOINT: settings.endpoint,
		OPENBOT_MODEL_API_KEY: "fixture-key",
		OPENBOT_MODEL_ID: settings.model,
	}
	const loaded = await Effect.runPromise(parse(values))
	assert.ok(loaded)
	assert.equal(Redacted.value(loaded.apiKey), "fixture-key")
	assert.ok(!JSON.stringify(loaded).includes("fixture-key"))
	for (const invalid of [
		{ ...values, OPENBOT_MODEL_API_KEY: "" },
		{ ...values, OPENBOT_MODEL_ID: "" },
		{ ...values, OPENBOT_MODEL_ENDPOINT: "" },
		{ ...values, OPENBOT_MODEL_ENDPOINT: "not-a-url" },
		{
			...values,
			OPENBOT_MODEL_ENDPOINT: "https://model.test/v1?key=hidden",
		},
	]) {
		const error = await Effect.runPromise(parse(invalid).pipe(Effect.flip))
		assert.equal(error._tag, "ConfigError")
		assert.ok(!error.toString().includes("fixture-key"))
	}
})

test("the production directory sends generation and streaming to its configured provider", async () => {
	let calls = 0
	const client = HttpClient.make((request, url) =>
		Effect.gen(function* () {
			assert.equal(url.href, "https://model.test/v1/chat/completions")
			assert.equal(request.headers["authorization"], "Bearer fixture-key")
			const body = yield* Match.value(request.body).pipe(
				Match.tag("Uint8Array", (body) =>
					Schema.decodeUnknownEffect(
						Schema.Struct({
							model: Schema.String,
							stream: Schema.optional(Schema.Boolean),
							reasoning_effort: Schema.optional(Schema.String),
							service_tier: Schema.optional(Schema.String),
						}),
					)(JSON.parse(new TextDecoder().decode(body.body))).pipe(Effect.orDie),
				),
				Match.orElse(() => Effect.die("Expected an encoded model request")),
			)
			assert.equal(body.model, settings.model)
			assert.equal(body.reasoning_effort, undefined)
			assert.equal(body.service_tier, undefined)
			calls++
			const answer = {
				id: "chat_fixture",
				model: settings.model,
				created: 1,
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "Configured response" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
			}
			const events = [
				{
					...answer,
					choices: [
						{
							index: 0,
							delta: { role: "assistant", content: "Configured response" },
							finish_reason: null,
						},
					],
				},
				{
					...answer,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
			]
			return HttpClientResponse.fromWeb(
				request,
				new Response(
					body.stream === true
						? events
								.map((event) => `data: ${JSON.stringify(event)}\n\n`)
								.join("") + "data: [DONE]\n\n"
						: JSON.stringify(answer),
					{
						headers: {
							"content-type":
								body.stream === true ? "text/event-stream" : "application/json",
						},
					},
				),
			)
		}),
	)
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const options = yield* ProductionModel.make(settings)
				assert.ok(
					options.modelCatalog && options.defaults && options.resolveModel,
				)
				const catalog = yield* options.modelCatalog
				const defaults = yield* options.defaults
				assert.equal(catalog.models[0]?.id, settings.model)
				assert.equal(defaults.model?.model, settings.model)
				assert.equal(calls, 0)
				const model = yield* options.resolveModel(undefined)
				assert.equal(
					(yield* model.generateText({ prompt: "Hello" })).text,
					"Configured response",
				)
				const parts = yield* Stream.runCollect(
					model.streamText({ prompt: "Hello" }),
				)
				assert.equal(
					parts
						.filter((part) => part.type === "text-delta")
						.map((part) => part.delta)
						.join(""),
					"Configured response",
				)
				assert.equal(calls, 2)
				for (const selection of [
					{
						provider: Provider.Id.make("missing"),
						model: Model.Id.make(settings.model),
					},
					{
						provider: Provider.Id.make("openai-compat"),
						model: Model.Id.make("missing"),
					},
					{
						provider: Provider.Id.make("openai-compat"),
						model: Model.Id.make(settings.model),
						reasoningEffort: "high",
					},
				]) {
					const error: ModelConfig.ModelConfigurationError = yield* options
						.resolveModel(ModelConfig.Selection.make(selection))
						.pipe(Effect.flip)
					assert.equal(error._tag, "ModelConfigurationError")
				}
				assert.equal(calls, 2)
			}),
		).pipe(Effect.provideService(HttpClient.HttpClient, client)),
	)
})
