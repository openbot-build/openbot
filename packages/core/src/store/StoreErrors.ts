import type { Schema } from "effect"
import { dual } from "effect/Function"
import type * as Chat from "../chat/Chat.ts"
import * as ChatStore from "./ChatStore.ts"

export const error: {
	(details: {
		readonly message: string
		readonly chat?: Chat.Id
	}): (reason: ChatStore.ChatStoreError["reason"]) => ChatStore.ChatStoreError
	(
		reason: ChatStore.ChatStoreError["reason"],
		details: {
			readonly message: string
			readonly chat?: Chat.Id
		},
	): ChatStore.ChatStoreError
} = dual(
	2,
	(
		reason: ChatStore.ChatStoreError["reason"],
		details: {
			readonly message: string
			readonly chat?: Chat.Id
		},
	) => new ChatStore.ChatStoreError({ reason, ...details }),
)
export const invalid = (issue?: Schema.SchemaError) =>
	new ChatStore.ChatStoreError({
		reason: "decode-failed",
		message: "Stored Chat data is invalid",
		...(issue === undefined ? {} : { issue: issue.issue }),
	})
