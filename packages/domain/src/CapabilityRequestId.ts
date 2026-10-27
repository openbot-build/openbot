import { Schema } from "effect"

export const CapabilityRequestIdBrand = Schema.String.pipe(
	Schema.brand("@openbot-build/domain/CapabilityRequestId"),
)
export const CapabilityRequestId = CapabilityRequestIdBrand.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
)
export type CapabilityRequestId = typeof CapabilityRequestId.Type
