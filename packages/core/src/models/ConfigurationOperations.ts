import { Array as Arr, Context, Effect, Layer, Option } from "effect"
import { dual } from "effect/Function"

import type * as Chat from "../chat/Chat.ts"
import type * as ChatStore from "../store/ChatStore.ts"
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

/** The providers and models that a selection can use. */
export interface Catalog {
	readonly providers: ReadonlyArray<Config.Provider>
	readonly models: ReadonlyArray<Config.Model>
}
/** Why a selection does not fit the catalog, in words for people. */
export interface SelectionProblem {
	readonly reason: Config.SelectionReason
	readonly message: string
}

/**
 * Checks a selection against a catalog. It gives the first problem, or none
 * when the catalog offers the provider, the model and the selected options.
 */
export const selectionProblem: {
	(
		selection: Config.Selection,
	): (catalog: Catalog) => Option.Option<SelectionProblem>
	(
		catalog: Catalog,
		selection: Config.Selection,
	): Option.Option<SelectionProblem>
} = dual(
	2,
	(
		catalog: Catalog,
		selection: Config.Selection,
	): Option.Option<SelectionProblem> => {
		if (
			!Arr.some(
				catalog.providers,
				(provider) => provider.id === selection.provider,
			)
		)
			return Option.some({
				reason: "provider-not-found",
				message: "The provider does not exist",
			})
		const model = Arr.findFirst(
			catalog.models,
			(model) =>
				model.provider === selection.provider && model.id === selection.model,
		)
		if (Option.isNone(model))
			return Option.some({
				reason: "model-not-found",
				message: "The model does not exist",
			})
		if (
			(selection.reasoningEffort !== undefined &&
				!Arr.contains(
					model.value.reasoningEfforts,
					selection.reasoningEffort,
				)) ||
			(selection.serviceTier !== undefined &&
				!Arr.contains(model.value.serviceTiers, selection.serviceTier))
		)
			return Option.some({
				reason: "unsupported-option",
				message: "The model does not support the selected options",
			})
		return Option.none()
	},
)

export const modelConfiguration = <P>(
	input: Config.ModelConfigurationOptions<P>,
): Config.RuntimeModelConfiguration => ({
	get: input.store.read(input.chat).pipe(
		Effect.flatMap((view) =>
			view.chat.settings.model === undefined
				? Effect.fail(
						Config.ModelConfigurationError.make({
							reason: "missing",
							message: "No model is selected for the current Chat",
						}),
					)
				: Effect.succeed(view.chat.settings.model),
		),
	),
	select: (selection) =>
		Effect.gen(function* () {
			const problem = selectionProblem(input, selection)
			if (Option.isSome(problem))
				return yield* Config.ModelConfigurationError.make(problem.value)
			yield* input.store.modifyEffect({
				chat: input.chat,
				update: (current) =>
					Effect.succeed([
						undefined,
						Option.some({
							chat: {
								settings: { ...current.chat.settings, model: selection },
							},
						}),
					] as const),
			})
			return selection
		}),
	listProviders: Effect.succeed(input.providers),
	listModels: (provider) =>
		Effect.succeed(
			Arr.filter(
				input.models,
				(model) => provider === undefined || model.provider === provider,
			),
		),
})

export const executionMode = <P>(
	input: Config.ExecutionModeOptions<P>,
): Config.RuntimeExecutionMode => ({
	get: input.store
		.read(input.chat)
		.pipe(Effect.map((view) => view.chat.settings.mode)),
	set: (mode) =>
		input.store
			.modifyEffect({
				chat: input.chat,
				update: (current) =>
					Effect.succeed([
						mode,
						Option.some({
							chat: { settings: { ...current.chat.settings, mode } },
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

const executionModeMessages = {
	ChatNotFound: "The Chat does not exist",
	ChatConflict: "Another change to the Chat came first",
	ChatStoreError: "The Chat store is unavailable",
} as const

const toExecutionModeError = (
	error: Chat.ChatNotFound | Chat.Conflict | ChatStore.ChatStoreError,
) =>
	Config.ExecutionModeError.make({
		reason: error._tag === "ChatNotFound" ? "chat-not-found" : "unavailable",
		message: executionModeMessages[error._tag],
		cause: error,
	})

export const layerExecutionMode = <P>(
	input: Config.ExecutionModeOptions<P>,
) => {
	const operations = executionMode(input)
	return Layer.succeed(Config.ExecutionMode, {
		get: operations.get.pipe(Effect.mapError(toExecutionModeError)),
		set: (mode) =>
			operations.set(mode).pipe(Effect.mapError(toExecutionModeError)),
	})
}
