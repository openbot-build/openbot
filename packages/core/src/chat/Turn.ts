import { Data, Record as Rec, Schema } from "effect"
import { Id } from "./TurnIdentity.ts"
import * as ChatIdentity from "./ChatIdentity.ts"
import * as Item from "./Item.ts"
import * as Config from "../models/Config.ts"
import { Response } from "effect/ai"
export { Id } from "./TurnIdentity.ts"

export const Settings = Schema.Struct({
	mode: Config.Mode,
	model: Schema.optionalKey(Config.Selection),
})
export type Settings = typeof Settings.Type
/** An action the host selects explicitly. Its protocol-specific origin data is opaque. */
export const Action = Schema.Struct({
	name: Schema.NonEmptyString,
	arguments: Schema.JsonObject,
	source: Schema.optionalKey(Schema.JsonObject),
})
export type Action = typeof Action.Type
export const Output = Schema.Struct({
	text: Schema.String,
	finishReason: Response.FinishReason,
})
export type Output = typeof Output.Type
/** Why a Turn failed. */
export const FailureCode = Schema.Literals(["model_error", "internal_error"])
export type FailureCode = typeof FailureCode.Type
/**
 * A Turn never waits. It runs, and then it ends. Work that takes outside time,
 * such as a decision, comes back later as new input.
 */
export const StatusSchema = Schema.TaggedUnion({
	Running: {},
	Completed: { result: Output },
	Failed: {
		message: Schema.String,
		code: FailureCode,
	},
	Interrupted: {},
})
export type Status = typeof StatusSchema.Type
/** The tags of `StatusSchema`, such as `Running` and `Failed`. */
export const StatusTag = Schema.Literals(Rec.keys(StatusSchema.cases))
export type StatusTag = typeof StatusTag.Type
export const Status = Data.taggedEnum<Status>()
/**
 * Who a Turn works for. The host chooses the value, such as a user ID, when many people
 * talk in one Chat. The runtime only keeps it and compares it.
 */
export const Author = Schema.String.check(Schema.isMinLength(1))
export type Author = typeof Author.Type
export const Record = Schema.Struct({
	id: Id,
	chat: ChatIdentity.Id,
	settings: Settings,
	action: Schema.optionalKey(Action),
	author: Schema.optionalKey(Author),
	activeAction: Schema.optionalKey(
		Schema.Struct({ item: Item.Id, action: Action }),
	),
	status: StatusSchema,
	steps: Schema.Natural,
	usage: Schema.optionalKey(Schema.Array(Response.Usage)),
	input: Schema.Array(Item.Id),
	items: Schema.Array(Item.Id),
	startedAt: Schema.Finite,
	completedAt: Schema.optionalKey(Schema.Finite),
})
export type Record = typeof Record.Type
export class Conflict extends Schema.TaggedError<
	Conflict,
	{ readonly brand: unique symbol }
>()("TurnConflict", {
	chat: ChatIdentity.Id,
	turn: Id,
	message: Schema.String,
}) {}
export const isTerminal = (status: Status) => status._tag !== "Running"
