import { Document } from "@openbot-build/protocol"
import { Schema } from "effect"
import * as Index from "./AppIndexApi.ts"
import { Availability, ConnectionId } from "./ConnectionsApi.ts"

// tsdown drops star exports from the built API namespace. List the names here.
export {
	AppOperationId,
	Outcome,
	Source,
	Result,
	InvocationStatus,
	Invocation,
	ExecutionView,
} from "@openbot-build/domain/AppCalls"
import { Result } from "@openbot-build/domain/AppCalls"

export const AccessConnection = Schema.Struct({
	id: ConnectionId,
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
