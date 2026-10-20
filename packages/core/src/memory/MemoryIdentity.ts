import { Schema } from "effect"

export const VersionId = Schema.String.pipe(
	Schema.brand("@openbot-build/core/MemoryVersionId"),
)
export type VersionId = typeof VersionId.Type
