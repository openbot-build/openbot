import { Secrets } from "../../secrets/Secrets.ts"
import * as Failures from "../../errors/Failures.ts"
import { Chat, Turn } from "@openbot-build/core"
import { Bots as BotsApi } from "@openbot-build/domain"
import { Execution } from "@openbot-build/domain"
import {
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
>()("@openbot-build/openbot/plugins/work/Reminders") {}

export const make: Effect.Effect<
	typeof Reminders.Service,
	never,
	BotRecords | Crypto.Crypto | Secrets
> = Effect.gen(function* () {
	const records = yield* BotRecords
	const secrets = yield* Secrets
	const crypto = yield* Crypto.Crypto
	const rows = records.collection(
		"reminder",
		Schema.Struct({ id: Schema.String, sealed: Schema.String }),
		ReminderStatus,
	)
	const codec = Schema.fromJsonString(Reminder)
	const binding = (organizationId: string, id: string) =>
		Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))([
			"reminder",
			organizationId,
			id,
		])
	const hide = Failures.replace(
		"The saved reminder could not be read or written.",
		() => BotsApi.BotStorageUnavailable.make({}),
	)
	const decode = (
		organizationId: string,
		row: { readonly id: string; readonly sealed: string },
	) =>
		Effect.gen(function* () {
			const value = yield* secrets.open(
				row.sealed,
				yield* binding(organizationId, row.id),
			)
			const record = yield* Schema.decodeEffect(codec)(value)
			if (record.id !== row.id)
				return yield* BotsApi.BotStorageUnavailable.make({})
			return record
		}).pipe(hide)
	const reminders = {
		find: (organizationId: string, id: string) =>
			rows.find(organizationId, id).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.succeedNone,
						onSome: (row) => decode(organizationId, row).pipe(Effect.asSome),
					}),
				),
			),
		list: (
			organizationId: string,
			filter: { readonly scope: string; readonly status: ReminderStatus },
		) =>
			rows
				.list(organizationId, filter)
				.pipe(
					Effect.flatMap((rows) =>
						Effect.forEach(rows, (row) => decode(organizationId, row)),
					),
				),

		put: (
			keys: {
				readonly organizationId: string
				readonly id: string
				readonly owner: string
				readonly scope: string
				readonly status: ReminderStatus
			},
			value: Reminder,
		) =>
			Effect.gen(function* () {
				const sealed = yield* secrets.seal(
					yield* Schema.encodeEffect(codec)(value),
					yield* binding(keys.organizationId, keys.id),
				)
				yield* rows.put(keys, { id: keys.id, sealed })
			}).pipe(hide),
	}
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
					input.id ??
					input.executionId ??
					"rem_" +
						Str.slice(
							0,
							32,
						)(yield* hash(crypto, [input.chat, input.turn, input.toolCallId]))
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
