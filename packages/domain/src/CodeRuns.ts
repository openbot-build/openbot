import { Chat, Turn } from "@openbot-build/core"
import { Schema } from "effect"
import * as Execution from "./Execution.ts"
import * as AppExecution from "./AppCalls.ts"

/**
 * Code Mode lets the Bot write a short JavaScript program that calls App tools.
 * The program runs in a sandbox: a closed place with no network and no files.
 * Each App call in it goes through the same capability check as a normal App tool call.
 */

/** The longest program that the Bot can send, in characters. */
export const CodeRunId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/CodeRunId"))
export type CodeRunId = typeof CodeRunId.Type

export const maxCodeLength = 100_000
export const Code = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(maxCodeLength),
)

/** What happened to one App call of a program. */
export const CallOutcome = Schema.TaggedUnion({
	/** The call waits for a decision. */
	Waiting: {},
	/** A decider said no. The program got an error for this call. */
	Denied: { reason: Schema.String },
	/** The call ran. This is the App result that the program got. */
	Done: { result: AppExecution.Result },
})
export type CallOutcome = typeof CallOutcome.Type

export const CodeCall = Schema.Struct({
	/** The place of the call in the program, from 0. */
	index: Schema.Natural,
	/** The name that the program used, such as `apps.calendar.list_events`. */
	binding: Schema.String,
	source: AppExecution.Source,
	/** The App operation of the call. Read it at `/v1/app-operations/:id`. */
	operationId: Schema.optionalKey(AppExecution.AppOperationId),
	outcome: CallOutcome,
})
export type CodeCall = typeof CodeCall.Type

export const FailureReason = Schema.Literals([
	/** The program threw an error that it did not catch. */
	"Error",
	"Timeout",
	"Memory",
	/** The program sent back more output than the platform allows. */
	"OutputTooLarge",
	/** The program made other calls than the last time it ran, so OpenBot stopped it. */
	"ReplayMismatch",
	"Cancelled",
	/** OpenBot could not run or save the program. */
	"Unavailable",
])
export type FailureReason = typeof FailureReason.Type

/** The end of a program. The Bot gets this as the result of its tool call. */
export const CodeResult = Schema.TaggedUnion({
	Completed: {
		/** The value that the program returned, as JSON. */
		value: Schema.Json,
		logs: Schema.Array(Schema.String),
	},
	Failed: {
		reason: FailureReason,
		message: Schema.String,
		logs: Schema.Array(Schema.String),
	},
})
export type CodeResult = typeof CodeResult.Type

export const CodeRunStatus = Schema.Literals([
	"Running",
	"Waiting",
	"Completed",
	"Failed",
	"Cancelled",
])
export type CodeRunStatus = typeof CodeRunStatus.Type

/** One program and all its App calls. */
export const CodeRun = Schema.Struct({
	id: CodeRunId,
	chat: Chat.Id,
	turn: Turn.Id,
	/** The tool call of the Bot that started the program. */
	callId: Schema.String,
	status: CodeRunStatus,
	code: Schema.String,
	/** Why the Bot runs the program, in its own words. */
	reason: Schema.String,
	calls: Schema.Array(CodeCall),
	result: Schema.NullOr(CodeResult),
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type CodeRun = typeof CodeRun.Type

/** A capability request from a program names the program and the call. */
export const RequestCode = Schema.Struct({
	run: CodeRunId,
	index: Schema.Natural,
	/** The whole program, so a decider can see what the call is for. */
	code: Schema.String,
})
export type RequestCode = typeof RequestCode.Type

/** A program keeps its chosen App declarations. It never stores a live client. */
export const Binding = Schema.Struct({
	alias: Schema.String,
	source: AppExecution.Source,
})
export type Binding = typeof Binding.Type

/** Internal failure details stay in the sealed error record. */
export const Output = Schema.TaggedUnion({
	Completed: { value: Schema.Json, logs: Schema.Array(Schema.String) },
	Failed: {
		reason: FailureReason,
		failure: Execution.Failure,
		logs: Schema.Array(Schema.String),
	},
})
export type Output = typeof Output.Type

export const CallView = Schema.Struct({
	index: Schema.Natural,
	binding: Schema.String,
	app: Schema.NullOr(AppExecution.ExecutionView),
	rejection: Schema.NullOr(
		Schema.Struct({ name: Schema.String, message: Schema.String }),
	),
})
export type CallView = typeof CallView.Type

export const ExecutionView = Schema.Struct({
	calls: Schema.Array(CallView),
	id: CodeRunId,
	executionId: Execution.Id,
	chat: Chat.Id,
	turn: Turn.Id,
	callId: Schema.String,
	code: Code,
	reason: Schema.String,
	status: Execution.Status,
	failure: Schema.NullOr(Execution.Failure),
	result: Schema.NullOr(Output),
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type ExecutionView = typeof ExecutionView.Type
