import { Chat, Turn } from "@openbot-build/core"
import { Bots as BotsApi } from "@openbot-build/domain"
import { Execution } from "@openbot-build/domain"
import { Context, Effect, Option, Schema } from "effect"

export const ReminderStatus = Schema.Literals(["waiting", "done", "cancelled"])

export type ReminderStatus = typeof ReminderStatus.Type

/**
 * One `openbot_remind` call. At `dueAt`, `note` goes to the Chat as a message.
 * `author` is the person that the message is for.
 */
export const Reminder = Schema.Struct({
	id: Schema.String,
	executionId: Schema.optionalKey(Execution.Id),
	userId: Schema.String,
	author: Turn.Author,
	chat: Chat.Id,
	turn: Turn.Id,
	toolCallId: Schema.String,
	note: Schema.String,
	createdAt: Schema.Finite,
	dueAt: Schema.Finite,
	status: ReminderStatus,
})

export type Reminder = typeof Reminder.Type

/** The reminders of the tool `openbot_remind`. They are saved, so they last over a restart. */
export class Reminders extends Context.Service<
	Reminders,
	{
		/** Saves a reminder for a tool call. A second call for the same tool call keeps the first. */
		readonly start: (
			organizationId: string,
			input: Pick<
				Reminder,
				| "userId"
				| "author"
				| "chat"
				| "turn"
				| "toolCallId"
				| "note"
				| "dueAt"
				| "executionId"
			> & { readonly id?: string },
		) => Effect.Effect<Reminder, BotsApi.BotStorageUnavailable>
		readonly find: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Option.Option<Reminder>, BotsApi.BotStorageUnavailable>
		/**
		 * Changes the status of a reminder when it has the status `from`, and gives the
		 * changed reminder. It gives None when the status is not `from`. The step holds
		 * the lock of the reminder, so two steps never both send it, and a sent
		 * reminder and a cancelled one never write over each other.
		 */
		readonly change: (
			organizationId: string,
			id: string,
			from: ReminderStatus,
			to: ReminderStatus,
		) => Effect.Effect<Option.Option<Reminder>, BotsApi.BotStorageUnavailable>
		/** The open reminders of a Chat. */
		readonly forChat: (
			organizationId: string,
			chat: Chat.Id,
		) => Effect.Effect<ReadonlyArray<Reminder>, BotsApi.BotStorageUnavailable>
	}
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
>()("@openbot-build/openbot/conversation-contract/work/Reminders") {}
