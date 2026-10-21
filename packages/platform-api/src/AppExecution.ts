import { Document } from "@openbot-build/protocol"
import { Schema } from "effect"
import { Session, Turn } from "@openbot-build/core"
import * as Index from "./AppIndexApi.ts"
import { Availability } from "./ConnectionsApi.ts"

/** Safe source details for one live capability. It never contains configured secrets. */
export const Source = Schema.Struct({
	connectionId: Schema.String,
	connectionName: Schema.String,
	cardUrl: Document.Link,
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
		operationId: Schema.optionalKey(Schema.String),
	},
	InputRequired: {
		source: Source,
		request: Schema.Json,
		operationId: Schema.optionalKey(Schema.String),
	},
	Failed: {
		source: Source,
		reason: Schema.String,
		cause: Schema.optionalKey(Schema.String),
		message: Schema.String,
		result: Schema.optionalKey(Schema.Json),
		operationId: Schema.optionalKey(Schema.String),
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
	id: Schema.String,
	session: Session.Id,
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

export const AccessConnection = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	cardUrl: Document.Link,
	revision: Schema.Natural,
	enabled: Schema.Boolean,
	availability: Availability,
})
export const Assistance = Schema.TaggedUnion({
	AppCandidates: { page: Index.Page },
	AppDetails: { app: Index.App },
	AppAccess: { connections: Schema.Array(AccessConnection) },
	AppAssistanceFailed: { reason: Schema.String, message: Schema.String },
})
export type Assistance = typeof Assistance.Type
export const ToolResult = Schema.Union([Result, Assistance])
export type ToolResult = typeof ToolResult.Type
