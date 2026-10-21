import { Timeline } from "@openbot-build/core"
import { Turn } from "@openbot-build/core"
import { Agent } from "@openbot-build/core"
import { SessionStoreRepository } from "@openbot-build/core"
import {
	Order,
	Ref,
	Scope,
	Array as EffectArray,
	HashSet,
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
} from "effect"
import * as MemoryPersistence from "../src/store/MemoryPersistence.ts"
import { TimelineState, Store } from "@openbot-build/core"
// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"

import { Prompt } from "effect/ai"
import {
	Session,
	SessionRuntime,
	SessionStore,
	SessionStoreMemory,
	Plugin,
	PluginComposition,
	PluginState,
} from "@openbot-build/core"
import { SessionTest } from "./SessionTest.ts"
import { LanguageModelTest, textParts } from "./LanguageModelTest.ts"

const pluginId = <Name extends "a" | "b">(name: Name) =>
	Plugin.Id.make(name) as Plugin.Id<Name>
const declaration = () => {
	const schema = Schema.Struct({ value: Schema.Natural })
	return {
		scope: "timeline" as const,
		schema,
	}
}
test("host-provided stores are isolated and keep their exact definitions and operation dependencies", async () => {
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
			new Session.SessionError({
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
					session: Session.Id.make("test"),
					version: Timeline.VersionId.make("version"),
					revision: Session.Revision.make(0),
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
				new Session.SessionError({
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
		Session.SessionError,
		StoreDependency
	>({ id: idA, store: a })((ctx) =>
		Effect.succeed((next, options) =>
			Stream.unwrap(
				Effect.gen(function* () {
					assert.equal(ctx.store.definition, a)
					const own = yield* ctx.store
					assert.equal(own, storeA)
					const state = yield* own.snapshot
					assert.equal(Option.getOrThrow(state.value).value, 7)
					seen = EffectArray.append(seen, "a")
					return next(options)
				}),
			),
		),
	)
	const pluginB = Plugin.make<
		typeof idB,
		typeof b,
		Session.SessionError,
		StoreDependency
	>({ id: idB, store: b })((ctx) =>
		Effect.succeed((next, options) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const own = yield* ctx.store
					assert.equal(own, storeB)
					yield* own.get
					seen = EffectArray.append(seen, "b")
					return next(options)
				}),
			),
		),
	)
	assert.equal(pluginA.id, "a")
	assert.equal(pluginA.store.definition, a)
	assert.equal(pluginB.store.definition, b)
	assert.equal(pluginB.id, "b")
	assert.equal(Object.hasOwn(storeA.definition, "id"), false)
	assert.equal(Object.hasOwn(storeB.definition, "id"), false)
	assert.equal(reads, 0)
	const combined = yieldSync(
		PluginComposition.mergeState(Plugin.Id.make("both"), pluginA, pluginB),
	)
	assert.equal(combined.stores.a, a)
	assert.equal(combined.stores.b, b)
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* Store.define({
					stores: combined.stores,
					schemaVersion: "timeline/1",
				})
				const runtimeStore = yield* SessionStoreRepository.make({
					definition: definition,
					persistence: yield* MemoryPersistence.make,
				})
				const runtime = yield* SessionRuntime.make({
					store: runtimeStore,
					agent: { plugin: combined },
				})
				const view = yield* runtimeStore.create({
					metadata: {},
					value: TimelineState.initial({}),
				})
				const task = runtime.execute({
					base: { session: view.session.id, revision: view.session.revision },
					input: "hello",
				})
				const preserved: StoreDependency extends Effect.Services<typeof task>
					? true
					: false = true
				const providedA = task.pipe(
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
		),
	)
	assert.equal(reads, 2)
	assert.deepEqual(seen, ["a", "b"])
	const duplicated = await Effect.runPromise(
		PluginComposition.mergeState(
			Plugin.Id.make("duplicate"),
			pluginA,
			pluginA,
		).pipe(Effect.flip),
	)
	assert.equal(duplicated.id, "a")
})
function yieldSync<A, E>(effect: Effect.Effect<A, E>) {
	return Effect.runSync(effect)
}
test("one plugin builds its runtime and store in order, reads state in middleware and keeps versioned writes", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				class EncodingDependency extends Context.Service<
					EncodingDependency,
					number
				>()("@openbot-build/core/test/Plugin.test/EncodingDependency") {}
				let encodes = 0
				const domain = Schema.Struct({ value: Schema.Natural })
				const a = {
						scope: "timeline" as const,
						schema: domain.pipe(
							Schema.decodeTo(
								domain,
								SchemaTransformation.transformEffect({
									decode: Effect.succeed,
									encode: (value) =>
										Effect.map(EncodingDependency, (dependency) => {
											assert.equal(dependency, 7)
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
					Effect.succeed((next, options) =>
						Stream.unwrap(
							Effect.gen(function* () {
								const own = yield* ctx.store
								const state = yield* own.snapshot
								observed = EffectArray.append(
									observed,
									Option.getOrThrow(state.value).value,
								)
								return next(options)
							}),
						),
					),
				)
				const definition = yield* Store.define({
					stores: { ...plugin.stores, b },
					schemaVersion: "timeline/1",
				})
				const runtimeStore = yield* SessionStoreRepository.make({
					definition: definition,
					persistence: yield* MemoryPersistence.make,
				}).pipe(Effect.provideService(EncodingDependency, 7))
				const runtime = yield* SessionRuntime.make({
					store: runtimeStore,
					agent: { plugin: plugin },
				})
				const view = yield* runtimeStore
					.create({
						metadata: {},
						value: {
							...TimelineState.initial({ a: { value: 1 }, b: { value: 2 } }),
							future: { x: 1 },
						},
					})
					.pipe(Effect.provideService(EncodingDependency, 7))
				const store = yield* SessionStoreMemory.make(definition).pipe(
					Effect.provideService(EncodingDependency, 7),
				)
				const beforeConstruction = encodes
				const own = yield* PluginState.make({
					store: runtimeStore,
					plugin,
				}).pipe(Effect.provideService(EncodingDependency, 7))
				assert.equal(encodes, beforeConstruction)
				assert.equal(own.definition, plugin.store.definition)
				assert.deepEqual(observed, [])
				const completed = yield* runtime
					.execute({
						base: { session: view.session.id, revision: view.session.revision },
						input: "hello",
					})
					.pipe(
						Effect.provideService(plugin.store, own),
						Effect.provideService(EncodingDependency, 7),
						Effect.provide(
							LanguageModelTest({
								streamText: () => Stream.fromArray(textParts("done")),
							}),
						),
					)
				assert.deepEqual(observed, [1])
				assert.deepEqual(completed.state.value.a, { value: 1 })
				assert.deepEqual(completed.state.value.b, { value: 2 })
				assert.deepEqual(completed.state.value["future"], { x: 1 })
				assert.throws(() => Plugin.Id.make("session"))
				const context = Agent.Context.of({
					options: { prompt: Prompt.empty },
					at: runtimeStore.read(view.session.id).pipe(
						Effect.map((v) => ({
							session: v.session.id,
							version: v.session.head,
							revision: v.session.revision,
						})),
						Effect.orDie,
					),
					turn: Effect.succeed(Turn.Id.make("test-turn")),
					step: Effect.succeed(0),
					history: Effect.succeed(Prompt.empty),
				})
				const program = Effect.gen(function* () {
					const read = yield* own.snapshot
					assert.equal(Option.getOrThrow(read.value).value, 1)
					const updated = yield* own.setAt({
						base: read.at,
						value: Option.some({ value: 3 }),
					})
					const value = (yield* runtimeStore.read(view.session.id)).state.value
					assert.deepEqual(value.a, { value: 3 })
					assert.deepEqual(value.b, { value: 2 })
					assert.deepEqual(value["future"], { x: 1 })
					assert.deepEqual(
						value.conversation,
						completed.state.value.conversation,
					)
					assert.ok(
						Option.isNone(
							yield* store
								.get(view.session.id)
								.pipe(Effect.provideService(EncodingDependency, 7)),
						),
					)
					const stale = yield* own
						.setAt({ base: read.at, value: Option.none() })
						.pipe(Effect.flip)
					assert.ok(Predicate.hasProperty(stale, "reason"))
					assert.equal(stale.reason, "reference-conflict")
					const branch = yield* runtimeStore
						.fork({
							source: updated.id,
							version: updated.head,
							metadata: {},
						})
						.pipe(Effect.map((view) => view.session))
					const wrong = yield* own
						.setAt({
							base: Session.position(branch),
							value: Option.some({ value: 9 }),
						})
						.pipe(Effect.flip)
					assert.ok(Predicate.hasProperty(wrong, "reason"))
					assert.equal(wrong.reason, "state-conflict")
					yield* own.setAt({
						base: Session.position(updated),
						value: Option.none(),
					})
					const removed = (yield* runtimeStore.read(view.session.id)).state
						.value
					assert.equal(Object.hasOwn(removed, "a"), false)
					assert.deepEqual(removed.b, { value: 2 })
					assert.deepEqual(removed["future"], { x: 1 })
					assert.deepEqual(
						removed.conversation,
						completed.state.value.conversation,
					)
				})
				yield* program.pipe(Effect.provideService(Agent.Context, context))
			}),
		),
	)
})

const counterStore = (
	beforeSave: (
		delta: SessionStore.Delta,
	) => Effect.Effect<void, SessionStore.SessionStoreError> = () => Effect.void,
) =>
	Effect.gen(function* () {
		const plugin = Plugin.make({ id: pluginId("a"), store: declaration() })(
			() => Effect.succeed((next, options) => next(options)),
		)
		const definition = yield* Store.define({
			stores: plugin.stores,
			schemaVersion: "timeline/1",
		})
		const storage = yield* MemoryPersistence.make
		const runtimeStore = yield* SessionStoreRepository.make({
			definition: definition,
			persistence: storage,
			onCommit: ({ delta }) =>
				beforeSave(delta).pipe(Effect.andThen(storage.save(delta))),
		})
		const runtime = yield* SessionRuntime.make({
			store: runtimeStore,
			agent: {},
		})
		const initial = yield* runtimeStore.create({
			metadata: {},
			value: {
				...TimelineState.initial({ a: { value: 0 } }),
				other: { keep: true },
			},
		})
		const own = yield* PluginState.make({ store: runtimeStore, plugin })
		const context = Agent.Context.of({
			options: { prompt: Prompt.empty },
			at: Effect.succeed({
				session: initial.session.id,
				version: initial.session.head,
				revision: initial.session.revision,
			}),
			turn: Effect.succeed(Turn.Id.make("test-turn")),
			step: Effect.succeed(0),
			history: Effect.succeed(Prompt.empty),
		})
		return { own, runtime, runtimeStore, storage, initial, context }
	})

test("Store safe methods match SynchronizedRef return values and commit only selected writes", async () => {
	await Effect.runPromise(
		Effect.scoped(
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
					actual: Effect.Effect<A, E, Agent.Context>,
					expected: Effect.Effect<A>,
					writes = true,
				) =>
					Effect.gen(function* () {
						const previous = yield* runtimeStore.export(initial.session.id)
						assert.deepEqual(yield* actual, yield* expected, name)
						assert.deepEqual(
							yield* own.get,
							yield* SynchronizedRef.get(native),
							name,
						)
						const view = yield* runtimeStore.read(initial.session.id)
						assert.deepEqual(view.state.value["other"], { keep: true }, name)
						assert.deepEqual(
							view.state.value.conversation,
							initial.state.value.conversation,
							name,
						)
						const record = yield* runtimeStore.export(initial.session.id)
						assert.equal(
							record.versions.length,
							previous.versions.length + Number(writes),
							name,
						)
						if (writes)
							assert.deepEqual(
								view.state.version.parents,
								[previous.session.head],
								name,
							)
						else assert.equal(view.session.head, previous.session.head, name)
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
						SynchronizedRef.getAndUpdateSome(native, (value) =>
							selected(value),
						),
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
						SynchronizedRef.updateSomeAndGet(native, (value) =>
							selected(value),
						),
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
						SynchronizedRef.updateSome(native, () =>
							Option.some(Option.none()),
						),
					)
					assert.equal(
						Object.hasOwn(
							(yield* runtimeStore.read(initial.session.id)).state.value,
							"a",
						),
						false,
					)
					assert.deepEqual(
						(yield* runtimeStore.read(initial.session.id, initial.session.head))
							.value,
						initial.state.value,
					)
				})
				yield* program.pipe(Effect.provideService(Agent.Context, context))
			}),
		),
	)
})

test("concurrent Store Effect updates use committed state and keep failures and interruption", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				let reject = false
				const { own, runtime, runtimeStore, initial, context } =
					yield* counterStore(() =>
						reject
							? Effect.fail(
									new SessionStore.SessionStoreError({
										reason: "storage-failed",
										message: "Fixture storage failure",
									}),
								)
							: Effect.yieldNow,
					)
				const observer = yield* runtime
					.events({
						session: initial.session.id,
						after: initial.session.revision,
					})
					.pipe(
						Stream.filter((event) => event._tag === "VersionCreated"),
						Stream.map((event) => event.view.session.head),
						Stream.take(21),
						Stream.runCollect,
						Effect.forkChild,
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
					assert.deepEqual(
						EffectArray.sort(
							refs.map((value) => Option.getOrThrow(value).value),
							Order.Number,
						),
						Array.from({ length: 20 }, (_, i) => i + 1),
					)
					assert.deepEqual(yield* own.get, Option.some({ value: 20 }))
					assert.equal(
						(yield* runtimeStore.export(initial.session.id)).versions.length,
						21,
					)
					const before = yield* runtimeStore.export(initial.session.id)
					const invalid = yield* own
						.set(Option.some({ value: -1 }))
						.pipe(Effect.flip)
					assert.ok(Predicate.hasProperty(invalid, "reason"))
					assert.equal(invalid.reason, "encode-failed")
					assert.equal(
						yield* own
							.updateEffect(() => Effect.fail("update-failed" as const))
							.pipe(Effect.flip),
						"update-failed",
					)
					const defect = yield* own
						.modifyEffect(() => Effect.die("fixture defect"))
						.pipe(Effect.exit)
					assert.ok(Exit.isFailure(defect))
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
					assert.deepEqual(
						yield* runtimeStore.export(initial.session.id),
						before,
					)
					reject = true
					const failure = yield* own
						.set(Option.some({ value: 99 }))
						.pipe(Effect.flip)
					assert.ok(Predicate.hasProperty(failure, "reason"))
					assert.equal(failure.reason, "storage-failed")
					assert.deepEqual(yield* own.get, Option.some({ value: 20 }))
					assert.deepEqual(
						yield* runtimeStore.export(initial.session.id),
						before,
					)
					reject = false
					yield* own.set(Option.some({ value: 21 }))
					assert.deepEqual(yield* own.get, Option.some({ value: 21 }))
					const observed = yield* Fiber.join(observer)
					const committed = yield* runtimeStore.export(initial.session.id)
					assert.deepEqual(
						[...HashSet.fromIterable(observed)].toSorted(),
						committed.versions
							.filter((version) => version.id !== initial.session.head)
							.map((version) => version.id)
							.toSorted(),
					)
				})
				yield* program.pipe(Effect.provideService(Agent.Context, context))
			}),
		),
	)
})

test("Store writes return and notify only after the Version is saved", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				let blocked = false
				const { own, runtime, runtimeStore, storage, initial, context } =
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
						session: initial.session.id,
						after: initial.session.revision,
						timeout: "1 minute",
					})
					.pipe(Effect.forkChild)
				const writing = yield* own.set(Option.some({ value: 1 })).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							returned = true
						}),
					),
					Effect.provideService(Agent.Context, context),
					Effect.forkChild,
				)
				yield* Deferred.await(started)
				assert.equal(returned, false)
				assert.deepEqual(
					yield* storage.getRef(initial.session.id),
					Option.some(initial.session),
				)
				assert.deepEqual(yield* runtimeStore.read(initial.session.id), initial)
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(writing)
				assert.equal(returned, true)
				const observed = yield* Fiber.join(waiting)
				assert.deepEqual(
					Option.some(observed.session),
					yield* storage.getRef(initial.session.id),
				)
				assert.deepEqual(observed.state.value.a, { value: 1 })
				assert.notEqual(observed.session.head, initial.session.head)
			}),
		),
	)
})

test("scoped plugin construction waits until first use, lasts across Turns and keeps runtime resources separate", async () => {
	let constructions = 0
	let services = 0
	let uses: ReadonlyArray<number> = []
	const blocked = Deferred.makeUnsafe<void>()
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
			return (next, options) =>
				Stream.unwrap(
					Effect.gen(function* () {
						uses = EffectArray.append(
							uses,
							yield* Ref.updateAndGet(count, (n) => n + 1),
						)
						return next(options)
					}),
				)
		})
	})
	const combined = PluginComposition.merge(
		plugin,
		Plugin.make({ id: Plugin.Id.make("pass") })(() =>
			Effect.succeed((next, options) => next(options)),
		),
	)
	assert.equal(constructions, 0)
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const parent = yield* Effect.scope
				const firstScope = yield* Scope.fork(parent)
				const secondScope = yield* Scope.fork(parent)
				const first = yield* SessionTest({ plugin: combined }).pipe(
					Scope.provide(firstScope),
				)
				assert.equal(constructions, 1)
				assert.equal(services, 1)
				const done = yield* first.runtime.execute({
					base: first.base,
					input: "one",
				})
				yield* first.runtime
					.stream({
						base: { session: done.session.id, revision: done.session.revision },
						input: "two",
					})
					.pipe(Stream.runDrain)
				assert.equal(services, 1)
				assert.equal(constructions, 1)
				assert.deepEqual(uses, [1, 2])
				const second = yield* SessionTest({ plugin: combined }).pipe(
					Scope.provide(secondScope),
				)
				yield* second.runtime.execute({
					base: second.base,
					input: "independent",
				})
				assert.equal(services, 2)
				assert.deepEqual(uses, [1, 2, 1])
				const current = yield* first.runtimeStore.read(first.base.session)
				const receipt = yield* first.runtime.start({
					base: Session.position(current.session),
					input: "block",
				})
				yield* Deferred.await(blocked)
				yield* first.runtime.interrupt({
					session: receipt.session,
					turn: receipt.turn,
				})
				assert.equal(services, 2)
				yield* Scope.close(firstScope, Exit.succeed(undefined))
				assert.equal(services, 1)
				yield* Scope.close(secondScope, Exit.succeed(undefined))
				assert.equal(services, 0)
			}),
		).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: ({ prompt }) =>
						prompt.content.some(
							(message) =>
								message.role === "user" &&
								message.content.some(
									(part) => part.type === "text" && part.text === "block",
								),
						)
							? Stream.fromEffect(Deferred.succeed(blocked, undefined)).pipe(
									Stream.flatMap(() => Stream.never),
								)
							: Stream.fromArray(textParts("done")),
				}),
			),
		),
	)
	assert.equal(constructions, 2)
	assert.equal(services, 0)
})

test("combined constructors keep onion order and release partly built plugins on failure", async () => {
	let calls: ReadonlyArray<string> = []
	const plugin = (name: string) =>
		Plugin.make({ id: Plugin.Id.make(name) })(() =>
			Effect.gen(function* () {
				yield* Effect.acquireRelease(
					Effect.sync(() => {
						calls = EffectArray.append(calls, "build-" + name)
					}),
					() =>
						Effect.sync(() => {
							calls = EffectArray.append(calls, "release-" + name)
						}),
				)
				return (next, options) =>
					Stream.unwrap(
						Effect.sync(() => {
							calls = EffectArray.append(calls, "enter-" + name)
							return next(options).pipe(
								Stream.ensuring(
									Effect.sync(() => {
										calls = EffectArray.append(calls, "exit-" + name)
									}),
								),
							)
						}),
					)
			}),
		)
	const combined = PluginComposition.merge(plugin("a"), plugin("b"))
	assert.deepEqual(calls, [])
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, base } = yield* SessionTest({ plugin: combined })
				yield* runtime.execute({ base, input: "one" })
			}),
		).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.fromArray(textParts("done")),
				}),
			),
		),
	)
	assert.deepEqual(calls, [
		"build-a",
		"build-b",
		"enter-a",
		"enter-b",
		"exit-b",
		"exit-a",
		"release-b",
		"release-a",
	])
	calls = []
	const failed = Plugin.make({ id: Plugin.Id.make("failed") })(() =>
		Effect.fail("build-failed" as const),
	)
	const result = await Effect.runPromise(
		Effect.scoped(
			SessionTest({ plugin: PluginComposition.merge(plugin("a"), failed) }),
		).pipe(Effect.result),
	)
	assert.equal(result._tag, "Failure")
	assert.deepEqual(calls, ["build-a", "release-a"])
})
