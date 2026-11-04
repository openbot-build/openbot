import { ChatStore } from "@openbot-build/core"
import { Schema } from "effect"

/** Keeps a ChatStoreError. Any other database failure becomes `storage-failed` and keeps its cause. */
export const databaseError = (error: unknown): ChatStore.ChatStoreError =>
	Schema.is(ChatStore.ChatStoreError)(error)
		? error
		: ChatStore.ChatStoreError.make({
				reason: "storage-failed",
				message: "Chat storage is unavailable",
				cause: error,
			})
