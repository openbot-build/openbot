import { Effect, Match, Ref, Schema, Stream } from "effect"
import { Prompt } from "effect/ai"
import { Bot, Plugin } from "@openbot-build/core"

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
 * Limits each execution on its own, through the ReAct middleware chain.
 * A model step that has started can finish. The next step fails when the
 * used tokens reach the limit.
 */
export const make = ({
	maxTokens,
}: Options): Plugin.Plugin<{}, InvalidMaxTokens | TokenLimitExceeded> => {
	const valid = Number.isSafeInteger(maxTokens) && maxTokens >= 1
	const middleware: Plugin.Middleware<
		{},
		InvalidMaxTokens | TokenLimitExceeded
	> = (next, options) =>
		Stream.unwrap(
			Effect.gen(function* () {
				if (!valid) return yield* InvalidMaxTokens.make({ maxTokens })

				const context = yield* Bot.Context
				const used = yield* Ref.make(0)
				return next(options).pipe(
					Stream.tap((event) =>
						Match.value(event).pipe(
							Match.tag("ResponsePart", ({ part }) =>
								part.type === "finish"
									? Ref.update(
											used,
											(total) =>
												total +
												(part.usage.inputTokens.total ?? 0) +
												(part.usage.outputTokens.total ?? 0),
										)
									: Effect.void,
							),
							Match.tag("ModelStepStarted", () =>
								Effect.gen(function* () {
									const usedTokens = yield* Ref.get(used)
									if (usedTokens >= maxTokens) {
										const history = yield* context.history
										return yield* TokenLimitExceeded.make({
											maxTokens,
											usedTokens,
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
		id: Plugin.Id.make("@openbot-build/openbot/token-limiter"),
	})(() => Effect.succeed(middleware))
}
