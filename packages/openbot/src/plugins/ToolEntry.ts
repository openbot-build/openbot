import { Operation } from "@openbot-build/core"
import { Cause, Effect, type JsonSchema, Schema } from "effect"
import { Tool, type Toolkit } from "effect/ai"
import { toolJson } from "./ToolJson.ts"

/** Tools whose parameters are JSON Schema, like App tools. Their handlers never fail. */
export type Tools = Record<
	string,
	Tool.Tool<
		string,
		{
			readonly parameters: typeof Schema.Unknown
			readonly success: typeof Schema.Json
			readonly failure: typeof Schema.Never
			readonly failureMode: "error"
		}
	>
>

/** What a handler knows about its tool call. */
export type CallContext = Toolkit.HandlerContext<Tools[string]>

/** A tool and its handler. */
export interface Entry {
	readonly tool: Tools[string]
	readonly handle: (
		input: unknown,
		context: CallContext,
	) => Effect.Effect<Schema.Json>
}

/**
 * Makes a tool that stays in its Turn. The handler may fail: the log gets the cause,
 * and the model gets `failure` as a short error result. An interruption stays an
 * interruption.
 */
export const entry = <E>(
	name: string,
	description: string,
	parameters: JsonSchema.JsonSchema,
	handle: (
		input: unknown,
		context: CallContext,
	) => Effect.Effect<Schema.Json, E>,
	options: {
		/** The log message when the handler fails. */
		readonly log: string
		/** What the model reads when the handler fails. */
		readonly failure: string
		readonly needsApproval?: (
			input: unknown,
			context: Tool.NeedsApprovalContext,
		) => Effect.Effect<boolean>
	},
): Entry => ({
	tool: Tool.dynamic(name, {
		description,
		parameters,
		success: Schema.Json,
		...(options.needsApproval === undefined
			? {}
			: { needsApproval: options.needsApproval }),
	}).annotate(Operation.Budget, "foreground"),
	handle: (input, context) =>
		handle(input, context).pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.logWarning(options.log, cause).pipe(
							Effect.as(toolJson({ error: options.failure })),
						),
			),
		),
})
