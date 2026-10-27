import { Schema } from "effect"
export const BotId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/BotId"))
export type BotId = typeof BotId.Type
