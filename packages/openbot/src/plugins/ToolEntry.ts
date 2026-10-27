import { Execution } from "@openbot-build/domain"
import { Operation } from "@openbot-build/core"
import { Cause, Context, Effect, type JsonSchema, Option, Schema } from "effect"
import { Tool, type Toolkit } from "effect/ai"
import { Records, category } from "../errors/Records.ts"

/** The handler commits a durable command receipt before returning its result. */
export const Idempotent = Context.Reference<boolean>(
	"@openbot-build/openbot/tools/Idempotent",
	{ defaultValue: () => false },
)

/** The handler uses only pure work and fenced commands. Outside work has its own execution. */
export const Local = Context.Reference<boolean>(
	"@openbot-build/openbot/tools/Local",
	{ defaultValue: () => false },
)

/** Plain feature data fixed when the model selects a tool. It contains references, not secrets. */
export const InputState = Context.Reference<Schema.Json | undefined>(
	"@openbot-build/openbot/tools/InputState",
	{ defaultValue: () => undefined },
)

/** Read an existing command result only. None means that a new send still needs permission. */
export const SavedResult = Context.Reference<
	| ((
			id: Execution.CallId,
			input: unknown,
	  ) => Effect.Effect<Option.Option<Schema.Json>, Execution.Failure>)
	| undefined
>("@openbot-build/openbot/tools/SavedResult", { defaultValue: () => undefined })

/** A review Turn may read and stop background calls as well as decide its request. */
export const ReviewAllowed = Context.Reference<boolean>(
	"@openbot-build/openbot/tools/ReviewAllowed",
	{ defaultValue: () => false },
)

/** A plan may keep its todo list, set a reminder, and submit itself. */
export const PlanAllowed = Context.Reference<boolean>(
	"@openbot-build/openbot/tools/PlanAllowed",
	{ defaultValue: () => false },
)

/** Tools whose parameters are JSON Schema, like App tools. Their handlers keep execution failures in the error channel. */
export type Tools = Record<
	string,
	Tool.Tool<
		string,
		{
			readonly parameters: typeof Schema.Unknown
			readonly success: typeof Schema.Json
			readonly failure: typeof Schema.Never | typeof Execution.Failure
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
	) => Effect.Effect<Schema.Json, Execution.Failure>
}

/**
 * Makes a tool that stays in its Turn. Its saved failures keep their ID.
 * Other typed failures get a sealed record before they leave the handler.
 * Defects and interruption keep their execution control meaning.
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
		readonly records: Records["Service"]
		readonly executionId: Execution.Id
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
		failure: Execution.Failure,
		...(options.needsApproval === undefined
			? {}
			: { needsApproval: options.needsApproval }),
	}).annotate(Operation.Budget, "foreground"),
	handle: (input, context) =>
		handle(input, context).pipe(
			Effect.catchCause((cause) => {
				if (Cause.hasInterrupts(cause) || Cause.hasDies(cause))
					return Effect.failCause(cause).pipe(Effect.orDie)
				const reason = cause.reasons[0]
				if (
					cause.reasons.length === 1 &&
					reason?._tag === "Fail" &&
					Schema.is(Execution.Failure)(reason.error)
				) {
					const failure = reason.error
					return Effect.failCause(Cause.map(cause, () => failure))
				}
				return options.records
					.record(cause, category(cause), options.executionId)
					.pipe(Effect.orDie, Effect.flatMap(Effect.fail))
			}),
		),
})
