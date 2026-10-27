import type { Schema } from "effect"
import type * as Chat from "../chat/Chat.ts"
import * as ChatStore from "./ChatStore.ts"

export const error = (
	reason: ChatStore.ChatStoreError["reason"],
	details: {
		readonly message: string
		readonly chat?: Chat.Id
	},
) => ChatStore.ChatStoreError.make({ reason, ...details })
export const invalid = (schemaError: Schema.SchemaError) =>
	ChatStore.ChatStoreError.make({
		reason: "decode-failed",
		message: "Stored Chat data is invalid",
		issue: schemaError.issue,
	})
