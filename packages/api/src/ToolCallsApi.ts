import { ToolExecution } from "@openbot-build/domain"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
} from "effect/http-api"
import { BotAuth } from "./AuthApi.ts"
import { Authorize, GroupRequired, own } from "./Authorization.ts"
import {
	ChatConflict,
	ChatNotFound,
	ChatStorageUnavailable,
	chatParams,
} from "./ChatsApi.ts"
import { errors as executionErrors } from "./ExecutionsApi.ts"

const errors = [
	...executionErrors,
	ToolExecution.NotFound.pipe(HttpApiSchema.status(404)),
	ChatConflict.pipe(HttpApiSchema.status(409)),
	ChatNotFound.pipe(HttpApiSchema.status(404)),
	ChatStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const
/** Tools with their own execution. Observe and cancel them through the execution API. */
export const ToolCallsApi = HttpApiGroup.make("toolCalls")
	.add(
		HttpApiEndpoint.get("list", "/v1/chats/:chatId/tool-calls", {
			params: chatParams,
			success: Schema.Array(ToolExecution.Summary),
			error: errors,
		}),
		HttpApiEndpoint.get("get", "/v1/chats/:chatId/tool-calls/:id", {
			params: { ...chatParams, id: ToolExecution.Id },
			success: ToolExecution.Result,
			error: errors,
		}),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.annotate(GroupRequired, { read: [own("read", "Chat", "chatId")], write: [] })
	.middleware(Authorize)
	.middleware(BotAuth)
