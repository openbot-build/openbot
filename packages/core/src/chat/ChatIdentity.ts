import { Schema } from "effect"

export const Id = Schema.String.pipe(Schema.brand("@openbot-build/core/ChatId"))
export type Id = typeof Id.Type
export const Revision = Schema.Natural.pipe(
	Schema.brand("@openbot-build/core/ChatRevision"),
)
export type Revision = typeof Revision.Type
