import { Schema } from "effect"

export const TokenId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/TokenId"))
export type TokenId = typeof TokenId.Type
