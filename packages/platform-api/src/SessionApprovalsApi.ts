import { Turn } from "@openbot-build/core"
import { Session } from "@openbot-build/core"
import { Schema } from "effect"
import * as AppExecution from "./AppExecution.ts"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import {
	SessionOperationErrors,
	SessionExecutionUnavailable,
	SessionResponse,
} from "./SessionsApi.ts"

export const ToolApproval = Schema.Struct({
	turn: Turn.Id,
	approvalId: Schema.String,
	toolCallId: Schema.String,
	toolName: Schema.String,
	arguments: Schema.JsonObject,
	app: Schema.optionalKey(AppExecution.Invocation),
})
export type ToolApproval = typeof ToolApproval.Type

export const SessionApprovalsApi = HttpApiGroup.make("approvals").add(
	HttpApiEndpoint.get("list", "/v1/sessions/:sessionId/approvals", {
		params: { sessionId: Session.Id },
		success: Schema.Array(ToolApproval),
		error: SessionOperationErrors,
	}),
	HttpApiEndpoint.post(
		"resolve",
		"/v1/sessions/:sessionId/turns/:turnId/approvals/:approvalId",
		{
			params: {
				sessionId: Session.Id,
				turnId: Turn.Id,
				approvalId: Schema.String,
			},
			payload: Schema.Struct({
				expected: Session.Revision,
				approved: Schema.Boolean,
				grantReads: Schema.optionalKey(Schema.Boolean),
				reason: Schema.optionalKey(Schema.String),
			}),
			success: SessionResponse.pipe(HttpApiSchema.status(202)),
			error: [
				...SessionOperationErrors,
				SessionExecutionUnavailable.pipe(HttpApiSchema.status(503)),
			],
		},
	),
)
