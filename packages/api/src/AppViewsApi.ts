import { Chat, Item } from "@openbot-build/core"
import { Ui } from "@openbot-build/protocol"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { AppViews, Execution } from "@openbot-build/domain"
import { AppOperationId } from "./AppExecution.ts"
import { ExperienceErrors } from "./ExperienceErrors.ts"
import { AppRestricted } from "./ConnectionsApi.ts"
import { errors as executionErrors } from "./ExecutionsApi.ts"
import {
	ChatNotFound,
	ChatStorageUnavailable,
	ChatModelInvalid,
	ChatConflict,
} from "./ChatsApi.ts"

export const {
	AppViewId,
	Binding,
	ActionRequest,
	ActionTicket,
	Interaction,
	AppViewUnavailable,
	ViewReadAction,
	ActionKind,
	ActionSource,
} = AppViews
export type AppViewId = AppViews.AppViewId
export type Binding = AppViews.Binding
export type ActionRequest = AppViews.ActionRequest
export type ActionTicket = AppViews.ActionTicket
export type Interaction = AppViews.Interaction
export type AppViewUnavailable = AppViews.AppViewUnavailable
export type ViewReadAction = AppViews.ViewReadAction
export type ActionKind = AppViews.ActionKind
export type ActionSource = AppViews.ActionSource

export const Opened = Schema.Struct({
	...Binding.fields,
	resource: Ui.Resource,
	tools: Schema.Array(Schema.JsonObject),
	arguments: Schema.JsonObject,
	result: Schema.optionalKey(Schema.JsonObject),
})
export type Opened = typeof Opened.Type
const errors = [
	...ExperienceErrors,
	...executionErrors,
	ChatNotFound.pipe(HttpApiSchema.status(404)),
	ChatStorageUnavailable.pipe(HttpApiSchema.status(503)),
	ChatModelInvalid.pipe(HttpApiSchema.status(400)),
	AppViewUnavailable.pipe(HttpApiSchema.status(409)),
	AppRestricted.pipe(HttpApiSchema.status(403)),
	ChatConflict.pipe(HttpApiSchema.status(409)),
]
export const AppViewsApi = HttpApiGroup.make("appViews").add(
	HttpApiEndpoint.post("open", "/v1/app-operations/:operationId/view", {
		params: { operationId: AppOperationId },
		payload: Schema.Struct({
			chatId: Chat.Id,
			itemId: Item.Id,
		}),
		success: Opened,
		error: errors,
	}),
	HttpApiEndpoint.get("get", "/v1/app-views/:viewId", {
		params: { viewId: AppViewId },
		success: Binding,
		error: errors,
	}),
	HttpApiEndpoint.delete("close", "/v1/app-views/:viewId", {
		params: { viewId: AppViewId },
		success: Schema.Void,
		error: errors,
	}),
	HttpApiEndpoint.post("read", "/v1/app-views/:viewId/read", {
		params: { viewId: AppViewId },
		payload: Schema.Struct({
			method: ViewReadAction,
			params: Schema.JsonObject,
		}),
		success: Schema.JsonObject,
		error: errors,
	}),
	HttpApiEndpoint.post("act", "/v1/app-views/:viewId/actions", {
		params: { viewId: AppViewId },
		payload: ActionRequest,
		success: ActionTicket.pipe(HttpApiSchema.status(202)),
		error: errors,
	}),
	HttpApiEndpoint.put("confirmContext", "/v1/app-views/:viewId/context", {
		params: { viewId: AppViewId },
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
			params: { operationId: AppOperationId },
			query: { chatId: Chat.Id },
			success: Interaction,
			error: errors,
		},
	),
	HttpApiEndpoint.post("message", "/v1/app-views/:viewId/messages", {
		params: { viewId: AppViewId },
		payload: Schema.Struct({
			commandKey: Execution.CommandKey,
			content: Schema.JsonObject,
		}),
		success: ActionTicket.pipe(HttpApiSchema.status(202)),
		error: errors,
	}),
)
