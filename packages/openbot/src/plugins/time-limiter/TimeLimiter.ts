import { Data, Duration, Effect, Option, Stream } from "effect"
import { type Prompt } from "effect/ai"
import { Bot, Plugin } from "@openbot-build/core"

export interface Options {
	/** Maximum time for one execution, for example `"5 minutes"`. */
	readonly maxDuration: Duration.Input
}

export class InvalidMaxDuration extends Data.TaggedError("InvalidMaxDuration")<{
	readonly maxDuration: Duration.Input
}> {}

export class TimeLimitExceeded extends Data.TaggedError("TimeLimitExceeded")<{
	readonly maxDuration: Duration.Duration
	readonly history: Prompt.Prompt
}> {}

/**
 * Limits each execution on its own, through the ReAct middleware chain.
 * When the time is up, it stops the execution at once, also in the middle
 * of a model step or a tool call.
 */
export const make = ({
	maxDuration,
}: Options): Plugin.Plugin<{}, InvalidMaxDuration | TimeLimitExceeded> => {
	const duration = Option.filter(
		Duration.fromInput(maxDuration),
		(d) => Duration.isFinite(d) && Duration.isPositive(d),
	)
	const middleware: Plugin.Middleware<
		{},
		InvalidMaxDuration | TimeLimitExceeded
	> = (next, options) =>
		Stream.unwrap(
			Effect.gen(function* () {
				if (Option.isNone(duration))
					return yield* new InvalidMaxDuration({ maxDuration })

				const context = yield* Bot.Context
				return next(options).pipe(
					Stream.interruptWhen(
						Effect.sleep(duration.value).pipe(
							Effect.andThen(context.history),
							Effect.flatMap(
								(history) =>
									new TimeLimitExceeded({
										maxDuration: duration.value,
										history,
									}),
							),
						),
					),
				)
			}),
		)
	return Plugin.make({
		id: Plugin.Id.make("@openbot-build/openbot/time-limiter"),
	})(() => Effect.succeed(middleware))
}
