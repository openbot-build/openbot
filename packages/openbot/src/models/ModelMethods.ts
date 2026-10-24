import type { Effect, Stream } from "effect"
import type { AiError, LanguageModel, Response } from "effect/ai"

/**
 * The model methods in a plain form. The methods of `LanguageModel` are generic and
 * overloaded, so TypeScript cannot check a wrapper that only passes the options
 * through and gives back the same result. A wrapper uses this form, and the two casts
 * below are the only place that leaves the type checks.
 */
export interface Methods {
	readonly generateText: (
		options: unknown,
	) => Effect.Effect<{ readonly usage: Response.Usage }, AiError.AiError>
	readonly generateObject: (
		options: unknown,
	) => Effect.Effect<{ readonly usage: Response.Usage }, AiError.AiError>
	readonly streamText: (
		options: unknown,
	) => Stream.Stream<Response.StreamPart<{}>, AiError.AiError>
}

/** The methods of a model, in the plain form. */
export const methodsOf = (model: LanguageModel.LanguageModel): Methods =>
	model as unknown as Methods

/** The model with its methods changed for these ones. */
export const withMethods = (
	model: LanguageModel.LanguageModel,
	methods: Methods,
): LanguageModel.LanguageModel => ({
	...model,
	...(methods as unknown as Pick<LanguageModel.LanguageModel, keyof Methods>),
})
