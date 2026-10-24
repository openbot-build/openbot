// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Schema, Stream } from "effect"
import { Prompt } from "effect/ai"
import {
	Chat,
	ChatRuntime,
	ChatState,
	ChatStore,
	ChatStoreRepository,
	Item,
	MemoryPersistence,
	Store,
	Turn,
} from "@openbot-build/core"
import { LanguageModelTest, textParts } from "./LanguageModelTest.ts"

const definition = Store.define({
	stores: {
		counter: {
			scope: "state",
			schema: Schema.Finite,
		},
		goal: {
			scope: "record",
			schema: Schema.String,
		},
	},
	schemaVersion: "chat/1",
})
const setup = Effect.gen(function* () {
	const declared = yield* definition,
		persistence = yield* MemoryPersistence.make
	const store = yield* ChatStoreRepository.make({
		definition: declared,
		persistence,
	})
	return { declared, persistence, store }
})

it.effect(
	"new Chats, settings and record data change the revision one step at a time",
	() =>
		Effect.gen(function* () {
			const { store } = yield* setup
			const a = yield* store.create({}),
				b = yield* store.create({})
			assert.notStrictEqual(a.chat.id, b.chat.id)
			assert.strictEqual(a.chat.revision, 0)
			assert.strictEqual(a.chat.seq, 0)
			assert.deepStrictEqual(a.chat.inbox, [])
			assert.strictEqual(a.chat.turn, undefined)
			assert.strictEqual(a.chat.settings.mode, "build")
			const withGoal = (yield* store.modifyEffect({
				chat: a.chat.id,
				update: () =>
					Effect.succeed([
						undefined,
						Option.some({ chat: { business: { goal: "source goal" } } }),
					] as const),
			})).view
			assert.strictEqual(withGoal.chat.revision, a.chat.revision + 1)
			assert.strictEqual(withGoal.chat.business["goal"], "source goal")
			assert.deepStrictEqual(withGoal.state, a.state)
			const changed = (yield* store.modifyEffect({
				chat: a.chat.id,
				expectedRevision: withGoal.chat.revision,
				update: (current) =>
					Effect.succeed([
						undefined,
						Option.some({
							chat: { settings: { ...current.chat.settings, mode: "plan" } },
						}),
					] as const),
			})).view
			assert.strictEqual(changed.chat.revision, withGoal.chat.revision + 1)
			assert.strictEqual(changed.chat.business["goal"], "source goal")
			const stale = yield* store
				.modifyEffect({
					chat: a.chat.id,
					expectedRevision: withGoal.chat.revision,
					update: () => Effect.succeed([undefined, Option.some({})] as const),
				})
				.pipe(Effect.flip)
			assert.ok(stale._tag === "ChatStoreError")
			assert.strictEqual(stale.reason, "reference-conflict")
			assert.deepStrictEqual(yield* store.read(a.chat.id), changed)
			assert.strictEqual(
				(yield* store.read(b.chat.id)).chat.settings.mode,
				"build",
			)
			const chosen = yield* store.create({
				id: Chat.Id.make("chosen"),
				settings: { mode: "plan" },
				business: { goal: "given goal" },
			})
			assert.strictEqual(chosen.chat.id, "chosen")
			assert.strictEqual(chosen.chat.settings.mode, "plan")
			assert.strictEqual(chosen.chat.business["goal"], "given goal")
			assert.deepStrictEqual(
				(yield* store.list).map((ref) => ref.id),
				[a.chat.id, b.chat.id, chosen.chat.id],
			)
			yield* store.remove(changed.chat)
			assert.strictEqual((yield* store.list).length, 2)
			assert.ok(Option.isNone(yield* store.get(a.chat.id)))
			const missing = yield* store.read(a.chat.id).pipe(Effect.flip)
			assert.strictEqual(missing._tag, "ChatNotFound")
		}),
)

it.effect("record data cannot be kept in the state", () =>
	Effect.gen(function* () {
		const { store } = yield* setup
		const error = yield* store
			.create({
				value: { ...ChatState.initial({}), goal: "in the wrong place" },
			})
			.pipe(Effect.flip)
		assert.strictEqual(error.reason, "encode-failed")
		assert.deepStrictEqual(yield* store.list, [])
	}),
)

it.effect(
	"concurrent updates, skipped writes and failed callbacks keep the committed state",
	() =>
		Effect.gen(function* () {
			const { store } = yield* setup
			const root = yield* store.create({
				value: ChatState.initial({ counter: 0 }),
			})
			const other = yield* store.create({
				value: ChatState.initial({ counter: 0 }),
			})
			yield* Effect.all(
				Array.from({ length: 12 }, () =>
					store.modifyEffect({
						chat: root.chat.id,
						update: (view) =>
							Effect.succeed([
								undefined,
								Option.some({
									value: {
										...view.state,
										counter: (view.state.counter ?? 0) + 1,
									},
								}),
							] as const),
					}),
				),
				{ concurrency: "unbounded" },
			)
			const before = yield* store.read(root.chat.id)
			assert.strictEqual(before.state.counter, 12)
			assert.strictEqual(before.chat.revision, 12)
			assert.strictEqual((yield* store.read(other.chat.id)).state.counter, 0)
			const skipped = yield* store.modifyEffect({
				chat: root.chat.id,
				update: () => Effect.succeed(["kept", Option.none()] as const),
			})
			assert.strictEqual(skipped.result, "kept")
			assert.deepStrictEqual(skipped.view, before)
			assert.deepStrictEqual(skipped.items, [])
			for (const mutation of [{}, { value: before.state }, { append: [] }])
				yield* store.modifyEffect({
					chat: root.chat.id,
					update: () =>
						Effect.succeed([undefined, Option.some(mutation)] as const),
				})
			assert.deepStrictEqual(yield* store.read(root.chat.id), before)
			assert.strictEqual(
				yield* store
					.modifyEffect({
						chat: root.chat.id,
						update: () => Effect.fail("callback-failed" as const),
					})
					.pipe(Effect.flip),
				"callback-failed",
			)
			assert.deepStrictEqual(yield* store.read(root.chat.id), before)
		}),
)

it.effect(
	"the durable save happens before the change is installed and published",
	() =>
		Effect.gen(function* () {
			const { declared, persistence, store: seed } = yield* setup
			const root = yield* seed.create({})
			const entered = yield* Deferred.make<void>(),
				gate = yield* Deferred.make<void>()
			const store = yield* ChatStoreRepository.make({
				definition: declared,
				persistence,
				onCommit: () =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(gate)),
						Effect.andThen(
							Effect.fail(
								new ChatStore.ChatStoreError({
									reason: "storage-failed",
									message: "blocked write",
								}),
							),
						),
					),
			})
			let notified = false
			yield* Effect.forkChild(
				store.changes().pipe(
					Stream.runForEach(() =>
						Effect.sync(() => {
							notified = true
						}),
					),
				),
				{ startImmediately: true },
			)
			const writing = yield* Effect.forkChild(
				store.modifyEffect({
					chat: root.chat.id,
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({ chat: { business: { goal: "unsaved" } } }),
						] as const),
				}),
			)
			yield* Deferred.await(entered)
			assert.deepStrictEqual(yield* store.read(root.chat.id), root)
			assert.strictEqual(notified, false)
			yield* Deferred.succeed(gate, undefined)
			const failure = yield* Fiber.join(writing).pipe(Effect.flip)
			assert.ok(failure._tag === "ChatStoreError")
			assert.strictEqual(failure.reason, "storage-failed")
			assert.deepStrictEqual(yield* store.read(root.chat.id), root)
			assert.strictEqual(notified, false)
		}),
)

it.effect(
	"unknown state and record data survive a new store over the same persistence",
	() =>
		Effect.gen(function* () {
			const { declared, persistence, store } = yield* setup
			const view = yield* store.create({
				value: ChatState.initial({ unknown: { nested: [1, "value"] } }),
				business: { unknown: { saved: true } },
			})
			const fresh = yield* ChatStoreRepository.make({
				definition: declared,
				persistence,
			})
			const restored = yield* fresh.read(view.chat.id)
			assert.deepStrictEqual(restored, view)
			assert.deepStrictEqual(restored.state["unknown"], {
				nested: [1, "value"],
			})
			assert.deepStrictEqual(restored.chat.business["unknown"], { saved: true })
		}),
)

it.effect(
	"Items get places that grow by one, and a query reads one part of the log",
	() =>
		Effect.gen(function* () {
			const { store } = yield* setup
			const view = yield* store.create({})
			const chat = view.chat.id
			const one = Turn.Id.make("one"),
				two = Turn.Id.make("two")
			let published: ReadonlyArray<ReadonlyArray<number>> = []
			yield* Effect.forkChild(
				store.changes({ chat }).pipe(
					Stream.runForEach((change) =>
						Effect.sync(() => {
							if (change._tag === "Committed")
								published = [...published, change.items.map((item) => item.seq)]
						}),
					),
				),
				{ startImmediately: true },
			)
			const entry = (name: string, turn?: Turn.Id): Item.Entry => ({
				id: Item.Id.make(name),
				content: Prompt.make(name),
				...(turn === undefined ? {} : { origin: { chat, turn, step: 0 } }),
			})
			const append = (entries: ReadonlyArray<Item.Entry>) =>
				store.modifyEffect({
					chat,
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({ append: entries }),
						] as const),
				})
			const first = yield* append([entry("a", one), entry("b", one)])
			assert.deepStrictEqual(
				first.items.map((item) => item.seq),
				[1, 2],
			)
			yield* append([entry("c", two), entry("d", two), entry("e", two)])
			const last = yield* append([entry("f")])
			assert.strictEqual(last.view.chat.seq, 6)
			assert.strictEqual(last.view.chat.revision, 3)
			const seqs = (query?: ChatStore.ItemQuery) =>
				store
					.items(chat, query)
					.pipe(Effect.map((items) => items.map((item) => item.seq)))
			assert.deepStrictEqual(yield* seqs(), [1, 2, 3, 4, 5, 6])
			assert.deepStrictEqual(
				(yield* store.items(chat)).map((item) => item.id),
				["a", "b", "c", "d", "e", "f"],
			)
			assert.deepStrictEqual(yield* seqs({ turn: one }), [1, 2])
			assert.deepStrictEqual(
				yield* seqs({ turn: two, order: "desc" }),
				[5, 4, 3],
			)
			assert.deepStrictEqual(yield* seqs({ after: 2, before: 6 }), [3, 4, 5])
			assert.deepStrictEqual(yield* seqs({ limit: 2 }), [1, 2])
			assert.deepStrictEqual(yield* seqs({ order: "desc", limit: 2 }), [6, 5])
			assert.deepStrictEqual(yield* seqs({ turn: Turn.Id.make("other") }), [])
			yield* Effect.yieldNow
			assert.deepStrictEqual(published, [[1, 2], [3, 4, 5], [6]])
		}),
)

it.effect(
	"old Turns are kept apart from the record and can be read in order",
	() =>
		Effect.gen(function* () {
			const { store } = yield* setup
			const runtime = yield* ChatRuntime.make({ store, bot: {} })
			const chat = (yield* store.create({})).chat.id
			const first = Chat.currentTurn(
				(yield* runtime.execute({ chat, input: "first" })).chat,
			)!
			const done = yield* runtime.execute({ chat, input: "second" })
			const second = Chat.currentTurn(done.chat)!
			assert.strictEqual(done.chat.turn?.id, second.id)
			const turns = yield* store.turns(chat)
			assert.deepStrictEqual(turns, [first, second])
			assert.deepStrictEqual(yield* store.turns(chat, { after: first.id }), [
				second,
			])
			assert.deepStrictEqual(yield* store.turns(chat, { limit: 1 }), [first])
			assert.deepStrictEqual(
				yield* store.turn(chat, first.id),
				Option.some(first),
			)
			assert.ok(Option.isNone(yield* store.turn(chat, Turn.Id.make("missing"))))
			const firstItems = yield* store.items(chat, { turn: first.id }),
				secondItems = yield* store.items(chat, { turn: second.id })
			assert.deepStrictEqual(
				firstItems.map((item) => item.id),
				first.items,
			)
			assert.deepStrictEqual(
				secondItems.map((item) => item.id),
				second.items,
			)
			assert.ok(firstItems.every((item) => item.origin?.turn === first.id))
			assert.ok(
				Math.max(...firstItems.map((item) => item.seq)) <
					Math.min(...secondItems.map((item) => item.seq)),
			)
			assert.strictEqual(done.chat.seq, firstItems.length + secondItems.length)
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.fromArray(textParts("done")),
				}),
			),
		),
)
