import { Chat, ChatStore } from "@openbot-build/core"
import { Effect, Schema } from "effect"

/** Keeps a ChatStoreError. Any other database failure becomes `storage-failed` and keeps its cause. */
export const databaseError = (error: unknown): ChatStore.ChatStoreError =>
	Schema.is(ChatStore.ChatStoreError)(error)
		? error
		: ChatStore.ChatStoreError.make({
				reason: "storage-failed",
				message: "Chat storage is unavailable",
				cause: error,
			})
/** Decodes stored Chat data. A failure names the Chat when the caller knows it. */
export const decode =
	<S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
	(value: unknown, chat?: Chat.Id) =>
		Schema.decodeUnknownEffect(schema)(value).pipe(
			Effect.mapError((error) =>
				ChatStore.ChatStoreError.make({
					reason: "decode-failed",
					message: "Stored Chat data is invalid",
					issue: error.issue,
					...(chat === undefined ? {} : { chat }),
				}),
			),
		)
