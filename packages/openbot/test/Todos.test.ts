import { assert, it } from "@effect/vitest"
import {
	ChatStore,
	ChatStoreRepository,
	Item,
	MemoryPersistence,
	Store,
	Turn,
	TurnState,
} from "@openbot-build/core"
import { Array as Arr, Effect, Option, Ref, Schema } from "effect"
import { Prompt } from "effect/ai"
import * as Todos from "../src/plugins/work/Todos.ts"

it.effect("todo reminders survive a new store and commit with their keys", () =>
	Effect.gen(function* () {
		const memory = yield* MemoryPersistence.make
		const reject = yield* Ref.make(false)
		const persistence: ChatStore.Persistence = {
			...memory,
			save: (delta) =>
				Effect.flatMap(Ref.get(reject), (fail) =>
					fail
						? Effect.fail(
								ChatStore.ChatStoreError.make({
									reason: "storage-failed",
									message: "The store is down",
								}),
							)
						: memory.save(delta),
				),
		}
		const definition = yield* Store.define({
			stores: Todos.stores,
			schemaVersion: "chat/1",
		})
		const make = ChatStoreRepository.make({ definition, persistence })
		const store = yield* make
		const initial = yield* store.create({})
		const chat = initial.chat.id
		const turn = Turn.Id.make("todo-turn")
		const entry = {
			id: Item.Id.make("input"),
			kind: "message" as const,
			content: Prompt.make("Read the note"),
		}
		yield* store.modifyEffect({
			chat,
			update: (view) =>
				TurnState.start(view, {
					turn,
					selected: [entry],
					startedAt: 0,
					items: [
						{
							id: entry.id,
							content: entry.content,
							origin: { chat, turn, step: 0 },
						},
					],
				}).pipe(
					Effect.map((mutation) => [undefined, Option.some(mutation)] as const),
				),
		})
		const items = [
			{ id: "one", content: "Read the note", status: "pending" as const },
		]
		yield* Todos.replace({ store, chat, items })
		const remind = (store: ChatStore.Store<Todos.Values>, id: string) =>
			Todos.continueTurn({
				store,
				chat,
				turn,
				item: Item.Id.make(id),
				allowReminder: true,
				message: Todos.describe,
			})
		const before = yield* store.read(chat)
		yield* Ref.set(reject, true)
		const failure = yield* remind(store, "failed").pipe(Effect.flip)
		assert.ok(Schema.is(ChatStore.ChatStoreError)(failure))
		assert.strictEqual(failure.reason, "storage-failed")
		yield* Ref.set(reject, false)
		assert.deepStrictEqual(yield* store.read(chat), before)
		// A cleanup based on an earlier complete list must not remind a new open list.
		yield* Todos.continueTurn({
			store,
			chat,
			turn,
			item: Item.Id.make("cleanup"),
			allowReminder: false,
			message: Todos.describe,
		})
		assert.deepStrictEqual(yield* store.read(chat), before)
		yield* remind(store, "saved")
		const restarted = yield* make
		yield* Effect.forEach(["again", "twice"], (id) => remind(restarted, id), {
			concurrency: "unbounded",
		})
		assert.deepStrictEqual(
			Arr.map((yield* restarted.read(chat)).chat.inbox, (entry) => entry.id),
			["saved"],
		)
		yield* Todos.replace({
			store: restarted,
			chat,
			items: [{ ...items[0]!, status: "in_progress" }],
		})
		yield* remind(restarted, "changed")
		assert.strictEqual((yield* restarted.read(chat)).chat.inbox.length, 2)
		// Returning to a list seen earlier in this Turn must not add another reminder.
		yield* Todos.replace({ store: restarted, chat, items })
		yield* remind(yield* make, "old-list")
		assert.strictEqual((yield* restarted.read(chat)).chat.inbox.length, 2)
		yield* Todos.replace({
			store: restarted,
			chat,
			items: [{ ...items[0]!, status: "done" }],
		})
		yield* remind(restarted, "done")
		assert.deepStrictEqual(Todos.of(yield* restarted.read(chat)), Todos.empty)
		// A late hook of an old Turn cannot change a newer Turn.
		const current = yield* restarted.read(chat)
		yield* restarted.modifyEffect({
			chat,
			update: () =>
				Effect.succeed([
					undefined,
					Option.some({
						chat: {
							turn: { ...current.chat.turn!, id: Turn.Id.make("next-turn") },
						},
					}),
				] as const),
		})
		yield* Todos.replace({ store: restarted, chat, items })
		const next = yield* restarted.read(chat)
		yield* remind(restarted, "late")
		assert.deepStrictEqual(yield* restarted.read(chat), next)
	}),
)
