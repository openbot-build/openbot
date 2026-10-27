import { Context, Effect, Schema } from "effect"
import { Prompt } from "effect/ai"
import { Plugin } from "@openbot-build/core"

export interface Options {
	/** Maximum number of model requests, including the first request. */
	readonly maxSteps: number
}

export class InvalidMaxSteps extends Schema.TaggedError<
	InvalidMaxSteps,
	{ readonly brand: unique symbol }
>()("InvalidMaxSteps", {
	// @effect-diagnostics-next-line schemaNumber:off -- The value is the bad input, so it can be NaN or Infinity.
	maxSteps: Schema.Number,
}) {}

export class ModelStepLimitExceeded extends Schema.TaggedError<
	ModelStepLimitExceeded,
	{ readonly brand: unique symbol }
>()("ModelStepLimitExceeded", {
	maxSteps: Schema.Int,
	history: Prompt.Prompt,
}) {}

/** Checks the saved step count before each model step. */
export const make = ({
	maxSteps,
}: Options): Plugin.Plugin<{}, InvalidMaxSteps | ModelStepLimitExceeded> => {
	const valid = Number.isSafeInteger(maxSteps) && maxSteps >= 1
	return Plugin.make({
		id: Plugin.Id.make("@openbot-build/openbot/turn-limiter"),
	})<{}, InvalidMaxSteps | ModelStepLimitExceeded>(() =>
		Effect.succeed({
			tools: {},
			handlers: Context.empty(),
			beforeStep: ({ step, history, kind }) => {
				if (!valid) return Effect.fail(InvalidMaxSteps.make({ maxSteps }))
				return kind === "model" && step > maxSteps
					? Effect.fail(ModelStepLimitExceeded.make({ maxSteps, history }))
					: Effect.succeed(true)
			},
		}),
	)
}
