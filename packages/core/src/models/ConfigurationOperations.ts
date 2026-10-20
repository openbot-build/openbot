import { Context, Effect, Layer, Option } from "effect"
import { dual } from "effect/Function"

import * as Config from "./Config.ts"

/** Works out the total capacity, usable input and compaction threshold from the catalog. */
export const contextLimits = (model: Config.Model): Config.ContextLimits => {
	const configured = model.contextWindow ?? model.maxContextWindow
	if (configured === undefined) return {}
	const contextWindow = Math.min(
		configured,
		model.maxContextWindow ?? configured,
	)
	const inputTokens = Math.min(
		Math.floor(
			(contextWindow * (model.effectiveContextWindowPercent ?? 100)) / 100,
		),
		contextWindow - (model.maxOutputTokens ?? 0),
		model.maxInputTokens ?? Infinity,
	)
	return {
		contextWindow,
		inputTokens,
		autoCompactTokens: Math.min(
			Math.floor(contextWindow * 0.9),
			inputTokens,
			model.autoCompactTokenLimit ?? Infinity,
		),
	}
}

export const modelConfiguration = <P>(
	input: Config.ModelConfigurationOptions<P>,
): Config.RuntimeModelConfiguration => ({
	get: input.store.read(input.session).pipe(
		Effect.flatMap((view) =>
			view.session.settings.model === undefined
				? Effect.fail(
						new Config.ModelConfigurationError({
							reason: "unavailable",
							message: "No model is selected for the current session",
						}),
					)
				: Effect.succeed(view.session.settings.model),
		),
	),
	select: (selection) =>
		Effect.gen(function* () {
			if (
				!input.providers.some((provider) => provider.id === selection.provider)
			)
				return yield* new Config.ModelConfigurationError({
					reason: "provider-not-found",
					message: "The provider does not exist",
				})
			const model = input.models.find(
				(model) =>
					model.provider === selection.provider && model.id === selection.model,
			)
			if (model === undefined)
				return yield* new Config.ModelConfigurationError({
					reason: "model-not-found",
					message: "The model does not exist",
				})
			if (
				(selection.reasoningEffort !== undefined &&
					!model.reasoningEfforts.includes(selection.reasoningEffort)) ||
				(selection.serviceTier !== undefined &&
					!model.serviceTiers.includes(selection.serviceTier))
			)
				return yield* new Config.ModelConfigurationError({
					reason: "unsupported-option",
					message: "The model does not support the selected options",
				})
			const before = yield* input.store.read(input.session)
			yield* input.store.updateSettings({
				expected: before.session,
				settings: { ...before.session.settings, model: selection },
			})
			return selection
		}),
	listProviders: Effect.succeed(input.providers),
	listModels: (provider) =>
		Effect.succeed(
			input.models.filter(
				(model) => provider === undefined || model.provider === provider,
			),
		),
})

export const executionMode = <P>(
	input: Config.ExecutionModeOptions<P>,
): Config.RuntimeExecutionMode => ({
	get: input.store
		.read(input.session)
		.pipe(Effect.map((view) => view.session.settings.mode)),
	set: (mode) =>
		input.store
			.modifyEffect({
				session: input.session,
				update: (current) =>
					Effect.succeed([
						mode,
						Option.some({
							session: { settings: { ...current.session.settings, mode } },
						}),
					] as const),
			})
			.pipe(Effect.map(({ result }) => result)),
})

export const layerModelConfiguration: {
	<P>(
		input: Config.ModelConfigurationOptions<P>,
	): <I>(
		tag: Context.Service<I, Config.RuntimeModelConfiguration>,
	) => Layer.Layer<I>
	<I, P>(
		tag: Context.Service<I, Config.RuntimeModelConfiguration>,
		input: Config.ModelConfigurationOptions<P>,
	): Layer.Layer<I>
} = dual(
	2,
	<I, P>(
		tag: Context.Service<I, Config.RuntimeModelConfiguration>,
		input: Config.ModelConfigurationOptions<P>,
	) => Layer.succeed(tag, modelConfiguration(input)),
)

export const layerExecutionMode = <P>(input: Config.ExecutionModeOptions<P>) =>
	Layer.succeed(Config.ExecutionMode, {
		get: executionMode(input).get.pipe(
			Effect.mapError(
				(error) =>
					new Config.ExecutionModeError({
						reason: "session-not-found",
						message: error.toString(),
					}),
			),
		),
		set: (mode) =>
			executionMode(input)
				.set(mode)
				.pipe(
					Effect.mapError(
						(error) =>
							new Config.ExecutionModeError({
								reason: "unavailable",
								message: error.toString(),
							}),
					),
				),
	})
