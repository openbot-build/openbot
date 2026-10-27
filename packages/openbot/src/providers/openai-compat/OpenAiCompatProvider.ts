import { dual } from "effect/Function"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { Provider as CoreProvider, Model } from "@openbot-build/core"
import { type AiError } from "effect/ai"
import { Effect, Layer, Context, Predicate, Record as Rec } from "effect"

export type Defaults = Omit<typeof OpenAiLanguageModel.Config.Service, "model">

/** The host gives the client when it builds the selected model. */
export type Provider = CoreProvider.Provider<
	AiError.AiError,
	never,
	OpenAiClient.OpenAiClient
>

/** `upstreamModel` is the model name that the API gets. The default is the selected model ID. */
export interface Options {
	readonly upstreamModel?: string
}

export const make = ({
	upstreamModel,
	...defaults
}: Defaults & Options = {}): Provider =>
	new CoreProvider.Provider({
		id: CoreProvider.Id.make("openai-compat"),
		model: (selection) =>
			Effect.succeed(
				Model.make({
					provider: selection.provider,
					model: selection.model,
					layer: OpenAiLanguageModel.layer({
						model: upstreamModel ?? selection.model,
						config: {
							...defaults,
							...Rec.filter(
								{
									reasoning_effort: selection.reasoningEffort,
									service_tier: selection.serviceTier,
								},
								Predicate.isNotUndefined,
							),
						},
					}),
				}),
			),
	})

export const layer: {
	(
		defaults?: Defaults,
	): <I>(tag: Context.Service<I, Provider>) => Layer.Layer<I>
	<I>(tag: Context.Service<I, Provider>, defaults?: Defaults): Layer.Layer<I>
} = dual(
	(args) => Context.isKey(args[0]),
	<I>(tag: Context.Service<I, Provider>, defaults: Defaults = {}) =>
		Layer.succeed(tag, make(defaults)),
)

/** The host owns the client Layer, endpoint and credentials. */
export const layerClient = OpenAiClient.layer
