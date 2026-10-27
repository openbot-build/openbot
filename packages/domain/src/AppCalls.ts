import { Schema, SchemaTransformation, String as Str } from "effect"
import { Chat, Turn } from "@openbot-build/core"
import * as Execution from "./Execution.ts"
import { ConnectionId } from "./ConnectionId.ts"

export const AppOperationId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/AppOperationId"))
export type AppOperationId = typeof AppOperationId.Type

/** Saved App identity is an HTTPS address with no credentials or fragment. */
const cardUrl = Schema.URLFromString.check(
	Schema.makeFilter(
		(url) =>
			(url.protocol === "https:" &&
				url.username === "" &&
				url.password === "") ||
			"Expected an absolute HTTPS URL without credentials",
	),
).pipe(
	Schema.decodeTo(Schema.flip(Schema.URLFromString)),
	Schema.decode(
		SchemaTransformation.transform({
			decode: Str.replace(/#.*$/s, ""),
			encode: Str.replace(/#.*$/s, ""),
		}),
	),
)

/** Safe source details for one live capability. It never contains configured secrets. */
export const Source = Schema.Struct({
	connectionId: ConnectionId,
	connectionName: Schema.String,
	cardUrl,
	appName: Schema.String,
	remoteIndex: Schema.Natural,
	revision: Schema.Natural,
	kind: Schema.Literals(["tool", "resource", "template", "prompt"]),
	name: Schema.String,
	definition: Schema.optionalKey(Schema.Json),
})
export type Source = typeof Source.Type
export const Result = Schema.TaggedUnion({
	Completed: {
		source: Source,
		result: Schema.Json,
		operationId: Schema.optionalKey(AppOperationId),
	},
	InputRequired: {
		source: Source,
		request: Schema.Json,
		operationId: Schema.optionalKey(AppOperationId),
	},
	Failed: {
		source: Source,
		reason: Schema.String,
		cause: Schema.optionalKey(Schema.String),
		message: Schema.String,
		result: Schema.optionalKey(Schema.Json),
		operationId: Schema.optionalKey(AppOperationId),
	},
})
export type Result = typeof Result.Type

export const InvocationStatus = Schema.Literals([
	"PendingApproval",
	"Approved",
	"Rejected",
	"Sending",
	"InputRequired",
	"Completed",
	"Failed",
	"OutcomeUnknown",
])
export type InvocationStatus = typeof InvocationStatus.Type
export const Invocation = Schema.Struct({
	id: AppOperationId,
	chat: Chat.Id,
	turn: Turn.Id,
	callId: Schema.String,
	toolName: Schema.String,
	source: Source,
	arguments: Schema.JsonObject,
	readOnly: Schema.Boolean,
	round: Schema.Natural,
	status: InvocationStatus,
	result: Schema.NullOr(Result),
})
export type Invocation = typeof Invocation.Type

/** A workflow call keeps safe failures. The full cause stays in the sealed error record. */
export const Outcome = Schema.TaggedUnion({
	Completed: { result: Schema.Json },
	InputRequired: { request: Schema.JsonObject },
	Failed: { failure: Execution.Failure },
})
export type Outcome = typeof Outcome.Type

/** A public App call uses the shared execution state and safe result. */
export const ExecutionView = Schema.Struct({
	id: AppOperationId,
	executionId: Execution.Id,
	chat: Chat.Id,
	turn: Turn.Id,
	callId: Schema.String,
	toolName: Schema.String,
	source: Source,
	arguments: Schema.JsonObject,
	readOnly: Schema.Boolean,
	round: Schema.Natural,
	status: Execution.Status,
	result: Schema.NullOr(Outcome),
	failure: Schema.NullOr(Execution.Failure),
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type ExecutionView = typeof ExecutionView.Type
