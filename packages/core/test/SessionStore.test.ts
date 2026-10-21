import assert from "node:assert/strict"
import { test } from "node:test"
import { Deferred, Effect, Exit, Fiber, Option, Schema, Stream } from "effect"
import {
	MemoryPersistence,
	TimelineState,
	RecordSerialization,
	SessionStore,
	SessionStoreRepository,
	Store,
} from "@openbot-build/core"
const metadata = { title: "work" }
const definition = Store.define({
	stores: {
		counter: {
			scope: "timeline",
			schema: Schema.Finite,
		},
		goal: {
			scope: "session",
			schema: Schema.String,
		},
	},
	schemaVersion: "timeline/1",
})
const setup = Effect.gen(function* () {
	const declared = yield* definition,
		persistence = yield* MemoryPersistence.make
	const store = yield* SessionStoreRepository.make({
		definition: declared,
		persistence,
	})
	return { declared, persistence, store }
})

test("empty Sessions, metadata, settings and Session business values have independent revisions", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { store } = yield* setup
				const a = yield* store.create({ metadata }),
					b = yield* store.create({ metadata })
				assert.notEqual(a.session.id, b.session.id)
				const renamed = yield* store.updateMetadata({
					expected: a.session,
					metadata: { ...a.session.metadata, title: "renamed", archived: true },
				})
				assert.equal(renamed.head, a.session.head)
				assert.equal(renamed.revision, a.session.revision + 1)
				const current = (yield* store.modifyEffect({
					session: a.session.id,
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({ session: { business: { goal: "source goal" } } }),
						] as const),
				})).view
				assert.equal(current.session.head, a.session.head)
				const changed = yield* store.updateSettings({
					expected: current.session,
					settings: { ...current.session.settings, mode: "plan" },
				})
				assert.equal(changed.session.head, a.session.head)
				const stale = yield* Effect.exit(
					store.updateSettings({
						expected: current.session,
						settings: current.session.settings,
					}),
				)
				assert.ok(Exit.isFailure(stale))
				assert.equal(
					(yield* store.read(b.session.id)).session.settings.mode,
					"default",
				)
				const fork = yield* store.fork({ source: a.session.id })
				assert.deepEqual(fork.session.business, {})
				assert.deepEqual(fork.session.pending, [])
				assert.equal(fork.session.head, a.session.head)
				assert.equal((yield* store.list({ archived: true })).length, 1)
				yield* store.remove(renamed).pipe(Effect.exit)
				yield* store.remove((yield* store.read(a.session.id)).session)
				assert.equal((yield* store.list()).length, 2)
				assert.equal(
					(yield* store.read(fork.session.id)).state.value.conversation.history
						.length,
					0,
				)
			}),
		),
	)
})

test("concurrent atomic Timeline updates, skipped writes and typed callback failures keep committed state", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { store } = yield* setup
				const root = yield* store.create({
					metadata,
					value: TimelineState.initial({ counter: 0 }),
				})
				const fork = yield* store.fork({ source: root.session.id })
				yield* Effect.all(
					Array.from({ length: 12 }, () =>
						store.modifyEffect({
							session: fork.session.id,
							update: (view) =>
								Effect.succeed([
									undefined,
									Option.some({
										value: {
											...view.state.value,
											counter: (view.state.value.counter ?? 0) + 1,
										},
									}),
								] as const),
						}),
					),
					{ concurrency: "unbounded" },
				)
				const current = yield* store.read(fork.session.id)
				assert.equal(current.state.value.counter, 12)
				assert.equal(
					(yield* store.read(root.session.id)).state.value.counter,
					0,
				)
				const before = yield* store.export(fork.session.id)
				assert.equal(
					(yield* store.modifyEffect({
						session: fork.session.id,
						update: () => Effect.succeed(["kept", Option.none()] as const),
					})).result,
					"kept",
				)
				assert.ok(
					Exit.isFailure(
						yield* Effect.exit(
							store.modifyEffect({
								session: fork.session.id,
								update: () => Effect.fail("callback-failed" as const),
							}),
						),
					),
				)
				assert.deepEqual(yield* store.export(fork.session.id), before)
				assert.ok(
					Exit.isFailure(
						yield* Effect.exit(
							store.commit({
								expected: fork.session,
								value: current.state.value,
							}),
						),
					),
				)
				assert.equal(
					(yield* store.log({ from: current.session.head })).length,
					13,
				)
			}),
		),
	)
})

test("the durable save happens before the state is installed and success is published", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { declared, persistence, store: seed } = yield* setup
				const root = yield* seed.create({ metadata })
				const entered = yield* Deferred.make<void>(),
					gate = yield* Deferred.make<void>()
				const store = yield* SessionStoreRepository.make({
					definition: declared,
					persistence,
					onCommit: () =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(gate)),
							Effect.andThen(
								Effect.fail(
									new SessionStore.SessionStoreError({
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
					store.updateMetadata({
						expected: root.session,
						metadata: { ...root.session.metadata, title: "unsaved" },
					}),
				)
				yield* Deferred.await(entered)
				assert.equal(
					(yield* store.read(root.session.id)).session.metadata.title,
					"work",
				)
				assert.equal(notified, false)
				yield* Deferred.succeed(gate, undefined)
				assert.ok(Exit.isFailure(yield* Fiber.await(writing)))
				assert.equal(
					(yield* store.read(root.session.id)).session.revision,
					root.session.revision,
				)
				assert.equal(notified, false)
			}),
		),
	)
})

test("records keep unknown data and reject malformed formats and unreachable versions", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { declared, store } = yield* setup
				const view = yield* store.create({
					metadata,
					value: TimelineState.initial({ unknown: { nested: [1, "value"] } }),
					business: { unknown: { saved: true } },
				})
				const record = yield* store.export(view.session.id),
					codec = RecordSerialization.make<typeof declared.stores>()
				const encoded = yield* codec.encode({ definition: declared, record })
				const decoded = yield* codec.decode({
					definition: declared,
					input: encoded,
				})
				const fresh = yield* SessionStoreRepository.make({
					definition: declared,
					persistence: yield* MemoryPersistence.make,
				})
				const restored = yield* fresh.import({
					record: decoded,
					expected: null,
				})
				assert.deepEqual(restored.state.value["unknown"], {
					nested: [1, "value"],
				})
				assert.deepEqual(restored.session.business["unknown"], { saved: true })
				for (const input of [
					"{",
					JSON.stringify({ ...record, formatVersion: 2 }),
					JSON.stringify({ ...record, versions: [] }),
				])
					assert.ok(
						Exit.isFailure(
							yield* Effect.exit(codec.decode({ definition: declared, input })),
						),
					)
				assert.ok(
					Exit.isFailure(
						yield* Effect.exit(store.import({ record, expected: null })),
					),
				)
				assert.equal((yield* store.get(view.session.id))._tag, "Some")
			}),
		),
	)
})
