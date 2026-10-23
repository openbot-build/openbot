import { Chat, Turn } from "@openbot-build/core"
import type { BotsApi } from "@openbot-build/api"
import { Clock, Context, Effect, Layer, type Option, Schema } from "effect"
import { BotRecords } from "../../bots/BotRecords.ts"
import { hash } from "../../capabilities/Capability.ts"

export const ReminderStatus = Schema.Literals(["waiting", "done", "cancelled"])
export type ReminderStatus = typeof ReminderStatus.Type

/**
 * One `openbot_remind` call. At `dueAt`, `note` goes to the Chat as a message.
 * `author` is the person that the message is for.
 */
export const Reminder = Schema.Struct({
	id: Schema.String,
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
				"userId" | "author" | "chat" | "turn" | "toolCallId" | "note" | "dueAt"
			>,
		) => Effect.Effect<Reminder, BotsApi.BotStorageUnavailable>
		readonly find: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Option.Option<Reminder>, BotsApi.BotStorageUnavailable>
		/** The open reminders in every organization. */
		readonly open: Effect.Effect<
			ReadonlyArray<{
				readonly organizationId: string
				readonly value: Reminder
			}>,
			BotsApi.BotStorageUnavailable
		>
		/** The reminders whose time came, in every organization. */
		readonly due: Effect.Effect<
			ReadonlyArray<{
				readonly organizationId: string
				readonly value: Reminder
			}>,
			BotsApi.BotStorageUnavailable
		>
		readonly close: (
			organizationId: string,
			reminder: Reminder,
			status: Exclude<ReminderStatus, "waiting">,
		) => Effect.Effect<void, BotsApi.BotStorageUnavailable>
		/** The open reminders of a Chat. */
		readonly forChat: (
			organizationId: string,
			chat: Chat.Id,
		) => Effect.Effect<ReadonlyArray<Reminder>, BotsApi.BotStorageUnavailable>
	}
>()("@openbot-build/openbot/plugins/work/Reminders") {}

export const make: Effect.Effect<typeof Reminders.Service, never, BotRecords> =
	Effect.gen(function* () {
		const records = yield* BotRecords
		const reminders = records.collection("reminder", Reminder, ReminderStatus)
		const keys = (organizationId: string, reminder: Reminder) => ({
			organizationId,
			id: reminder.id,
			owner: reminder.userId,
			scope: reminder.chat,
			status: reminder.status,
		})
		return Reminders.of({
			start: (organizationId, input) =>
				Effect.gen(function* () {
					const id = "rem_" + hash([input.chat, input.toolCallId]).slice(0, 32)
					return yield* records.transaction(
						id,
						Effect.gen(function* () {
							const found = yield* reminders.find(organizationId, id)
							if (found._tag === "Some") return found.value
							const reminder: Reminder = {
								...input,
								id,
								createdAt: yield* Clock.currentTimeMillis,
								status: "waiting",
							}
							yield* reminders.put(keys(organizationId, reminder), reminder)
							return reminder
						}),
					)
				}),
			find: reminders.find,
			open: reminders.withStatus("waiting"),
			due: Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const open = yield* reminders.withStatus("waiting")
				return open.filter((entry) => entry.value.dueAt <= now)
			}),
			close: (organizationId, reminder, status) =>
				reminders.put(keys(organizationId, { ...reminder, status }), {
					...reminder,
					status,
				}),
			forChat: (organizationId, chat) =>
				reminders.list(organizationId, { scope: chat, status: "waiting" }),
		})
	})
export const layer = Layer.effect(Reminders, make)
