import { Schema } from "effect"

export const ConnectionIdBrand = Schema.String.pipe(
	Schema.brand("@openbot-build/domain/ConnectionId"),
)
export const ConnectionId = ConnectionIdBrand.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
)
export type ConnectionId = typeof ConnectionId.Type
