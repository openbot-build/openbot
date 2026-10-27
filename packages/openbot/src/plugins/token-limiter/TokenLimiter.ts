import { Array as Arr, Context, Effect, Schema } from "effect"
import { Prompt } from "effect/ai"
import { Plugin } from "@openbot-build/core"

export interface Options {
	/** Maximum number of input and output tokens in one execution. */
	readonly maxTokens: number
}

export class InvalidMaxTokens extends Schema.TaggedError<
	InvalidMaxTokens,
	{ readonly brand: unique symbol }
>()("InvalidMaxTokens", {
	// @effect-diagnostics-next-line schemaNumber:off -- The value is the bad input, so it can be NaN or Infinity.
	maxTokens: Schema.Number,
}) {}

export class TokenLimitExceeded extends Schema.TaggedError<
	TokenLimitExceeded,
	{ readonly brand: unique symbol }
>()("TokenLimitExceeded", {
	maxTokens: Schema.Int,
	usedTokens: Schema.Int,
	history: Prompt.Prompt,
}) {}

/**
 * Checks saved usage before each model step, including after recovery.
 * A model step that has started can finish. The next step fails when the
 * used tokens reach the limit.
 */
export const make = ({
	maxTokens,
}: Options): Plugin.Plugin<{}, InvalidMaxTokens | TokenLimitExceeded> => {
	const valid = Number.isSafeInteger(maxTokens) && maxTokens >= 1
	return Plugin.make({
		id: Plugin.Id.make("@openbot-build/openbot/token-limiter"),
	})<{}, InvalidMaxTokens | TokenLimitExceeded>(() =>
		Effect.succeed({
			tools: {},
			handlers: Context.empty(),
			beforeStep: ({ turn, history, kind }) => {
				if (!valid) return Effect.fail(InvalidMaxTokens.make({ maxTokens }))
				const usedTokens = Arr.reduce(
					turn.usage ?? [],
					0,
					(total, usage) =>
						total +
						(usage.inputTokens.total ?? 0) +
						(usage.outputTokens.total ?? 0),
				)
				return kind === "model" && usedTokens >= maxTokens
					? Effect.fail(
							TokenLimitExceeded.make({ maxTokens, usedTokens, history }),
						)
					: Effect.succeed(true)
			},
		}),
	)
}
