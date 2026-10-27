import { Schema } from "effect"
export const DelegationId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/DelegationId"))
export type DelegationId = typeof DelegationId.Type
