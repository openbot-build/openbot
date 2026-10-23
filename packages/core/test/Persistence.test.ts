// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import {
	Array as EffectArray,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	Order,
	Schema,
	Stream,
} from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import {
	Chat,
	ChatRuntime,
	ChatState,
	ChatStore,
	ChatStoreRepository,
	ContextWindow,
	Item,
	MemoryPersistence,
	Model,
	Provider,
	Store,
	Turn,
} from "@openbot-build/core"

const define = Store.define({ stores: {}, schemaVersion: "chat/1" })
const settingsChange = (store: ChatStore.Store, chat: Chat.Id) =>
	store.modifyEffect({
		chat,
		update: (current) =>
			Effect.succeed([
				undefined,
				Option.some({
					chat: { settings: { ...current.chat.settings, mode: "plan" } },
				}),
			] as const),
	})

test("a failed save changes nothing, and a new store over the same persistence reads the same Chat", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* define
				let fail = true
				let saved = 0
				const persist = Effect.suspend(() =>
					fail
						? Effect.fail(
								new ChatStore.ChatStoreError({
									reason: "storage-failed",
									message: "fixture",
								}),
							)
						: Effect.sync(() => {
								saved++
							}),
				)
				const persistence = yield* MemoryPersistence.make
				const store = yield* ChatStoreRepository.make({
					definition,
					persistence,
					onCommit: ({ delta }) =>
						persist.pipe(Effect.andThen(persistence.save(delta))),
					onRemove: (ref) =>
						persist.pipe(Effect.andThen(persistence.remove(ref.id))),
				})
				assert.ok(Exit.isFailure(yield* Effect.exit(store.create({}))))
				assert.equal((yield* store.list).length, 0)
				fail = false
				const view = yield* store.create({})
				assert.equal(saved, 1)
				fail = true
				const chat = view.chat.id
				for (const operation of [
					settingsChange(store, chat),
					store.modifyEffect({
						chat,
						update: () =>
							Effect.succeed([
								undefined,
								Option.some({
									append: [
										{ id: Item.Id.make("lost"), content: Prompt.make("lost") },
									],
								}),
							] as const),
					}),
					store.modifyEffect({
						chat,
						update: (current) =>
							Effect.succeed([
								undefined,
								Option.some({
									value: {
										...current.state,
										conversation: {
											...current.state.conversation,
											closed: false,
										},
									},
								}),
							] as const),
					}),
					store.remove(view.chat),
				])
					assert.ok(
						Exit.isFailure(
							yield* Effect.exit<
								unknown,
								Chat.ChatNotFound | ChatStore.ChatStoreError,
								never
							>(operation),
						),
					)
				assert.deepEqual(yield* store.read(chat), view)
				assert.deepEqual(yield* store.items(chat), [])
				assert.equal((yield* store.list).length, 1)
				const fresh = yield* ChatStoreRepository.make({
					definition,
					persistence,
				})
				assert.deepEqual(yield* fresh.read(chat), view)
				assert.equal(saved, 1)
			}),
		),
	)
})

test("a change saves only the record, its new Items and a changed state, and a read loads only the record", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* define
				const base = yield* MemoryPersistence.make
				let gets = 0,
					logReads = 0,
					saves: ReadonlyArray<ChatStore.Delta> = []
				let reject = false
				const storage: ChatStore.Persistence = {
					...base,
					get: (chat) =>
						Effect.gen(function* () {
							gets++
							if (reject)
								return yield* new ChatStore.ChatStoreError({
									reason: "storage-failed",
									message: "Fixture unavailable",
								})
							return yield* base.get(chat)
						}),
					items: (chat, query) =>
						Effect.suspend(() => {
							logReads++
							return base.items(chat, query)
						}),
					turns: (chat, query) =>
						Effect.suspend(() => {
							logReads++
							return base.turns(chat, query)
						}),
					save: (delta) =>
						Effect.suspend(() => {
							saves = EffectArray.append(saves, delta)
							return base.save(delta)
						}),
				}
				const store = yield* ChatStoreRepository.make({
					definition,
					persistence: storage,
				})
				assert.equal(gets, 0)
				const initial = yield* store.create({})
				for (let index = 0; index < 70; index++) yield* store.create({})
				assert.equal((yield* store.list).length, 71)
				assert.equal(gets, 0)
				assert.equal(logReads, 0)
				yield* store.read(initial.chat.id)
				assert.equal(gets, 1)
				assert.equal(logReads, 0)
				const chat = initial.chat.id
				saves = []
				const settings = yield* settingsChange(store, chat)
				assert.equal(saves.length, 1)
				assert.equal(saves[0]!.expected, initial.chat.revision)
				assert.equal(saves[0]!.revision, settings.view.chat.revision)
				assert.equal(saves[0]!.items.length, 0)
				assert.equal(Object.hasOwn(saves[0]!, "state"), false)
				assert.equal(Object.hasOwn(saves[0]!, "turn"), false)
				saves = []
				yield* store.modifyEffect({
					chat,
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({
								append: [
									{ id: Item.Id.make("first"), content: Prompt.make("first") },
								],
							}),
						] as const),
				})
				assert.deepEqual(
					saves[0]!.items.map((item) => [item.seq, item.id, item.turn]),
					[[1, "first", null]],
				)
				assert.equal(Object.hasOwn(saves[0]!, "state"), false)
				saves = []
				const turn: Turn.Record = {
					id: Turn.Id.make("turn"),
					chat,
					settings: settings.view.chat.settings,
					status: { _tag: "Running" },
					steps: 0,
					input: [],
					items: [],
					startedAt: 0,
				}
				for (const mutation of [
					{ chat: { turn } },
					{ chat: { turn, inbox: [] } },
				])
					yield* store.modifyEffect({
						chat,
						update: () =>
							Effect.succeed([undefined, Option.some(mutation)] as const),
					})
				assert.equal(saves[0]!.turn?.id, "turn")
				assert.equal(Object.hasOwn(saves[1]!, "turn"), false)
				saves = []
				const changed = yield* store.modifyEffect({
					chat,
					update: (current) =>
						Effect.succeed([
							undefined,
							Option.some({
								value: {
									...current.state,
									conversation: {
										...current.state.conversation,
										closed: false,
									},
								},
							}),
						] as const),
				})
				assert.equal(Object.hasOwn(saves[0]!, "state"), true)
				const fresh = yield* ChatStoreRepository.make({
					definition,
					persistence: storage,
				})
				reject = true
				assert.ok(Exit.isFailure(yield* Effect.exit(fresh.read(chat))))
				reject = false
				assert.deepEqual(yield* fresh.read(chat), changed.view)
				assert.deepEqual(yield* fresh.turn(chat, turn.id), Option.some(turn))
			}),
		),
	)
})

test("an interruption before the durable save publishes no Chat", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* define
				const storage = yield* MemoryPersistence.make
				const entered = yield* Deferred.make<void>(),
					release = yield* Deferred.make<void>()
				const store = yield* ChatStoreRepository.make({
					definition,
					persistence: storage,
					onCommit: ({ delta }) =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.andThen(storage.save(delta)),
						),
				})
				const fiber = yield* Effect.forkChild(store.create({}))
				yield* Deferred.await(entered)
				yield* Fiber.interrupt(fiber)
				assert.deepEqual(yield* store.list, [])
			}),
		),
	)
})

test("many other Chats do not stop an active Turn, and scoped interruption still works", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* define
				const store = yield* ChatStoreRepository.make({
					definition,
					persistence: yield* MemoryPersistence.make,
				})
				const runtime = yield* ChatRuntime.make({ store, bot: {} })
				const entered = yield* Deferred.make<void>()
				const model = yield* LanguageModel.make({
					generateText: () => Effect.succeed([]),
					streamText: () =>
						Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
							Stream.flatMap(() => Stream.never),
						),
				})
				const first = yield* store.create({})
				const fiber = yield* Effect.forkChild(
					runtime
						.stream({ chat: first.chat.id, input: "work" })
						.pipe(
							Stream.runDrain,
							Effect.provideService(LanguageModel.LanguageModel, model),
						),
				)
				yield* Deferred.await(entered)
				for (let index = 0; index < 70; index++) {
					const other = yield* store.create({})
					yield* store.read(other.chat.id)
				}
				assert.equal(yield* runtime.isActive(first.chat.id), true)
				assert.equal(
					Chat.status((yield* store.read(first.chat.id)).chat)._tag,
					"Running",
				)
				yield* Fiber.interrupt(fiber)
				assert.equal(
					Chat.status((yield* store.read(first.chat.id)).chat)._tag,
					"Interrupted",
				)
				assert.equal(yield* runtime.isActive(first.chat.id), false)
			}),
		),
	)
})

test("media bytes, a native window, unknown data and Item IDs survive a new store over the same persistence", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* define
				const persistence = yield* MemoryPersistence.make
				const store = yield* ChatStoreRepository.make({
					definition,
					persistence,
				})
				const media = Prompt.make([
					{
						role: "user",
						content: [
							Prompt.filePart({
								mediaType: "image/png",
								data: Uint8Array.from([1, 2, 255]),
							}),
							Prompt.filePart({
								mediaType: "image/png",
								data: new URL("https://example.com/image"),
							}),
							Prompt.filePart({ mediaType: "image/png", data: "AQI=" }),
						],
					},
				])
				const value = ChatState.initial({ future: { tokens: 4, secret: "x" } })
				const created = yield* store.create({
					value: {
						...value,
						conversation: {
							...value.conversation,
							context: {
								_tag: "Native",
								provider: Provider.Id.make("provider"),
								model: Model.Id.make("model"),
								items: [{ type: "reasoning", encrypted_content: "opaque" }],
								prompt: media,
							},
						},
					},
					business: { unknown: { archived: [1, null] } },
				})
				const chat = created.chat.id
				const appended = yield* store.modifyEffect({
					chat,
					update: (current) =>
						Effect.succeed([
							undefined,
							Option.some({
								append: [{ id: Item.Id.make("media"), content: media }],
								value: {
									...current.state,
									conversation: {
										...current.state.conversation,
										context: ContextWindow.append(
											current.state.conversation.context,
											media,
										),
									},
								},
							}),
						] as const),
				})
				const fresh = yield* ChatStoreRepository.make({
					definition,
					persistence,
				})
				const restored = yield* fresh.read(chat)
				assert.deepEqual(restored, appended.view)
				assert.equal(restored.state.conversation.context._tag, "Native")
				const [item] = yield* fresh.items(chat)
				assert.ok(item)
				assert.equal(item.id, "media")
				assert.equal(item.seq, 1)
				assert.deepEqual(item.content, media)
				assert.deepEqual(restored.state["future"], { tokens: 4, secret: "x" })
				assert.deepEqual(restored.chat.business["unknown"], {
					archived: [1, null],
				})
				const json = yield* Schema.encodeEffect(definition.schema)(
					restored.state,
				)
				assert.deepEqual(
					EffectArray.sort(
						Object.keys(json as Schema.JsonObject),
						Order.String,
					),
					["conversation", "future"],
				)
				assert.ok(
					Exit.isFailure(
						yield* Effect.exit(
							Schema.decodeEffect(definition.schema)({
								plugins: {},
								unrecognizedPlugins: {},
							}),
						),
					),
				)
			}),
		),
	)
})

test("stored data that does not decode fails with decode-failed, and an old revision fails with reference-conflict", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* define
				const persistence = yield* MemoryPersistence.make
				const store = yield* ChatStoreRepository.make({
					definition,
					persistence,
				})
				const broken = Chat.Id.make("broken")
				yield* persistence.save({
					chat: broken,
					ref: { id: broken },
					revision: 0,
					expected: null,
					state: {},
					items: [],
				})
				const error = yield* store.read(broken).pipe(Effect.flip)
				assert.ok(error._tag === "ChatStoreError")
				assert.equal(error.reason, "decode-failed")
				const view = yield* store.create({})
				const conflict = yield* persistence
					.save({
						chat: view.chat.id,
						ref: null,
						revision: 1,
						expected: null,
						items: [],
					})
					.pipe(Effect.flip)
				assert.equal(conflict.reason, "reference-conflict")
				assert.deepEqual(yield* store.read(view.chat.id), view)
			}),
		),
	)
})
