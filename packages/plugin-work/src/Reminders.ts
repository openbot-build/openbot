import { Secrets } from "@openbot-build/server-kernel/Secrets"
import * as Failures from "@openbot-build/server-kernel/Failures"
import { Bots as BotsApi } from "@openbot-build/domain"
import { Clock, Effect, Layer, Option, Schema, String as Str } from "effect"
import { Digest } from "effect/crypto"
import { BotRecords } from "@openbot-build/conversation-contract/bots/BotRecords"
import { hash } from "@openbot-build/conversation-contract/capabilities/Capability"
import {
	ReminderStatus,
	Reminder,
	Reminders,
} from "@openbot-build/conversation-contract/work/Reminders"
export const make: Effect.Effect<
	typeof Reminders.Service,
	never,
	BotRecords | Digest.Digest | Secrets
> = Effect.gen(function* () {
	const records = yield* BotRecords
	const secrets = yield* Secrets
	const hashes = yield* Digest.Digest
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
						)(yield* hash(hashes, [input.chat, input.turn, input.toolCallId]))
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
