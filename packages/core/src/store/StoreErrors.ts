import type { Schema } from "effect"
import { dual } from "effect/Function"
import * as Memory from "../memory/Memory.ts"
import * as SessionStore from "./SessionStore.ts"

export const error: {
	(details: {
		readonly message: string
		readonly version?: Memory.VersionId
	}): (
		reason: SessionStore.SessionStoreError["reason"],
	) => SessionStore.SessionStoreError
	(
		reason: SessionStore.SessionStoreError["reason"],
		details: { readonly message: string; readonly version?: Memory.VersionId },
	): SessionStore.SessionStoreError
} = dual(
	2,
	(
		reason: SessionStore.SessionStoreError["reason"],
		details: { readonly message: string; readonly version?: Memory.VersionId },
	) => new SessionStore.SessionStoreError({ reason, ...details }),
)
export const invalid = (issue?: Schema.SchemaError) =>
	new SessionStore.SessionStoreError({
		reason: "decode-failed",
		message: "Stored Session data is invalid",
		...(issue === undefined ? {} : { issue: issue.issue }),
	})
