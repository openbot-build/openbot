import { modelForBuild } from "./LanguageModelTest.ts"
import { assert, it } from "@effect/vitest"
import {
	Order,
	Ref,
	Scope,
	Array as Arr,
	Cause,
	Context,
	Deferred,
	Exit,
	Fiber,
	SynchronizedRef,
	Effect,
	Option,
	Schema,
	SchemaTransformation,
	Stream,
	Predicate,
	Record as Rec,
	Result,
} from "effect"
import { Prompt } from "effect/ai"
import {
	Bot,
	Chat,
	ChatRuntime,
	ChatState,
	ChatStore,
	ChatStoreRepository,
	MemoryPersistence,
	Plugin,
	PluginComposition,
	PluginState,
	Store,
	Turn,
} from "@openbot-build/core"
import { ChatTest } from "./ChatTest.ts"
import { LanguageModelTest, textParts } from "./LanguageModelTest.ts"

const pluginId = <Name extends "a" | "b">(name: Name) =>
	Plugin.Id.make(name) as Plugin.Id<Name>
const declaration = () => {
	const schema = Schema.Struct({ value: Schema.Natural })
	return {
		scope: "state" as const,
		schema,
	}
}
it.effect(
	"host-provided stores are isolated and keep their exact definitions and operation dependencies",
	() => {
		class StoreDependency extends Context.Service<StoreDependency, number>()(
			"@openbot-build/core/test/Plugin.test/StoreDependency",
		) {}
		let reads = 0
		const a = declaration(),
			b = declaration(),
			idA = pluginId("a"),
			idB = pluginId("b")
		const unusedWrite = () =>
			Effect.fail(
				Chat.ChatError.make({
					reason: "state-conflict",
					message: "Unused write",
				}),
			)
		const StoreTest = <D extends Plugin.StateDeclaration>(definition: D) => ({
			definition,
			get: Effect.map(StoreDependency, (n) => {
				reads++
				return Option.some({ value: n })
			}),
			snapshot: Effect.map(StoreDependency, (n) => {
				reads++
				return {
					at: {
						chat: Chat.Id.make("test"),
						revision: Chat.Revision.make(0),
					},
					value: Option.some({ value: n }),
				}
			}),
			set: unusedWrite,
			getAndSet: unusedWrite,
			setAndGet: unusedWrite,
			modify: unusedWrite,
			modifyEffect: unusedWrite,
			modifySome: unusedWrite,
			modifySomeEffect: unusedWrite,
			update: unusedWrite,
			updateEffect: unusedWrite,
			getAndUpdate: unusedWrite,
			getAndUpdateEffect: unusedWrite,
			updateAndGet: unusedWrite,
			updateAndGetEffect: unusedWrite,
			updateSome: unusedWrite,
			updateSomeEffect: unusedWrite,
			getAndUpdateSome: unusedWrite,
			getAndUpdateSomeEffect: unusedWrite,
			updateSomeAndGet: unusedWrite,
			updateSomeAndGetEffect: unusedWrite,
			setAt: () =>
				Effect.fail(
					Chat.ChatError.make({
						reason: "state-conflict",
						message: "unused",
					}),
				),
		})
		const storeA = StoreTest(a),
			storeB = StoreTest(b)
		let seen: ReadonlyArray<string> = []
		const pluginA = Plugin.make<
			typeof idA,
			typeof a,
			Chat.ChatError,
			StoreDependency
		>({ id: idA, store: a })((ctx) =>
			Effect.succeed({
				tools: {},
				handlers: Context.empty(),
				beforeStep: () =>
					Effect.gen(function* () {
						assert.strictEqual(ctx.store.definition, a)
						const own = yield* ctx.store
						assert.strictEqual(own, storeA)
						const state = yield* own.snapshot
						assert.strictEqual(Option.getOrThrow(state.value).value, 7)
						seen = Arr.append(seen, "a")
						return true
					}),
			}),
		)
		const pluginB = Plugin.make<
			typeof idB,
			typeof b,
			Chat.ChatError,
			StoreDependency
		>({ id: idB, store: b })((ctx) =>
			Effect.succeed({
				tools: {},
				handlers: Context.empty(),
				beforeStep: () =>
					Effect.gen(function* () {
						const own = yield* ctx.store
						assert.strictEqual(own, storeB)
						yield* own.get
						seen = Arr.append(seen, "b")
						return true
					}),
			}),
		)
		assert.strictEqual(pluginA.id, "a")
		assert.strictEqual(pluginA.store.definition, a)
		assert.strictEqual(pluginB.store.definition, b)
		assert.strictEqual(pluginB.id, "b")
		assert.strictEqual(Predicate.hasProperty(storeA.definition, "id"), false)
		assert.strictEqual(Predicate.hasProperty(storeB.definition, "id"), false)
		assert.strictEqual(reads, 0)
		return Effect.gen(function* () {
			const combined = yield* PluginComposition.mergeState(
				Plugin.Id.make("both"),
				pluginA,
				pluginB,
			)
			assert.strictEqual(combined.stores.a, a)
			assert.strictEqual(combined.stores.b, b)
			yield* Effect.scoped(
				Effect.gen(function* () {
					const definition = yield* Store.define({
						stores: combined.stores,
						schemaVersion: "chat/1",
					})
					const runtimeStore = yield* ChatStoreRepository.make({
						definition: definition,
						persistence: yield* MemoryPersistence.make,
					})
					const construction = ChatRuntime.make({
						store: runtimeStore,
						bot: { plugin: combined },
					}).pipe(Effect.provide(modelForBuild))
					const runtime = yield* construction
					const view = yield* runtimeStore.create({})
					const task = runtime.execute({ chat: view.chat.id, input: "hello" })
					const preserved: StoreDependency extends Effect.Services<
						typeof construction
					>
						? true
						: false = true
					const providedA = construction.pipe(
						Effect.provideService(pluginA.store, storeA),
					)
					const requiresB: typeof pluginB.store.Identifier extends Effect.Services<
						typeof providedA
					>
						? true
						: false = true
					assert.ok(preserved)
					assert.ok(requiresB)
					yield* task
				}),
			).pipe(
				Effect.provideService(pluginA.store, storeA),
				Effect.provideService(pluginB.store, storeB),
				Effect.provideService(StoreDependency, 7),
				Effect.provide(
					LanguageModelTest({
						streamText: () => Stream.fromArray(textParts("done")),
					}),
				),
			)
			assert.strictEqual(reads, 2)
			assert.deepStrictEqual(seen, ["a", "b"])
			const duplicated = yield* PluginComposition.mergeState(
				Plugin.Id.make("duplicate"),
				pluginA,
				pluginA,
			).pipe(Effect.flip)
			assert.strictEqual(duplicated.id, "a")
		})
	},
)
it.effect(
	"one plugin builds its runtime and store in order, reads state in a hook and checks the revision of a write",
	() =>
		Effect.gen(function* () {
			class EncodingDependency extends Context.Service<
				EncodingDependency,
				number
			>()("@openbot-build/core/test/Plugin.test/EncodingDependency") {}
			let encodes = 0
			const domain = Schema.Struct({ value: Schema.Natural })
			const a = {
					scope: "state" as const,
					schema: domain.pipe(
						Schema.decodeTo(
							domain,
							SchemaTransformation.transformEffect({
								decode: Effect.succeed,
								encode: (value) =>
									Effect.map(EncodingDependency, (dependency) => {
										assert.strictEqual(dependency, 7)
										encodes++
										return value
									}),
							}),
						),
					),
				},
				b = declaration()
			let observed: ReadonlyArray<number> = []
			const plugin = Plugin.make({ id: pluginId("a"), store: a })((ctx) =>
				Effect.succeed({
					tools: {},
					handlers: Context.empty(),
					beforeStep: () =>
						Effect.gen(function* () {
							const own = yield* ctx.store
							const state = yield* own.snapshot
							observed = Arr.append(
								observed,
								Option.getOrThrow(state.value).value,
							)
							return true
						}),
				}),
			)
			const definition = yield* Store.define({
				stores: { ...plugin.stores, b },
				schemaVersion: "chat/1",
			})
			const runtimeStore = yield* ChatStoreRepository.make({
				definition: definition,
				persistence: yield* MemoryPersistence.make,
			}).pipe(Effect.provideService(EncodingDependency, 7))

			const view = yield* runtimeStore
				.create({
					value: {
						...ChatState.initial({ a: { value: 1 }, b: { value: 2 } }),
						future: { x: 1 },
					},
				})
				.pipe(Effect.provideService(EncodingDependency, 7))
			const beforeConstruction = encodes
			const own = yield* PluginState.make({
				store: runtimeStore,
				plugin,
			}).pipe(Effect.provideService(EncodingDependency, 7))
			assert.strictEqual(encodes, beforeConstruction)
			assert.strictEqual(own.definition, plugin.store.definition)
			assert.deepStrictEqual(observed, [])
			const runtime = yield* ChatRuntime.make({
				store: runtimeStore,
				bot: { plugin },
			}).pipe(
				Effect.provideService(plugin.store, own),
				Effect.provide(
					LanguageModelTest({
						streamText: () => Stream.fromArray(textParts("done")),
					}),
				),
			)
			const completed = yield* runtime
				.execute({ chat: view.chat.id, input: "hello" })
				.pipe(
					Effect.provideService(plugin.store, own),
					Effect.provideService(EncodingDependency, 7),
					Effect.provide(
						LanguageModelTest({
							streamText: () => Stream.fromArray(textParts("done")),
						}),
					),
				)
			assert.deepStrictEqual(observed, [1])
			assert.deepStrictEqual(completed.state.a, { value: 1 })
			assert.deepStrictEqual(completed.state.b, { value: 2 })
			assert.deepStrictEqual(completed.state["future"], { x: 1 })
			const context = Bot.Context.of({
				options: { prompt: Prompt.empty },
				at: runtimeStore.read(view.chat.id).pipe(
					Effect.map((v) => Chat.position(v.chat)),
					Effect.orDie,
				),
				turn: Effect.succeed(Turn.Id.make("test-turn")),
				step: Effect.succeed(0),
				history: Effect.succeed(Prompt.empty),
			})
			const program = Effect.gen(function* () {
				const read = yield* own.snapshot
				assert.strictEqual(Option.getOrThrow(read.value).value, 1)
				const updated = yield* own.setAt({
					base: read.at,
					value: Option.some({ value: 3 }),
				})
				assert.strictEqual(updated.revision, read.at.revision + 1)
				const value = (yield* runtimeStore.read(view.chat.id)).state
				assert.deepStrictEqual(value.a, { value: 3 })
				assert.deepStrictEqual(value.b, { value: 2 })
				assert.deepStrictEqual(value["future"], { x: 1 })
				assert.deepStrictEqual(value.conversation, completed.state.conversation)
				const stale = yield* own
					.setAt({ base: read.at, value: Option.none() })
					.pipe(Effect.flip)
				assert.ok(Predicate.hasProperty(stale, "reason"))
				assert.strictEqual(stale.reason, "reference-conflict")
				const other = yield* runtimeStore
					.create({})
					.pipe(Effect.provideService(EncodingDependency, 7))
				const wrong = yield* own
					.setAt({
						base: Chat.position(other.chat),
						value: Option.some({ value: 9 }),
					})
					.pipe(Effect.flip)
				assert.ok(Predicate.hasProperty(wrong, "reason"))
				assert.strictEqual(wrong.reason, "state-conflict")
				yield* own.setAt({
					base: Chat.position(updated),
					value: Option.none(),
				})
				const removed = (yield* runtimeStore.read(view.chat.id)).state
				assert.strictEqual(Rec.has(removed, "a"), false)
				assert.deepStrictEqual(removed.b, { value: 2 })
				assert.deepStrictEqual(removed["future"], { x: 1 })
				assert.deepStrictEqual(
					removed.conversation,
					completed.state.conversation,
				)
			})
			yield* program.pipe(Effect.provideService(Bot.Context, context))
		}),
)

it.effect("a plugin cannot use a core namespace as its ID", () =>
	Effect.gen(function* () {
		yield* Effect.forEach(
			["chat", "conversation"],
			(id) =>
				Schema.decodeEffect(Plugin.Id)(id).pipe(
					Effect.flip,
					Effect.map((error) =>
						assert.strictEqual(error.message, "Core namespaces are reserved"),
					),
				),
			{ discard: true },
		)
		assert.strictEqual(
			yield* Schema.decodeEffect(Plugin.Id)("resident"),
			"resident",
		)
	}),
)

const counterStore = (
	beforeSave: (
		delta: ChatStore.Delta,
	) => Effect.Effect<void, ChatStore.ChatStoreError> = () => Effect.void,
) =>
	Effect.gen(function* () {
		const plugin = Plugin.make({ id: pluginId("a"), store: declaration() })(
			() => Effect.succeed({ tools: {}, handlers: Context.empty() }),
		)
		const definition = yield* Store.define({
			stores: plugin.stores,
			schemaVersion: "chat/1",
		})
		const storage = yield* MemoryPersistence.make
		const runtimeStore = yield* ChatStoreRepository.make({
			definition: definition,
			persistence: storage,
			onCommit: ({ delta }) =>
				beforeSave(delta).pipe(Effect.andThen(storage.save(delta))),
		})
		const runtime = yield* ChatRuntime.make({
			store: runtimeStore,
			bot: {},
		}).pipe(Effect.provide(modelForBuild))
		const initial = yield* runtimeStore.create({
			value: {
				...ChatState.initial({ a: { value: 0 } }),
				other: { keep: true },
			},
		})
		const own = yield* PluginState.make({ store: runtimeStore, plugin })
		const context = Bot.Context.of({
			options: { prompt: Prompt.empty },
			at: Effect.succeed(Chat.position(initial.chat)),
			turn: Effect.succeed(Turn.Id.make("test-turn")),
			step: Effect.succeed(0),
			history: Effect.succeed(Prompt.empty),
		})
		return { own, runtime, runtimeStore, storage, initial, context }
	})

it.effect(
	"a plugin store with record scope keeps its data on the record of the Chat, not in the state",
	() =>
		Effect.gen(function* () {
			const plugin = Plugin.make({
				id: pluginId("b"),
				store: {
					scope: "record" as const,
					schema: Schema.Struct({ value: Schema.Natural }),
				},
			})(() => Effect.succeed({ tools: {}, handlers: Context.empty() }))
			const definition = yield* Store.define({
				stores: plugin.stores,
				schemaVersion: "chat/1",
			})
			const persistence = yield* MemoryPersistence.make
			const runtimeStore = yield* ChatStoreRepository.make({
				definition,
				persistence,
			})
			const initial = yield* runtimeStore.create({})
			const chat = initial.chat.id
			const own = yield* PluginState.make({ store: runtimeStore, plugin })
			const context = Bot.Context.of({
				options: { prompt: Prompt.empty },
				at: runtimeStore.read(chat).pipe(
					Effect.map((view) => Chat.position(view.chat)),
					Effect.orDie,
				),
				turn: Effect.succeed(Turn.Id.make("test-turn")),
				step: Effect.succeed(0),
				history: Effect.succeed(Prompt.empty),
			})
			yield* Effect.gen(function* () {
				assert.deepStrictEqual(yield* own.get, Option.none())
				yield* own.set(Option.some({ value: 4 }))
				const view = yield* runtimeStore.read(chat)
				assert.strictEqual(view.chat.revision, initial.chat.revision + 1)
				assert.deepStrictEqual(view.chat.business["b"], { value: 4 })
				assert.deepStrictEqual(view.state, initial.state)
				const fresh = yield* ChatStoreRepository.make({
					definition,
					persistence,
				})
				assert.deepStrictEqual((yield* fresh.read(chat)).chat.business["b"], {
					value: 4,
				})
				const invalid = yield* own
					.set(Option.some({ value: -1 }))
					.pipe(Effect.flip)
				assert.ok(Predicate.hasProperty(invalid, "reason"))
				assert.strictEqual(invalid.reason, "encode-failed")
				yield* own.set(Option.none())
				const removed = yield* runtimeStore.read(chat)
				assert.strictEqual(Rec.has(removed.chat.business, "b"), false)
				assert.deepStrictEqual(removed.state, initial.state)
			}).pipe(Effect.provideService(Bot.Context, context))
		}),
)

it.effect(
	"Store safe methods match SynchronizedRef return values and commit only selected writes",
	() =>
		Effect.gen(function* () {
			const { own, runtimeStore, initial, context } = yield* counterStore()
			const native = yield* SynchronizedRef.make<
				Option.Option<{ readonly value: number }>
			>(Option.some({ value: 0 }))
			const increment = (value: Option.Option<{ readonly value: number }>) =>
				Option.map(value, (counter) => ({ value: counter.value + 1 }))
			const selected = (value: Option.Option<{ readonly value: number }>) =>
				Option.some(increment(value))
			const check = <A, E>(
				name: string,
				actual: Effect.Effect<A, E, Bot.Context>,
				expected: Effect.Effect<A>,
				writes = true,
			) =>
				Effect.gen(function* () {
					const previous = yield* runtimeStore.read(initial.chat.id)
					assert.deepStrictEqual(yield* actual, yield* expected, name)
					assert.deepStrictEqual(
						yield* own.get,
						yield* SynchronizedRef.get(native),
						name,
					)
					const view = yield* runtimeStore.read(initial.chat.id)
					assert.deepStrictEqual(view.state["other"], { keep: true }, name)
					assert.deepStrictEqual(
						view.state.conversation,
						initial.state.conversation,
						name,
					)
					assert.strictEqual(
						view.chat.revision,
						previous.chat.revision + Number(writes),
						name,
					)
					assert.deepStrictEqual(
						view.chat.business,
						initial.chat.business,
						name,
					)
				})
			const program = Effect.gen(function* () {
				yield* check("get", own.get, SynchronizedRef.get(native), false)
				yield* check(
					"set",
					own.set(Option.some({ value: 1 })),
					SynchronizedRef.set(native, Option.some({ value: 1 })).pipe(
						Effect.asVoid,
					),
					true,
				)
				yield* check(
					"getAndSet",
					own.getAndSet(Option.some({ value: 2 })),
					SynchronizedRef.getAndSet(native, Option.some({ value: 2 })),
					true,
				)
				yield* check(
					"setAndGet",
					own.setAndGet(Option.some({ value: 3 })),
					SynchronizedRef.setAndGet(native, Option.some({ value: 3 })),
					true,
				)
				yield* check(
					"update",
					own.update(increment),
					SynchronizedRef.update(native, increment),
					true,
				)
				yield* check(
					"getAndUpdate",
					own.getAndUpdate(increment),
					SynchronizedRef.getAndUpdate(native, increment),
					true,
				)
				yield* check(
					"updateAndGet",
					own.updateAndGet(increment),
					SynchronizedRef.updateAndGet(native, increment),
					true,
				)
				yield* check(
					"modify",
					own.modify((value) => ["result", increment(value)] as const),
					SynchronizedRef.modify(
						native,
						(value) => ["result", increment(value)] as const,
					),
					true,
				)
				yield* check(
					"modifyEffect",
					own.modifyEffect((value) =>
						Effect.succeed(["result", increment(value)] as const),
					),
					SynchronizedRef.modifyEffect(native, (value) =>
						Effect.succeed(["result", increment(value)] as const),
					),
					true,
				)
				yield* check(
					"updateEffect",
					own.updateEffect((value) => Effect.succeed(increment(value))),
					SynchronizedRef.updateEffect(native, (value) =>
						Effect.succeed(increment(value)),
					),
					true,
				)
				yield* check(
					"getAndUpdateEffect",
					own.getAndUpdateEffect((value) => Effect.succeed(increment(value))),
					SynchronizedRef.getAndUpdateEffect(native, (value) =>
						Effect.succeed(increment(value)),
					),
					true,
				)
				yield* check(
					"updateAndGetEffect",
					own.updateAndGetEffect((value) => Effect.succeed(increment(value))),
					SynchronizedRef.updateAndGetEffect(native, (value) =>
						Effect.succeed(increment(value)),
					),
					true,
				)
				yield* check(
					"modifySome selected",
					own.modifySome((value) => ["result", selected(value)] as const),
					SynchronizedRef.modifySome(
						native,
						(value) => ["result", selected(value)] as const,
					),
					true,
				)
				yield* check(
					"modifySome skipped",
					own.modifySome(() => ["result", Option.none()] as const),
					SynchronizedRef.modifySome(
						native,
						() => ["result", Option.none()] as const,
					),
					false,
				)
				yield* check(
					"modifySomeEffect selected",
					own.modifySomeEffect((value) =>
						Effect.succeed(["result", selected(value)] as const),
					),
					SynchronizedRef.modifySomeEffect(native, (value) =>
						Effect.succeed(["result", selected(value)] as const),
					),
					true,
				)
				yield* check(
					"modifySomeEffect skipped",
					own.modifySomeEffect(() =>
						Effect.succeed(["result", Option.none()] as const),
					),
					SynchronizedRef.modifySomeEffect(native, () =>
						Effect.succeed(["result", Option.none()] as const),
					),
					false,
				)
				yield* check(
					"updateSome selected",
					own.updateSome((value) => selected(value)),
					SynchronizedRef.updateSome(native, (value) => selected(value)),
					true,
				)
				yield* check(
					"updateSome skipped",
					own.updateSome(() => Option.none()),
					SynchronizedRef.updateSome(native, () => Option.none()),
					false,
				)
				yield* check(
					"updateSomeEffect selected",
					own.updateSomeEffect((value) => Effect.succeed(selected(value))),
					SynchronizedRef.updateSomeEffect(native, (value) =>
						Effect.succeed(selected(value)),
					),
					true,
				)
				yield* check(
					"updateSomeEffect skipped",
					own.updateSomeEffect(() => Effect.succeedNone),
					SynchronizedRef.updateSomeEffect(native, () => Effect.succeedNone),
					false,
				)
				yield* check(
					"getAndUpdateSome selected",
					own.getAndUpdateSome((value) => selected(value)),
					SynchronizedRef.getAndUpdateSome(native, (value) => selected(value)),
					true,
				)
				yield* check(
					"getAndUpdateSome skipped",
					own.getAndUpdateSome(() => Option.none()),
					SynchronizedRef.getAndUpdateSome(native, () => Option.none()),
					false,
				)
				yield* check(
					"getAndUpdateSomeEffect selected",
					own.getAndUpdateSomeEffect((value) =>
						Effect.succeed(selected(value)),
					),
					SynchronizedRef.getAndUpdateSomeEffect(native, (value) =>
						Effect.succeed(selected(value)),
					),
					true,
				)
				yield* check(
					"getAndUpdateSomeEffect skipped",
					own.getAndUpdateSomeEffect(() => Effect.succeedNone),
					SynchronizedRef.getAndUpdateSomeEffect(
						native,
						() => Effect.succeedNone,
					),
					false,
				)
				yield* check(
					"updateSomeAndGet selected",
					own.updateSomeAndGet((value) => selected(value)),
					SynchronizedRef.updateSomeAndGet(native, (value) => selected(value)),
					true,
				)
				yield* check(
					"updateSomeAndGet skipped",
					own.updateSomeAndGet(() => Option.none()),
					SynchronizedRef.updateSomeAndGet(native, () => Option.none()),
					false,
				)
				yield* check(
					"updateSomeAndGetEffect selected",
					own.updateSomeAndGetEffect((value) =>
						Effect.succeed(selected(value)),
					),
					SynchronizedRef.updateSomeAndGetEffect(native, (value) =>
						Effect.succeed(selected(value)),
					),
					true,
				)
				yield* check(
					"updateSomeAndGetEffect skipped",
					own.updateSomeAndGetEffect(() => Effect.succeedNone),
					SynchronizedRef.updateSomeAndGetEffect(
						native,
						() => Effect.succeedNone,
					),
					false,
				)
				yield* check(
					"same value",
					own.update((value) => value),
					SynchronizedRef.update(native, (value) => value),
					false,
				)
				yield* check(
					"delete",
					own.updateSome(() => Option.some(Option.none())),
					SynchronizedRef.updateSome(native, () => Option.some(Option.none())),
				)
				assert.strictEqual(
					Rec.has((yield* runtimeStore.read(initial.chat.id)).state, "a"),
					false,
				)
			})
			yield* program.pipe(Effect.provideService(Bot.Context, context))
		}),
)

it.effect(
	"concurrent Store Effect updates use committed state and keep failures and interruption",
	() =>
		Effect.gen(function* () {
			let reject = false
			const { own, runtime, runtimeStore, initial, context } =
				yield* counterStore(() =>
					reject
						? Effect.fail(
								ChatStore.ChatStoreError.make({
									reason: "storage-failed",
									message: "Fixture storage failure",
								}),
							)
						: Effect.yieldNow,
				)
			const observer = yield* runtime
				.events({
					chat: initial.chat.id,
					after: initial.chat.revision,
				})
				.pipe(
					Stream.filter((event) => event._tag === "ChatUpdated"),
					Stream.map((event) => event.view.chat.revision),
					Stream.take(21),
					Stream.runCollect,
					Effect.forkChild({ startImmediately: true }),
				)
			const program = Effect.gen(function* () {
				const refs = yield* Effect.forEach(
					Array.from({ length: 20 }),
					() =>
						own.updateAndGetEffect((value) =>
							Effect.yieldNow.pipe(
								Effect.as(
									Option.map(value, (counter) => ({
										value: counter.value + 1,
									})),
								),
							),
						),
					{ concurrency: "unbounded" },
				)
				assert.deepStrictEqual(
					Arr.sort(
						Arr.map(refs, (value) => Option.getOrThrow(value).value),
						Order.Number,
					),
					Array.from({ length: 20 }, (_, i) => i + 1),
				)
				assert.deepStrictEqual(yield* own.get, Option.some({ value: 20 }))
				const before = yield* runtimeStore.read(initial.chat.id)
				assert.strictEqual(before.chat.revision, initial.chat.revision + 20)
				const invalid = yield* own
					.set(Option.some({ value: -1 }))
					.pipe(Effect.flip)
				assert.ok(Predicate.hasProperty(invalid, "reason"))
				assert.strictEqual(invalid.reason, "encode-failed")
				assert.strictEqual(
					yield* own
						.updateEffect(() => Effect.fail("update-failed" as const))
						.pipe(Effect.flip),
					"update-failed",
				)
				const defect = yield* own
					.modifyEffect(() => Effect.die("fixture defect"))
					.pipe(Effect.exit)
				assert.ok(Exit.hasDies(defect))
				assert.ok(!Cause.hasFails(defect.cause))
				const entered = yield* Deferred.make<void>()
				const interrupted = yield* own
					.updateEffect(() =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Effect.never),
						),
					)
					.pipe(Effect.forkChild)
				yield* Deferred.await(entered)
				yield* Fiber.interrupt(interrupted)
				assert.deepStrictEqual(
					yield* runtimeStore.read(initial.chat.id),
					before,
				)
				reject = true
				const failure = yield* own
					.set(Option.some({ value: 99 }))
					.pipe(Effect.flip)
				assert.ok(Predicate.hasProperty(failure, "reason"))
				assert.strictEqual(failure.reason, "storage-failed")
				assert.deepStrictEqual(yield* own.get, Option.some({ value: 20 }))
				assert.deepStrictEqual(
					yield* runtimeStore.read(initial.chat.id),
					before,
				)
				reject = false
				yield* own.set(Option.some({ value: 21 }))
				assert.deepStrictEqual(yield* own.get, Option.some({ value: 21 }))
				const observed = yield* Fiber.join(observer)
				assert.deepStrictEqual(
					Arr.sort(observed, Order.Number),
					Array.from({ length: 21 }, (_, i) => initial.chat.revision + i + 1),
				)
			})
			yield* program.pipe(Effect.provideService(Bot.Context, context))
		}),
)

it.effect("Store writes return and notify only after the change is saved", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const release = yield* Deferred.make<void>()
		let blocked = false
		const { own, runtime, runtimeStore, initial, context } =
			yield* counterStore(() =>
				blocked
					? Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						)
					: Effect.void,
			)
		blocked = true
		let returned = false
		const waiting = yield* runtime
			.wait({
				chat: initial.chat.id,
				after: initial.chat.revision,
				timeout: "1 minute",
			})
			.pipe(Effect.forkChild)
		const writing = yield* own.set(Option.some({ value: 1 })).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					returned = true
				}),
			),
			Effect.provideService(Bot.Context, context),
			Effect.forkChild,
		)
		yield* Deferred.await(started)
		assert.strictEqual(returned, false)
		assert.deepStrictEqual(
			yield* runtimeStore.get(initial.chat.id),
			Option.some(initial.chat),
		)
		assert.deepStrictEqual(yield* runtimeStore.read(initial.chat.id), initial)
		yield* Deferred.succeed(release, undefined)
		yield* Fiber.join(writing)
		assert.strictEqual(returned, true)
		const observed = yield* Fiber.join(waiting)
		assert.deepStrictEqual(
			Option.some(observed.chat),
			yield* runtimeStore.get(initial.chat.id),
		)
		assert.deepStrictEqual(observed.state.a, { value: 1 })
		assert.strictEqual(observed.chat.revision, initial.chat.revision + 1)
	}),
)

it.effect("plugin construction and its fibers belong to each Turn", () => {
	let constructions = 0
	let services = 0
	let uses: ReadonlyArray<number> = []
	const plugin = Plugin.make({ id: Plugin.Id.make("resident") })(() => {
		constructions++
		return Effect.gen(function* () {
			const count = yield* Ref.make(0)
			const ready = yield* Deferred.make<void>()
			yield* Effect.forkScoped(
				Effect.acquireRelease(
					Effect.sync(() => {
						services++
					}),
					() =>
						Effect.sync(() => {
							services--
						}),
				).pipe(
					Effect.andThen(Deferred.succeed(ready, undefined)),
					Effect.andThen(Effect.never),
				),
			)
			yield* Deferred.await(ready)
			return {
				tools: {},
				handlers: Context.empty(),
				beforeStep: () =>
					Effect.gen(function* () {
						uses = Arr.append(
							uses,
							yield* Ref.updateAndGet(count, (n) => n + 1),
						)
						return true
					}),
			}
		})
	})
	const combined = PluginComposition.merge(
		plugin,
		Plugin.make({ id: Plugin.Id.make("pass") })(() =>
			Effect.succeed({ tools: {}, handlers: Context.empty() }),
		),
	)
	assert.strictEqual(constructions, 0)
	return Effect.gen(function* () {
		const blocked = yield* Deferred.make<void>()
		yield* Effect.scoped(
			Effect.gen(function* () {
				const parent = yield* Effect.scope
				const firstScope = yield* Scope.fork(parent)
				const secondScope = yield* Scope.fork(parent)
				const first = yield* ChatTest({ plugin: combined }).pipe(
					Scope.provide(firstScope),
				)
				assert.strictEqual(constructions, 0)
				assert.strictEqual(services, 0)
				yield* first.runtime.execute({ chat: first.chat, input: "one" })
				yield* first.runtime
					.stream({ chat: first.chat, input: "two" })
					.pipe(Stream.runDrain)
				assert.strictEqual(services, 0)
				assert.strictEqual(constructions, 2)
				assert.deepStrictEqual(uses, [1, 1])
				const second = yield* ChatTest({ plugin: combined }).pipe(
					Scope.provide(secondScope),
				)
				yield* second.runtime.execute({
					chat: second.chat,
					input: "independent",
				})
				assert.strictEqual(services, 0)
				assert.deepStrictEqual(uses, [1, 1, 1])
				const receipt = yield* first.runtime.deliver({
					chat: first.chat,
					input: "block",
				})
				assert.strictEqual(receipt.delivery, "started")
				yield* Deferred.await(blocked)
				assert.strictEqual(services, 1)
				yield* first.runtime.interrupt({
					chat: receipt.chat,
					turn: receipt.turn!,
				})
				assert.strictEqual(services, 0)
				yield* Scope.close(firstScope, Exit.succeed(undefined))
				assert.strictEqual(services, 0)
				yield* Scope.close(secondScope, Exit.succeed(undefined))
				assert.strictEqual(services, 0)
			}),
		).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: ({ prompt }) =>
						Arr.some(
							prompt.content,
							(message) =>
								message.role === "user" &&
								Arr.some(
									message.content,
									(part) => part.type === "text" && part.text === "block",
								),
						)
							? Stream.fromEffect(Deferred.succeed(blocked, undefined)).pipe(
									Stream.flatMap(() => Stream.never),
								)
							: Stream.fromArray(textParts("done")),
				}),
			),
		)
		assert.strictEqual(constructions, 4)
		assert.strictEqual(services, 0)
	})
})

it.effect(
	"combined constructors keep hook order and release partly built plugins on failure",
	() => {
		let calls: ReadonlyArray<string> = []
		const plugin = (name: string) =>
			Plugin.make({ id: Plugin.Id.make(name) })(() =>
				Effect.gen(function* () {
					yield* Effect.acquireRelease(
						Effect.sync(() => {
							calls = Arr.append(calls, "build-" + name)
						}),
						() =>
							Effect.sync(() => {
								calls = Arr.append(calls, "release-" + name)
							}),
					)
					return {
						tools: {},
						handlers: Context.empty(),
						beforeStep: () =>
							Effect.sync(() => {
								calls = Arr.append(calls, "enter-" + name)
								return true
							}),
						afterStep: () =>
							Effect.sync(() => {
								calls = Arr.append(calls, "exit-" + name)
							}),
					}
				}),
			)
		const combined = PluginComposition.merge(plugin("a"), plugin("b"))
		assert.deepStrictEqual(calls, [])
		return Effect.gen(function* () {
			yield* Effect.scoped(
				Effect.gen(function* () {
					const { runtime, chat } = yield* ChatTest({ plugin: combined })
					yield* runtime.execute({ chat, input: "one" })
				}),
			).pipe(
				Effect.provide(
					LanguageModelTest({
						streamText: () => Stream.fromArray(textParts("done")),
					}),
				),
			)
			assert.deepStrictEqual(calls, [
				"build-a",
				"build-b",
				"enter-a",
				"enter-b",
				"exit-a",
				"exit-b",
				"release-b",
				"release-a",
			])
			calls = []
			const failed = Plugin.make({ id: Plugin.Id.make("failed") })(() =>
				Effect.fail("build-failed" as const),
			)
			const result = yield* Effect.scoped(
				ChatTest({ plugin: PluginComposition.merge(plugin("a"), failed) }).pipe(
					Effect.flatMap(({ runtime, chat }) =>
						runtime.execute({ chat, input: "one" }),
					),
				),
			).pipe(Effect.result)
			assert.ok(Result.isFailure(result))
			assert.strictEqual(result.failure, "build-failed")
			assert.deepStrictEqual(calls, ["build-a", "release-a"])
		})
	},
)

it.effect(
	"stateful plugins stay Plugin values, so they can be piped and run",
	() => {
		let seen: ReadonlyArray<string> = []
		const tracked = <Name extends "a" | "b">(name: Name) =>
			Plugin.make({ id: pluginId(name) })(() =>
				Effect.succeed({
					tools: {},
					handlers: Context.empty(),
					beforeStep: () =>
						Effect.sync(() => {
							seen = Arr.append(seen, name)
							return true
						}),
				}),
			)
		const after = Plugin.make({ id: Plugin.Id.make("after") })(() =>
			Effect.succeed({
				tools: {},
				handlers: Context.empty(),
				beforeStep: () =>
					Effect.sync(() => {
						seen = Arr.append(seen, "after")
						return true
					}),
			}),
		)
		const stored = Plugin.make({ id: pluginId("a"), store: declaration() })(
			() =>
				Effect.succeed({
					tools: {},
					handlers: Context.empty(),
					beforeStep: () =>
						Effect.sync(() => {
							seen = Arr.append(seen, "a")
							return true
						}),
				}),
		)
		const withStore = PluginComposition.withStore(tracked("b"), declaration())
		return Effect.gen(function* () {
			const merged = yield* PluginComposition.mergeState(
				Plugin.Id.make("both"),
				stored,
				withStore,
			)
			assert.deepStrictEqual(Rec.keys(merged.stores), ["a", "b"])
			yield* Effect.forEach(
				[
					{ plugin: stored.pipe(PluginComposition.merge(after)), seen: ["a"] },
					{
						plugin: withStore.pipe(PluginComposition.merge(after)),
						seen: ["b"],
					},
					{
						plugin: merged.pipe(PluginComposition.merge(after)),
						seen: ["a", "b"],
					},
				],
				(scenario) =>
					Effect.gen(function* () {
						assert.ok(scenario.plugin instanceof Plugin.Plugin)
						seen = []
						const { runtime, chat } = yield* ChatTest({
							plugin: scenario.plugin,
						})
						yield* runtime.execute({ chat, input: "hello" })
						assert.deepStrictEqual(seen, [...scenario.seen, "after"])
					}).pipe(Effect.scoped),
				{ discard: true },
			)
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.fromArray(textParts("done")),
				}),
			),
		)
	},
)
