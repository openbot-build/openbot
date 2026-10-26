import { BotAuth } from "./AuthApi.ts"
import { Operation } from "@openbot-build/core"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { Authorize, GroupRequired, own } from "./Authorization.ts"
import { ChatNotFound, ChatStorageUnavailable, chatParams } from "./ChatsApi.ts"

export class OperationNotFound extends Schema.TaggedError<
	OperationNotFound,
	{ readonly brand: unique symbol }
>()("OperationNotFound", { id: Schema.String }) {}
const errors = [
	ChatNotFound.pipe(HttpApiSchema.status(404)),
	OperationNotFound.pipe(HttpApiSchema.status(404)),
	ChatStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const
const operationParams = { ...chatParams, id: Operation.Id }

/** Tool calls of a Chat that took more time than their budget and went on in the background. */
export const OperationsApi = HttpApiGroup.make("operations")
	.add(
		HttpApiEndpoint.get("list", "/v1/chats/:chatId/operations", {
			params: chatParams,
			success: Schema.Array(Operation.Record),
			error: errors,
		}).annotate(
			OpenApi.Description,
			"Lists the background tool calls of a Chat, the oldest first.",
		),
		HttpApiEndpoint.get("get", "/v1/chats/:chatId/operations/:id", {
			params: operationParams,
			success: Operation.Record,
			error: errors,
		}),
		HttpApiEndpoint.post("cancel", "/v1/chats/:chatId/operations/:id/cancel", {
			params: operationParams,
			success: Operation.Record,
			error: errors,
		}).annotate(
			OpenApi.Description,
			"Stops a background tool call. The Chat gets a notice when it stops.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.annotate(GroupRequired, {
		read: [own("read", "Chat", "chatId")],
		write: [own("write", "Chat", "chatId")],
	})
	.middleware(Authorize)
	.middleware(BotAuth)
