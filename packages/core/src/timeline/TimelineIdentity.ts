import { Schema } from "effect"

export const VersionId = Schema.String.pipe(
	Schema.brand("@openbot-build/core/TimelineVersionId"),
)
export type VersionId = typeof VersionId.Type
