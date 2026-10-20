import { Schema, type Layer } from "effect"
import { Model as AiModel, type LanguageModel } from "effect/ai"
import type * as Provider from "./Provider.ts"

export const Id = Schema.String.pipe(
	Schema.brand("@openbot-build/core/ModelId"),
)
export type Id = typeof Id.Type

/** A native model Layer that provides LanguageModel and its provider/model identity. */
export interface Model<R = never> extends AiModel.Model<
	Provider.Id,
	LanguageModel.LanguageModel,
	R
> {}

/** Creates a native model without building its Layer or starting generation. */
export const make = <R>(options: {
	readonly provider: Provider.Id
	readonly model: Id
	readonly layer: Layer.Layer<LanguageModel.LanguageModel, never, R>
}): Model<R> => AiModel.make(options.provider, options.model, options.layer)
