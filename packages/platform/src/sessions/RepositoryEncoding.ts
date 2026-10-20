import { SessionStore } from "@openbot-build/core"
import { SessionResponse } from "@openbot-build/platform-api"
import { Effect, Schema } from "effect"

export const storageError = () =>
	new SessionStore.SessionStoreError({
		reason: "storage-failed",
		message: "Session storage is unavailable",
	})
export const conflict = () =>
	new SessionStore.SessionStoreError({
		reason: "reference-conflict",
		message: "The full expected reference is stale",
	})
export const databaseError = (error: unknown) =>
	error instanceof SessionStore.SessionStoreError ? error : storageError()
export const decode =
	<S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
	(value: unknown) =>
		Schema.decodeUnknownEffect(schema)(value).pipe(
			Effect.mapError(
				() =>
					new SessionStore.SessionStoreError({
						reason: "decode-failed",
						message: "Stored Session data is invalid",
					}),
			),
		)
export const responseSummary = (response: SessionResponse | null) =>
	response === null
		? null
		: {
				id: response.id,
				created_at: response.created_at,
				status: response.status,
				version: response.version,
			}
