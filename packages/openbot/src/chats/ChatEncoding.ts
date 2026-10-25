import { ChatStore } from "@openbot-build/core"
import { ChatResponse } from "@openbot-build/api"
import { Effect, Schema } from "effect"

export const databaseError = (error: unknown) =>
	error instanceof ChatStore.ChatStoreError
		? error
		: new ChatStore.ChatStoreError({
				reason: "storage-failed",
				message: "Chat storage is unavailable",
			})
export const decode =
	<S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
	(value: unknown) =>
		Schema.decodeUnknownEffect(schema)(value).pipe(
			Effect.mapError(
				() =>
					new ChatStore.ChatStoreError({
						reason: "decode-failed",
						message: "Stored Chat data is invalid",
					}),
			),
		)
export const responseSummary = (response: ChatResponse) => ({
	id: response.id,
	created_at: response.created_at,
	status: response.status,
})
