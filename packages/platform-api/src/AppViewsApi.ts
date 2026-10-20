import { Item, Memory, Session, Turn } from "@openbot-build/core"
import { Ui } from "@openbot-build/protocol"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Source, Invocation } from "./AppExecution.ts"
import { ExperienceErrors } from "./ExperienceErrors.ts"
import { AppRestricted } from "./ConnectionsApi.ts"
import { SessionConflict } from "./SessionsApi.ts"

export const Interaction = Schema.Struct({
	revision: Schema.Natural,
	context: Schema.NullOr(Schema.JsonObject),
})
export type Interaction = typeof Interaction.Type
export const Binding = Schema.Struct({
	id: Schema.String,
	operationId: Schema.String,
	readOnly: Schema.Boolean,
	session: Session.Id,
	turn: Turn.Id,
	item: Item.Id,
	source: Source,
	interaction: Interaction,
})
export type Binding = typeof Binding.Type
export const Opened = Schema.Struct({
	...Binding.fields,
	resource: Ui.Resource,
	tools: Schema.Array(Schema.JsonObject),
	arguments: Schema.JsonObject,
	result: Schema.optionalKey(Schema.JsonObject),
})
export type Opened = typeof Opened.Type
export const ActionSource = Schema.TaggedStruct("AppUiAction", {
	viewId: Schema.String,
	requestId: Schema.String,
	connectionId: Schema.String,
	revision: Schema.Natural,
	kind: Schema.Literals(["tool", "resource"]),
	target: Schema.String,
})
export type ActionSource = typeof ActionSource.Type
export const ActionTicket = Schema.Struct({
	session: Session.Id,
	turn: Turn.Id,
	item: Item.Id,
	callId: Schema.String,
	revision: Session.Revision,
	version: Memory.VersionId,
})
export type ActionTicket = typeof ActionTicket.Type
export const ActionRequest = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("tool"),
		requestId: Schema.NonEmptyString,
		name: Schema.NonEmptyString,
		arguments: Schema.JsonObject,
	}),
	Schema.Struct({
		kind: Schema.Literal("resource"),
		requestId: Schema.NonEmptyString,
		uri: Schema.NonEmptyString,
	}),
])
export type ActionRequest = typeof ActionRequest.Type
export const Observation = Schema.Struct({
	ticket: ActionTicket,
	status: Schema.Literals([
		"Queued",
		"PendingApproval",
		"Approved",
		"Rejected",
		"Sending",
		"InputRequired",
		"Completed",
		"Failed",
		"OutcomeUnknown",
	]),
	operation: Schema.NullOr(Invocation),
})
export class AppViewUnavailable extends Schema.TaggedError<AppViewUnavailable>()(
	"AppViewUnavailable",
	{
		reason: Schema.Literals([
			"Declaration",
			"Resource",
			"ConnectionChanged",
			"Closed",
			"Unsupported",
			"Protocol",
		]),
		message: Schema.String,
	},
) {}
const errors = [
	...ExperienceErrors,
	AppViewUnavailable.pipe(HttpApiSchema.status(409)),
	AppRestricted.pipe(HttpApiSchema.status(403)),
	SessionConflict.pipe(HttpApiSchema.status(409)),
]
export const AppViewsApi = HttpApiGroup.make("appViews").add(
	HttpApiEndpoint.post("open", "/v1/app-operations/:operationId/view", {
		params: { operationId: Schema.String },
		payload: Schema.Struct({
			sessionId: Session.Id,
			itemId: Item.Id,
			version: Schema.optionalKey(Memory.VersionId),
		}),
		success: Opened,
		error: errors,
	}),
	HttpApiEndpoint.get("get", "/v1/app-views/:viewId", {
		params: { viewId: Schema.String },
		success: Binding,
		error: errors,
	}),
	HttpApiEndpoint.delete("close", "/v1/app-views/:viewId", {
		params: { viewId: Schema.String },
		success: Schema.Void,
		error: errors,
	}),
	HttpApiEndpoint.post("read", "/v1/app-views/:viewId/read", {
		params: { viewId: Schema.String },
		payload: Schema.Struct({
			method: Schema.Literals([
				"tools/list",
				"resources/list",
				"resources/templates/list",
			]),
			params: Schema.JsonObject,
		}),
		success: Schema.JsonObject,
		error: errors,
	}),
	HttpApiEndpoint.post("act", "/v1/app-views/:viewId/actions", {
		params: { viewId: Schema.String },
		payload: ActionRequest,
		success: ActionTicket.pipe(HttpApiSchema.status(202)),
		error: errors,
	}),
	HttpApiEndpoint.get("operation", "/v1/app-views/:viewId/actions/:requestId", {
		params: { viewId: Schema.String, requestId: Schema.String },
		success: Observation,
		error: errors,
	}),
	HttpApiEndpoint.put("confirmContext", "/v1/app-views/:viewId/context", {
		params: { viewId: Schema.String },
		payload: Schema.Struct({
			revision: Schema.Natural,
			context: Schema.JsonObject,
		}),
		success: Interaction,
		error: errors,
	}),
	HttpApiEndpoint.get(
		"interaction",
		"/v1/app-operations/:operationId/interaction",
		{
			params: { operationId: Schema.String },
			query: { sessionId: Session.Id },
			success: Interaction,
			error: errors,
		},
	),
	HttpApiEndpoint.post("message", "/v1/app-views/:viewId/messages", {
		params: { viewId: Schema.String },
		payload: Schema.Struct({ content: Schema.JsonObject }),
		success: Schema.Void,
		error: errors,
	}),
)
