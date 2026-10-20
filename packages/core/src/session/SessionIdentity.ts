import { Schema } from "effect"

export const Id = Schema.String.pipe(
	Schema.brand("@openbot-build/core/SessionId"),
)
export type Id = typeof Id.Type
export const Revision = Schema.Natural.pipe(
	Schema.brand("@openbot-build/core/SessionRevision"),
)
export type Revision = typeof Revision.Type
