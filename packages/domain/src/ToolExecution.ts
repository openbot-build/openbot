import { Chat, Item, Turn } from "@openbot-build/core"
import { Schema } from "effect"
import * as Execution from "./Execution.ts"

/** A tool call has its own resource ID and an execution that owns its work. */
export const Id = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/ToolExecutionId"))
export type Id = typeof Id.Type

export const Position = Schema.Struct({
	chat: Chat.Id,
	turn: Turn.Id,
	item: Item.Id,
	step: Schema.Natural,
})
export type Position = typeof Position.Type

export const Record = Schema.Struct({
	id: Id,
	executionId: Execution.Id,
	parentExecutionId: Execution.Id,
	position: Position,
	callId: Schema.String,
	tool: Schema.String,
	status: Execution.Status,
	/** A detached call sends its result to the Chat after the Turn can move on. */
	detached: Schema.Boolean,
	startedAt: Schema.Finite,
	deadline: Schema.Finite,
	failure: Schema.NullOr(Execution.Failure),
})
export type Record = typeof Record.Type

/** A saved tool result stays distinct from the state of the execution that owns it. */
export const View = Schema.Struct({
	...Record.fields,
	output: Schema.NullOr(Schema.Json),
})
export type View = typeof View.Type
export class NotFound extends Schema.TaggedError<
	NotFound,
	{ readonly brand: unique symbol }
>()("ToolCallNotFound", { id: Id }) {}

/** Old tool records have no saved deadline or model Item. Do not invent either. */
export const Imported = Schema.TaggedStruct("Imported", {
	id: Id,
	executionId: Execution.Id,
	parentExecutionId: Execution.Id,
	chat: Chat.Id,
	turn: Turn.Id,
	callId: Schema.String,
	tool: Schema.String,
	kind: Schema.Literals(["tool", "session"]),
	status: Execution.Status,
	startedAt: Schema.Finite,
	endedAt: Schema.NullOr(Schema.Finite),
	failure: Schema.NullOr(Execution.Failure),
})
export type Imported = typeof Imported.Type
export const Summary = Schema.Union([Record, Imported])
export type Summary = typeof Summary.Type
export const History = Schema.Struct({
	...Imported.fields,
	output: Schema.NullOr(Schema.Json),
})
export type History = typeof History.Type
export const Result = Schema.Union([View, History])
export type Result = typeof Result.Type
