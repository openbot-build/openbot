import { Context, Duration, Effect, Option, Predicate, Schema } from "effect"
import { Prompt } from "effect/ai"
import { Plugin } from "@openbot-build/core"

export interface Options {
	/** Maximum time for one execution, for example `"5 minutes"`. */
	readonly maxDuration: Duration.Input
}

/**
 * Any form of `Duration.Input`. It checks only the kind of the value,
 * because the error must keep a bad input as it was given.
 */
const DurationInput = Schema.declare(
	(value: unknown): value is Duration.Input =>
		Predicate.isNumber(value) ||
		Predicate.isBigInt(value) ||
		Predicate.isString(value) ||
		Predicate.isObjectOrArray(value),
)

export class InvalidMaxDuration extends Schema.TaggedError<
	InvalidMaxDuration,
	{ readonly brand: unique symbol }
>()("InvalidMaxDuration", { maxDuration: DurationInput }) {}

export class TimeLimitExceeded extends Schema.TaggedError<
	TimeLimitExceeded,
	{ readonly brand: unique symbol }
>()("TimeLimitExceeded", {
	maxDuration: Schema.Duration,
	history: Prompt.Prompt,
}) {}

/**
 * Declares a time limit. The runner applies it from the saved Turn start.
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
	return Plugin.make({
		id: Plugin.Id.make("@openbot-build/openbot/time-limiter"),
	})<{}, InvalidMaxDuration | TimeLimitExceeded>(() =>
		Effect.succeed({
			tools: {},
			handlers: Context.empty(),
			beforeStep: () =>
				Option.isNone(duration)
					? Effect.fail(InvalidMaxDuration.make({ maxDuration }))
					: Effect.succeed(true),
			...(Option.isNone(duration)
				? {}
				: {
						timeLimit: {
							duration: duration.value,
							error: (history: Prompt.Prompt) =>
								TimeLimitExceeded.make({
									maxDuration: duration.value,
									history,
								}),
						},
					}),
		}),
	)
}
