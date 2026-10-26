import { Chat, Turn } from "@openbot-build/core"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import * as AppExecution from "./AppExecution.ts"
import { ExperienceErrors } from "./ExperienceErrors.ts"
import { Required, own } from "./Authorization.ts"
import { chatParams } from "./ChatsApi.ts"

/**
 * Code Mode lets the Bot write a short JavaScript program that calls App tools.
 * The program runs in a sandbox: a closed place with no network and no files.
 * Each App call in it goes through the same capability check as a normal App tool call.
 */

/** The longest program that the Bot can send, in characters. */
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
	operationId: Schema.String,
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
	id: Schema.String,
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
	run: Schema.String,
	index: Schema.Natural,
	/** The whole program, so a decider can see what the call is for. */
	code: Schema.String,
})
export type RequestCode = typeof RequestCode.Type

export const CodeRunsApi = HttpApiGroup.make("codeRuns").add(
	HttpApiEndpoint.get("get", "/v1/code-runs/:id", {
		params: { id: Schema.String },
		success: CodeRun,
		error: ExperienceErrors,
	}),
	HttpApiEndpoint.get("list", "/v1/chats/:chatId/code-runs", {
		params: chatParams,
		success: Schema.Array(CodeRun),
		error: ExperienceErrors,
	}).annotate(Required, [own("read", "Chat", "chatId")]),
)
