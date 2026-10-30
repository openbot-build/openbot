import { Chat, Turn } from "@openbot-build/core"
import { Schema } from "effect"
import * as Execution from "./Execution.ts"

export const Id = Schema.NonEmptyString.check(Schema.isMaxLength(256))
export const Status = Schema.Literals(["waiting", "done", "cancelled"])
export type Status = typeof Status.Type
export interface ListInput {
	readonly chatId?: Chat.Id
	readonly status?: Status
	readonly after?: string
	readonly limit?: number
}
/** Done means the note was delivered to the Chat, not that its follow-up work finished. */
export const Reminder = Schema.Struct({
	id: Id,
	chatId: Chat.Id,
	turnId: Turn.Id,
	executionId: Schema.NullOr(Execution.Id),
	note: Schema.String,
	dueAt: Schema.Finite,
	status: Status,
})
export type Reminder = typeof Reminder.Type
export const Page = Schema.Struct({
	items: Schema.Array(Reminder),
	next: Schema.NullOr(Id),
})
export type Page = typeof Page.Type
export class NotFound extends Schema.TaggedError<
	NotFound,
	{ readonly brand: unique symbol }
>()("ReminderNotFound", { id: Id }) {}
export class Conflict extends Schema.TaggedError<
	Conflict,
	{ readonly brand: unique symbol }
>()("ReminderConflict", { id: Id }) {}
