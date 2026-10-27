import { AppCalls, AppConnections, ConnectionId } from "@openbot-build/domain"
import { Document } from "@openbot-build/protocol"
import { Schema } from "effect"
import * as Index from "./IndexModels.ts"

/** Tool results join product state with public protocol descriptions. */
export const Assistance = Schema.TaggedUnion({
	AppCandidates: { page: Index.Page },
	AppDetails: { app: Index.App },
	AppAccess: {
		connections: Schema.Array(
			Schema.Struct({
				id: ConnectionId,
				name: Schema.String,
				cardUrl: Document.Link,
				revision: Schema.Natural,
				enabled: Schema.Boolean,
				availability: AppConnections.Availability,
			}),
		),
	},
	AppAssistanceFailed: { reason: Schema.String, message: Schema.String },
})
export type Assistance = typeof Assistance.Type
export const ToolResult = Schema.Union([AppCalls.Result, Assistance])
export type ToolResult = typeof ToolResult.Type
