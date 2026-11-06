import { Schema } from "effect"

export const Id = Schema.String.pipe(Schema.brand("@openbot-build/core/TurnId"))
export type Id = typeof Id.Type
