import { Schema } from "effect"
import * as SessionIdentity from "../session/SessionIdentity.ts"
import * as TurnIdentity from "../session/TurnIdentity.ts"
import { PromptJson } from "../store/PromptCodec.ts"

export const Id = Schema.String.pipe(Schema.brand("@openbot-build/core/ItemId"))
export type Id = typeof Id.Type
export const Origin = Schema.Struct({
	session: SessionIdentity.Id,
	turn: TurnIdentity.Id,
	step: Schema.Natural,
})
export type Origin = typeof Origin.Type
export const Record = Schema.Struct({
	id: Id,
	content: PromptJson,
	origin: Schema.optionalKey(Origin),
})
export type Record = typeof Record.Type
