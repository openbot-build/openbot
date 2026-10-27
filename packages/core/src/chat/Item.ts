import { Schema } from "effect"
import * as ChatIdentity from "./ChatIdentity.ts"
import * as TurnIdentity from "./TurnIdentity.ts"
import { PromptJson } from "../store/PromptCodec.ts"

export const Id = Schema.String.pipe(Schema.brand("@openbot-build/core/ItemId"))
export type Id = typeof Id.Type
/** The place of an Item in the log of its Chat. The first Item has 1. */
export const Seq = Schema.Natural.pipe(
	Schema.brand("@openbot-build/core/ItemSeq"),
)
export type Seq = typeof Seq.Type
/**
 * Marks input that the host sends, not a person. The host chooses `kind`, such as
 * the end of a delegation. `ref` names the thing that the notice is about.
 */
export const Notice = Schema.Struct({
	kind: Schema.NonEmptyString,
	ref: Schema.optionalKey(Schema.String),
})
export type Notice = typeof Notice.Type
export const Origin = Schema.Struct({
	chat: ChatIdentity.Id,
	turn: TurnIdentity.Id,
	step: Schema.Natural,
	notice: Schema.optionalKey(Notice),
})
export type Origin = typeof Origin.Type
/** A new Item. The store gives it its place in the log. */
export const Entry = Schema.Struct({
	id: Id,
	content: PromptJson,
	origin: Schema.optionalKey(Origin),
})
export type Entry = typeof Entry.Type
export const Record = Schema.Struct({
	...Entry.fields,
	seq: Seq,
})
export type Record = typeof Record.Type
