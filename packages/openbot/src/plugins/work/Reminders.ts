import { Chat, Turn } from "@openbot-build/core"
import type { BotsApi } from "@openbot-build/api"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
	String as Str,
} from "effect"
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
>()("@openbot-build/openbot/plugins/work/Reminders") {}

export const make: Effect.Effect<
	typeof Reminders.Service,
	never,
	BotRecords | Crypto.Crypto
> = Effect.gen(function* () {
	const records = yield* BotRecords
	const crypto = yield* Crypto.Crypto
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
				const id =
					"rem_" +
					Str.slice(0, 32)(yield* hash(crypto, [input.chat, input.toolCallId]))
				return yield* records.transaction(
					id,
					Effect.gen(function* () {
						const found = yield* reminders.find(organizationId, id)
						if (Option.isSome(found)) return found.value
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
			return Arr.filter(open, (entry) => entry.value.dueAt <= now)
		}),
		change: (organizationId, id, from, to) =>
			records.transaction(
				id,
				Effect.gen(function* () {
					const found = yield* reminders.find(organizationId, id)
					if (Option.isNone(found) || found.value.status !== from)
						return Option.none()
					const changed: Reminder = { ...found.value, status: to }
					yield* reminders.put(keys(organizationId, changed), changed)
					return Option.some(changed)
				}),
			),
		forChat: (organizationId, chat) =>
			reminders.list(organizationId, { scope: chat, status: "waiting" }),
	})
})
export const layer = Layer.effect(Reminders, make)
