import { NodeCrypto } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Chat, Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Effect,
	HashMap,
	Layer,
	Option,
	pipe,
	Ref,
	Semaphore,
	String as Str,
} from "effect"
import { BotRecords, type Keys } from "../src/bots/BotRecords.ts"
import * as Reminders from "../src/plugins/work/Reminders.ts"

const organizationId = "org_1"

/** Bot records in memory. One lock for all keys is enough for these tests. */
const memoryRecords = Layer.effect(
	BotRecords,
	Effect.gen(function* () {
		const rows = yield* Ref.make(
			HashMap.empty<string, { readonly keys: Keys; readonly value: unknown }>(),
		)
		const lock = yield* Semaphore.make(1)
		return BotRecords.of({
			collection: (kind) => {
				const key = (organizationId: string, id: string) =>
					kind + ":" + organizationId + ":" + id
				const all = Effect.map(Ref.get(rows), (map) =>
					pipe(
						HashMap.toEntries(map),
						Arr.filter(([id]) => Str.startsWith(kind + ":")(id)),
						Arr.map(([, row]) => row),
					),
				)
				return {
					find: (organizationId, id) =>
						Effect.map(Ref.get(rows), (map) =>
							Option.map(
								HashMap.get(map, key(organizationId, id)),
								(row) => row.value as never,
							),
						),
					list: (organizationId, filter = {}) =>
						Effect.map(all, (list) =>
							pipe(
								list,
								Arr.filter(
									(row) =>
										row.keys.organizationId === organizationId &&
										(filter.scope === undefined ||
											row.keys.scope === filter.scope) &&
										(filter.status === undefined ||
											row.keys.status === filter.status),
								),
								Arr.map((row) => row.value as never),
							),
						),
					withStatus: (status) =>
						Effect.map(all, (list) =>
							pipe(
								list,
								Arr.filter((row) => row.keys.status === status),
								Arr.map((row) => ({
									organizationId: row.keys.organizationId,
									value: row.value as never,
								})),
							),
						),
					put: (keys, value) =>
						Ref.update(rows, (map) =>
							HashMap.set(map, key(keys.organizationId, keys.id), {
								keys,
								value,
							}),
						),
					remove: (organizationId, id) =>
						Ref.update(rows, HashMap.remove(key(organizationId, id))),
				}
			},
			transaction: (_key, operation) => lock.withPermits(1)(operation),
		})
	}),
)

const layer = Layer.effect(Reminders.Reminders, Reminders.make).pipe(
	Layer.provide(Layer.mergeAll(memoryRecords, NodeCrypto.layer)),
)

const start = Effect.gen(function* () {
	const reminders = yield* Reminders.Reminders
	return yield* reminders.start(organizationId, {
		userId: "user_1",
		author: "user_1",
		chat: Chat.Id.make("chat_1"),
		turn: Turn.Id.make("turn_1"),
		toolCallId: "call_1",
		note: "Look at the tests.",
		dueAt: 0,
	})
})

const statusOf = (id: string) =>
	Effect.gen(function* () {
		const reminders = yield* Reminders.Reminders
		const found = yield* reminders.find(organizationId, id)
		return Option.map(found, (reminder) => reminder.status)
	})

describe("Reminders", () => {
	it.effect(
		"only one step sends a reminder, and a cancel after the send changes nothing",
		() =>
			Effect.gen(function* () {
				const reminders = yield* Reminders.Reminders
				const reminder = yield* start
				const first = yield* reminders.change(
					organizationId,
					reminder.id,
					"waiting",
					"done",
				)
				assert.deepStrictEqual(
					Option.map(first, (claimed) => claimed.status),
					Option.some("done"),
				)
				// A sleeper and the check each minute can both find the reminder.
				assert.isTrue(
					Option.isNone(
						yield* reminders.change(
							organizationId,
							reminder.id,
							"waiting",
							"done",
						),
					),
				)
				assert.isTrue(
					Option.isNone(
						yield* reminders.change(
							organizationId,
							reminder.id,
							"waiting",
							"cancelled",
						),
					),
				)
				assert.deepStrictEqual(
					yield* statusOf(reminder.id),
					Option.some("done"),
				)
			}).pipe(Effect.provide(layer)),
	)

	it.effect(
		"a reminder whose note could not go out waits again, and a cancelled reminder is never sent",
		() =>
			Effect.gen(function* () {
				const reminders = yield* Reminders.Reminders
				const reminder = yield* start
				yield* reminders.change(organizationId, reminder.id, "waiting", "done")
				const again = yield* reminders.change(
					organizationId,
					reminder.id,
					"done",
					"waiting",
				)
				assert.isTrue(Option.isSome(again))
				assert.deepStrictEqual(
					Arr.map(yield* reminders.due, (entry) => entry.value.id),
					[reminder.id],
				)
				yield* reminders.change(
					organizationId,
					reminder.id,
					"waiting",
					"cancelled",
				)
				assert.isTrue(
					Option.isNone(
						yield* reminders.change(
							organizationId,
							reminder.id,
							"waiting",
							"done",
						),
					),
				)
				assert.deepStrictEqual(
					yield* statusOf(reminder.id),
					Option.some("cancelled"),
				)
			}).pipe(Effect.provide(layer)),
	)
})
