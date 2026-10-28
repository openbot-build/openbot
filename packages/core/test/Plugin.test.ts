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
import { TestClock } from "effect/testing"
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
			modify: unusedWrite,
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
		return { own, runtime, runtimeStore, storage, definition, initial, context }
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
				yield* own.modify(() => ({
					result: undefined,
					value: Option.some({ value: 4 }),
				}))
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
					.modify(() => ({
						result: undefined,
						value: Option.some({ value: -1 }),
					}))
					.pipe(Effect.flip)
				assert.ok(Predicate.hasProperty(invalid, "reason"))
				assert.strictEqual(invalid.reason, "encode-failed")
				yield* own.modify(() => ({ result: undefined, value: Option.none() }))
				const removed = yield* runtimeStore.read(chat)
				assert.strictEqual(Rec.has(removed.chat.business, "b"), false)
				assert.deepStrictEqual(removed.state, initial.state)
			}).pipe(Effect.provideService(Bot.Context, context))
		}),
)

it.effect("a plugin change can save, remove, or keep its value", () =>
	Effect.gen(function* () {
		const { own, runtimeStore, initial, context } = yield* counterStore()
		yield* Effect.gen(function* () {
			const kept = yield* own.modify((value) => ({ result: value }))
			assert.deepStrictEqual(kept, Option.some({ value: 0 }))
			assert.deepStrictEqual(yield* runtimeStore.read(initial.chat.id), initial)
			const previous = yield* own.modify((value) => ({
				result: Option.getOrThrow(value).value,
				value: Option.some({ value: 4 }),
			}))
			assert.strictEqual(previous, 0)
			assert.deepStrictEqual(yield* own.get, Option.some({ value: 4 }))
			const saved = yield* runtimeStore.read(initial.chat.id)
			assert.strictEqual(saved.chat.revision, initial.chat.revision + 1)
			assert.deepStrictEqual(saved.state["other"], { keep: true })
			assert.deepStrictEqual(
				saved.state.conversation,
				initial.state.conversation,
			)
			assert.deepStrictEqual(saved.chat.business, initial.chat.business)
			const removed = yield* own.modify(() => ({
				result: "removed",
				value: Option.none(),
			}))
			assert.strictEqual(removed, "removed")
			assert.deepStrictEqual(yield* own.get, Option.none())
			const after = yield* runtimeStore.read(initial.chat.id)
			assert.strictEqual(Rec.has(after.state, "a"), false)
			assert.strictEqual(after.chat.revision, saved.chat.revision + 1)
			assert.deepStrictEqual(after.state["other"], { keep: true })
			assert.deepStrictEqual(
				after.state.conversation,
				initial.state.conversation,
			)
			assert.deepStrictEqual(after.chat.business, initial.chat.business)
		}).pipe(Effect.provideService(Bot.Context, context))
	}),
)

it.effect("plugin changes retry with new data, and setAt tries once", () =>
	Effect.gen(function* () {
		let beforeSave: (delta: ChatStore.Delta) => Effect.Effect<void> = () =>
			Effect.void
		const { own, runtimeStore, storage, definition, initial, context } =
			yield* counterStore((delta) => beforeSave(delta))
		const peer = yield* ChatStoreRepository.make({
			definition,
			persistence: storage,
		})
		let saves = 0
		let otherValue = 10
		beforeSave = () =>
			Effect.gen(function* () {
				saves++
				if (saves !== 1) return
				yield* peer
					.modifyEffect({
						chat: initial.chat.id,
						update: (current) =>
							Effect.succeed([
								undefined,
								Option.some({
									value: { ...current.state, a: { value: otherValue } },
								}),
							] as const),
					})
					.pipe(Effect.orDie)
			})
		const writing = yield* own
			.modify((value) => {
				const current = Option.getOrThrow(value).value
				return {
					result: current + 1,
					value: Option.some({ value: current + 1 }),
				}
			})
			.pipe(
				Effect.provideService(Bot.Context, context),
				Effect.forkChild({ startImmediately: true }),
			)
		yield* TestClock.adjust("1 second")
		assert.strictEqual(yield* Fiber.join(writing), 11)
		assert.strictEqual(saves, 2)
		const base = yield* own.snapshot.pipe(
			Effect.provideService(Bot.Context, context),
		)
		saves = 0
		otherValue = 20
		const conflict = yield* own
			.setAt({
				base: base.at,
				value: Option.some({ value: 99 }),
			})
			.pipe(Effect.provideService(Bot.Context, context), Effect.flip)
		assert.ok(Predicate.hasProperty(conflict, "reason"))
		assert.strictEqual(conflict.reason, "reference-conflict")
		assert.strictEqual(saves, 1)
		const saved = yield* runtimeStore.read(initial.chat.id)
		assert.deepStrictEqual(saved.state.a, { value: 20 })
		assert.strictEqual(saved.chat.revision, initial.chat.revision + 3)
	}),
)

it.effect("concurrent plugin changes keep saved data and failures", () =>
	Effect.gen(function* () {
		let reject = false
		const { own, runtime, runtimeStore, initial, context } =
			yield* counterStore(() =>
				reject
					? Effect.fail(
							ChatStore.ChatStoreError.make({
								reason: "storage-failed",
								message: "Test storage failure",
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
		yield* Effect.gen(function* () {
			const values = yield* Effect.forEach(
				Arr.range(1, 20),
				() =>
					own.modify((value) => {
						const next = Option.getOrThrow(value).value + 1
						return { result: next, value: Option.some({ value: next }) }
					}),
				{ concurrency: "unbounded" },
			)
			assert.deepStrictEqual(Arr.sort(values, Order.Number), Arr.range(1, 20))
			assert.deepStrictEqual(yield* own.get, Option.some({ value: 20 }))
			const before = yield* runtimeStore.read(initial.chat.id)
			assert.strictEqual(before.chat.revision, initial.chat.revision + 20)
			const invalid = yield* own
				.modify(() => ({
					result: undefined,
					value: Option.some({ value: -1 }),
				}))
				.pipe(Effect.flip)
			assert.ok(Predicate.hasProperty(invalid, "reason"))
			assert.strictEqual(invalid.reason, "encode-failed")
			assert.deepStrictEqual(yield* runtimeStore.read(initial.chat.id), before)
			reject = true
			const failure = yield* own
				.modify(() => ({
					result: undefined,
					value: Option.some({ value: 99 }),
				}))
				.pipe(Effect.flip)
			assert.ok(Predicate.hasProperty(failure, "reason"))
			assert.strictEqual(failure.reason, "storage-failed")
			assert.deepStrictEqual(yield* own.get, Option.some({ value: 20 }))
			assert.deepStrictEqual(yield* runtimeStore.read(initial.chat.id), before)
			reject = false
			yield* own.modify(() => ({
				result: undefined,
				value: Option.some({ value: 21 }),
			}))
			const observed = yield* Fiber.join(observer)
			const expected: ReadonlyArray<number> = Array.from(
				{ length: 21 },
				(_, index) => initial.chat.revision + index + 1,
			)
			assert.deepStrictEqual(Arr.sort(observed, Order.Number), expected)
		}).pipe(Effect.provideService(Bot.Context, context))
	}),
)

it.effect("a stopped plugin save leaves its value as it was", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		let blocked = false
		const { own, runtimeStore, initial, context } = yield* counterStore(() =>
			blocked
				? Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Effect.never),
					)
				: Effect.void,
		)
		blocked = true
		const writing = yield* own
			.modify(() => ({
				result: undefined,
				value: Option.some({ value: 1 }),
			}))
			.pipe(Effect.provideService(Bot.Context, context), Effect.forkChild)
		yield* Deferred.await(started)
		yield* Fiber.interrupt(writing)
		const exit = yield* Fiber.await(writing)
		assert.ok(Exit.isFailure(exit))
		assert.ok(Cause.hasInterruptsOnly(exit.cause))
		assert.deepStrictEqual(yield* runtimeStore.read(initial.chat.id), initial)
	}),
)

it.effect("plugin writes return and notify after the change is saved", () =>
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
		const writing = yield* own
			.modify(() => ({
				result: undefined,
				value: Option.some({ value: 1 }),
			}))
			.pipe(
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
