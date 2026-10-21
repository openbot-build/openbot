import { dual } from "effect/Function"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Provider as CoreProvider, Model } from "@openbot-build/core"
import { type AiError, LanguageModel } from "effect/ai"
import { Effect, Layer, Context } from "effect"
import * as Request from "./Request.ts"

export type Defaults = Omit<typeof OpenAiLanguageModel.Config.Service, "model">

/** Requests are checked locally. The host gives the client when it builds a model. */
export type Provider = CoreProvider.Provider<
	AiError.AiError,
	never,
	OpenAiClient.OpenAiClient
>

export const make = (defaults: Defaults = {}): Provider =>
	new CoreProvider.Provider({
		id: CoreProvider.Id.make("openai"),
		model: (selection) =>
			Request.config(defaults)(selection).pipe(
				Effect.map((config) =>
					Model.make({
						provider: selection.provider,
						model: selection.model,
						layer: Layer.effect(
							LanguageModel.LanguageModel,
							Request.client(selection).pipe(
								Effect.flatMap((client) =>
									OpenAiLanguageModel.make({
										model: selection.model,
										config,
									}).pipe(
										Effect.provideService(OpenAiClient.OpenAiClient, client),
									),
								),
							),
						),
					}),
				),
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

/** The host owns the client Layer and its credentials. */
export const layerClient = OpenAiClient.layer
