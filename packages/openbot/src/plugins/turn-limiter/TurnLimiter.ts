import { Effect, Match, Schema, Stream } from "effect"
import { Prompt } from "effect/ai"
import { Bot, Plugin } from "@openbot-build/core"

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

/** Limits each execution on its own, through the ReAct middleware chain. */
export const make = ({
	maxSteps,
}: Options): Plugin.Plugin<{}, InvalidMaxSteps | ModelStepLimitExceeded> => {
	const valid = Number.isSafeInteger(maxSteps) && maxSteps >= 1
	const middleware: Plugin.Middleware<
		{},
		InvalidMaxSteps | ModelStepLimitExceeded
	> = (next, options) =>
		Stream.unwrap(
			Effect.gen(function* () {
				if (!valid) return yield* InvalidMaxSteps.make({ maxSteps })

				const context = yield* Bot.Context
				return next(options).pipe(
					Stream.tap((event) =>
						Match.value(event).pipe(
							Match.tag("ModelStepStarted", () =>
								Effect.gen(function* () {
									const step = yield* context.step
									if (step > maxSteps) {
										const history = yield* context.history
										return yield* ModelStepLimitExceeded.make({
											maxSteps,
											history,
										})
									}
								}),
							),
							Match.orElse(() => Effect.void),
						),
					),
				)
			}),
		)
	return Plugin.make({
		id: Plugin.Id.make("@openbot-build/openbot/turn-limiter"),
	})(() => Effect.succeed(middleware))
}
