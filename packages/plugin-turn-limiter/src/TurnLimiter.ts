import { Data, Effect, Match, Stream } from "effect"
import { type Prompt } from "effect/ai"
import { Agent, Plugin } from "@openbot-build/core"

export interface Options {
	/** Maximum number of model requests, including the first request. */
	readonly maxSteps: number
}

export class InvalidMaxSteps extends Data.TaggedError("InvalidMaxSteps")<{
	readonly maxSteps: number
}> {}

export class ModelStepLimitExceeded extends Data.TaggedError(
	"ModelStepLimitExceeded",
)<{
	readonly maxSteps: number
	readonly history: Prompt.Prompt
}> {}

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
				if (!valid) return yield* new InvalidMaxSteps({ maxSteps })

				const context = yield* Agent.Context
				return next(options).pipe(
					Stream.tap((event) =>
						Match.value(event).pipe(
							Match.tag("ModelStepStarted", () =>
								Effect.gen(function* () {
									const step = yield* context.step
									if (step > maxSteps) {
										const history = yield* context.history
										return yield* new ModelStepLimitExceeded({
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
		id: Plugin.Id.make("@openbot-build/plugin-turn-limiter"),
	})(() => Effect.succeed(middleware))
}
