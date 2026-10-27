import { Context, Duration, Effect } from "effect"
import { Prompt, type Tool, type Toolkit } from "effect/ai"
import type { ToolRegistration } from "../bot/Bot.ts"

/** Combine tool definitions and ordered hooks without wrapping the execution. */
export const merge = <
	L extends Record<string, Tool.Any>,
	R extends Record<string, Tool.Any>,
	LE,
	LR,
	RE,
	RR,
>(
	left: ToolRegistration<L, LE, LR>,
	right: ToolRegistration<R, RE, RR>,
): ToolRegistration<
	Toolkit.MergedTools<[Toolkit.Toolkit<L>, Toolkit.Toolkit<R>]>,
	LE | RE,
	LR | RR
> => {
	const timeLimit =
		left.timeLimit === undefined
			? right.timeLimit
			: right.timeLimit === undefined
				? left.timeLimit
				: Duration.isLessThanOrEqualTo(
							left.timeLimit.duration,
							right.timeLimit.duration,
					  )
					? left.timeLimit
					: right.timeLimit
	return {
		tools: { ...left.tools, ...right.tools } as unknown as Toolkit.MergedTools<
			[Toolkit.Toolkit<L>, Toolkit.Toolkit<R>]
		>,
		// Tool handlers have the same right-side precedence as the definitions above.
		handlers: Context.merge(left.handlers, right.handlers) as Context.Context<
			Tool.HandlersFor<
				Toolkit.MergedTools<[Toolkit.Toolkit<L>, Toolkit.Toolkit<R>]>
			>
		>,
		...(timeLimit === undefined ? {} : { timeLimit }),
		instructions: Prompt.concat(
			left.instructions ?? Prompt.empty,
			right.instructions ?? Prompt.empty,
		),
		beforeStep: (step) =>
			(left.beforeStep?.(step) ?? Effect.succeed(true)).pipe(
				Effect.flatMap((allowed) =>
					allowed
						? (right.beforeStep?.(step) ?? Effect.succeed(true))
						: Effect.succeed(false),
				),
			),
		afterStep: (step) =>
			Effect.andThen(
				left.afterStep?.(step) ?? Effect.void,
				() => right.afterStep?.(step) ?? Effect.void,
			),
		transformPrompt: (prompt) =>
			(left.transformPrompt?.(prompt) ?? Effect.succeed(prompt)).pipe(
				Effect.flatMap(
					(changed) =>
						right.transformPrompt?.(changed) ?? Effect.succeed(changed),
				),
			),
	}
}
