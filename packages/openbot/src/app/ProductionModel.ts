import { Config as ModelConfig, Model, Provider } from "@openbot-build/core"
import * as OpenAiCompatProvider from "../providers/openai-compat/OpenAiCompatProvider.ts"
import {
	Config,
	Context,
	Effect,
	Layer,
	Option,
	Redacted,
	Schema,
	type Scope,
} from "effect"
import { LanguageModel, type AiError } from "effect/ai"
import { type HttpClient } from "effect/http"
import type * as Sessions from "../sessions/Sessions.ts"

export interface Settings {
	readonly endpoint: string
	readonly apiKey: Redacted.Redacted<string>
	readonly model: string
}

const Endpoint = Schema.NonEmptyString.check(
	Schema.makeFilter((value: string) => {
		if (!URL.canParse(value)) return "Expected an absolute model endpoint URL"
		const url = new URL(value)
		return (url.protocol === "https:" || url.protocol === "http:") &&
			url.username === "" &&
			url.password === "" &&
			url.search === "" &&
			url.hash === ""
			? undefined
			: "Expected an HTTP endpoint without credentials, query or fragment"
	}),
)

/** No model settings at all means the host has no production model. */
export const load: Config.Config<Option.Option<Settings>> = Config.all({
	endpoint: Config.String("OPENBOT_MODEL_ENDPOINT").pipe(
		Config.withDefault(""),
	),
	apiKey: Config.Redacted("OPENBOT_MODEL_API_KEY").pipe(
		Config.withDefault(Redacted.make("")),
	),
	model: Config.String("OPENBOT_MODEL_ID").pipe(Config.withDefault("")),
}).pipe(
	Config.flatMap((settings) =>
		settings.endpoint === "" &&
		Redacted.value(settings.apiKey) === "" &&
		settings.model === ""
			? Config.succeed(Option.none())
			: Config.all({
					endpoint: Config.schema(Endpoint, "OPENBOT_MODEL_ENDPOINT"),
					apiKey: Config.NonEmptyString("OPENBOT_MODEL_API_KEY").pipe(
						Config.map(Redacted.make),
					),
					model: Config.NonEmptyString("OPENBOT_MODEL_ID"),
				}).pipe(Config.map(Option.some)),
	),
)

/** Build one shared client and model inside the host's application scope. */
export const make = (
	settings: Settings,
): Effect.Effect<
	Sessions.Options,
	AiError.AiError,
	HttpClient.HttpClient | Scope.Scope
> =>
	Effect.gen(function* () {
		const provider = OpenAiCompatProvider.make()
		const selection = ModelConfig.Selection.make({
			provider: Provider.Id.make("openai-compat"),
			model: Model.Id.make(settings.model),
		})
		const configured = yield* provider.model(selection)
		const context = yield* Layer.build(
			configured.pipe(
				Layer.provide(
					OpenAiCompatProvider.layerClient({
						apiKey: settings.apiKey,
						apiUrl: settings.endpoint.replace(/\/$/, ""),
					}),
				),
			),
		)
		const model = Context.get(context, LanguageModel.LanguageModel)
		const resolveModel: NonNullable<Sessions.Options["resolveModel"]> = (
			requested,
		) =>
			Effect.gen(function* () {
				const current = requested ?? selection
				if (current.provider !== selection.provider)
					return yield* new ModelConfig.ModelConfigurationError({
						reason: "provider-not-found",
						message: "The configured model provider is unavailable",
					})
				if (current.model !== selection.model)
					return yield* new ModelConfig.ModelConfigurationError({
						reason: "model-not-found",
						message: "The configured model is unavailable",
					})
				if (
					current.reasoningEffort !== undefined ||
					current.serviceTier !== undefined
				)
					return yield* new ModelConfig.ModelConfigurationError({
						reason: "unsupported-option",
						message:
							"The configured model does not offer reasoning effort or service tiers",
					})
				return model
			})
		return {
			modelCatalog: Effect.succeed({
				providers: [
					{
						id: selection.provider,
						name: "OpenAI compatible",
						endpoint: settings.endpoint,
					},
				],
				models: [
					ModelConfig.Model.make({
						provider: selection.provider,
						id: selection.model,
						name: settings.model,
						reasoningEfforts: [],
						serviceTiers: [],
					}),
				],
			}),
			defaults: Effect.succeed({ model: selection }),
			resolveModel,
			layerExecution: () => Layer.succeed(LanguageModel.LanguageModel, model),
		}
	})
