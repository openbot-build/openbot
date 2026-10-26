import { Schema } from "effect"

export const TriggerId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/TriggerId"))
export type TriggerId = typeof TriggerId.Type
