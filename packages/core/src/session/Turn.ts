import { Data, Schema } from "effect"
import { Id } from "./TurnIdentity.ts"
import * as SessionIdentity from "./SessionIdentity.ts"
import * as Item from "../timeline/Item.ts"
import { VersionId } from "../timeline/TimelineIdentity.ts"
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
export const StatusSchema = Schema.TaggedUnion({
	Running: {},
	WaitingApproval: { result: Output },
	Completed: { result: Output },
	Failed: {
		message: Schema.String,
		code: Schema.Literals(["model_error", "internal_error"]),
	},
	Interrupted: {},
})
export type Status = typeof StatusSchema.Type
export const Status = Data.taggedEnum<Status>()
export const Record = Schema.Struct({
	id: Id,
	session: SessionIdentity.Id,
	settings: Settings,
	action: Schema.optionalKey(Action),
	activeAction: Schema.optionalKey(
		Schema.Struct({ item: Item.Id, action: Action }),
	),
	status: StatusSchema,
	steps: Schema.Natural,
	usage: Schema.optionalKey(Schema.Array(Response.Usage)),
	input: Schema.Array(Item.Id),
	items: Schema.Array(Item.Id),
	start: VersionId,
	end: Schema.optionalKey(VersionId),
	startedAt: Schema.Finite,
	completedAt: Schema.optionalKey(Schema.Finite),
})
export type Record = typeof Record.Type
export class Conflict extends Data.TaggedError("TurnConflict")<{
	readonly session: SessionIdentity.Id
	readonly turn: Id
	readonly message: string
}> {}
export const isTerminal = (status: Status) =>
	status._tag !== "Running" && status._tag !== "WaitingApproval"
