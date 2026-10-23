import { Timeline } from "@openbot-build/core"
import { Item } from "@openbot-build/core"
import { Option } from "effect"
import { SessionStoreRepository } from "@openbot-build/core"
import {
	Array as EffectArray,
	HashMap,
	Effect,
	Exit,
	Schema,
	Deferred,
	Fiber,
	Stream,
} from "effect"
import * as TimelineState from "../src/timeline/TimelineState.ts"
import * as MemoryPersistence from "../src/store/MemoryPersistence.ts"
import * as RecordSerialization from "../src/store/RecordSerialization.ts"
import * as Store from "../src/store/Store.ts"
import * as VersionGraph from "../src/store/VersionGraph.ts"
import { batches } from "../src/store/GraphTraversal.ts"

import assert from "node:assert/strict"
import { test } from "node:test"

import { Prompt, LanguageModel } from "effect/ai"
import { Session, SessionRuntime, SessionStore } from "../src/index.ts"

test("host commits happen before Timeline changes, and hydration has no side effects", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* Store.define({
					stores: {},
					schemaVersion: "timeline/1",
				})
				let fail = true
				let saved = 0
				const persist = Effect.suspend(() =>
					fail
						? Effect.fail(
								new SessionStore.SessionStoreError({
									reason: "storage-failed",
									message: "fixture",
								}),
							)
						: Effect.sync(() => {
								saved++
							}),
				)
				const persistence = yield* MemoryPersistence.make
				const runtimeStore = yield* SessionStoreRepository.make({
					definition,
					persistence,
					onCommit: ({ delta }) =>
						persist.pipe(Effect.andThen(persistence.save(delta))),
					onRemove: (ref) =>
						persist.pipe(Effect.andThen(persistence.remove(ref))),
				})

				const input = {
					metadata: {},
					value: TimelineState.initial({}),
				}
				assert.ok(
					Exit.isFailure(yield* Effect.exit(runtimeStore.create(input))),
				)
				assert.equal((yield* runtimeStore.list()).length, 0)
				fail = false
				const view = yield* runtimeStore.create(input)
				assert.equal(saved, 1)
				fail = true
				for (const operation of [
					runtimeStore.read(view.session.id).pipe(
						Effect.flatMap((current) =>
							runtimeStore.updateMetadata({
								expected: current.session,
								metadata: { ...current.session.metadata, title: "changed" },
							}),
						),
					),
					runtimeStore.read(view.session.id).pipe(
						Effect.flatMap((current) =>
							runtimeStore.updateMetadata({
								expected: current.session,
								metadata: { ...current.session.metadata, archived: true },
							}),
						),
					),
					runtimeStore
						.fork({
							source: view.session.id,
							version: view.session.head,
							metadata: input.metadata,
						})
						.pipe(Effect.map((view) => view.session)),
					runtimeStore
						.modifyEffect({
							session: view.session.id,
							update: (current) =>
								Effect.gen(function* () {
									return [
										undefined,
										Option.some({
											value: ((value: typeof current.state.value) => ({
												...value,
												conversation: {
													...value.conversation,
													mode: "plan",
												},
											}))(current.state.value),
										}),
									] as const
								}),
						})
						.pipe(Effect.map(({ view }) => view)),
					runtimeStore
						.read(view.session.id)
						.pipe(
							Effect.flatMap((current) => runtimeStore.remove(current.session)),
						),
				] satisfies ReadonlyArray<
					Effect.Effect<
						unknown,
						| Session.SessionNotFound
						| Timeline.VersionError
						| SessionStore.SessionStoreError
					>
				>)
					assert.ok(
						Exit.isFailure(
							yield* Effect.exit<
								unknown,
								| Session.SessionNotFound
								| Timeline.VersionError
								| SessionStore.SessionStoreError,
								never
							>(operation),
						),
					)
				assert.deepEqual(yield* runtimeStore.read(view.session.id), view)
				assert.equal((yield* runtimeStore.list()).length, 1)
				const record = yield* runtimeStore.export(view.session.id)
				const freshPersistence = yield* MemoryPersistence.make
				const freshStore = yield* SessionStoreRepository.make({
					definition,
					persistence: freshPersistence,
				})
				const durableStore = yield* SessionStoreRepository.make({
					definition,
					persistence: freshPersistence,
					onCommit: () => persist,
				})

				const restored = yield* freshStore.import({
					record: record,
					expected: null,
				})
				assert.deepEqual(restored.session, view.session)
				assert.deepEqual(yield* freshStore.export(view.session.id), record)
				assert.equal(saved, 1)
				assert.ok(
					Exit.isFailure(
						yield* Effect.exit(
							durableStore.import({ record: record, expected: view.session }),
						),
					),
				)
				assert.deepEqual(yield* freshStore.read(view.session.id), restored)
			}),
		),
	)
})

test("construction and listing read no snapshots, commits save only changes, and historical state stays bounded", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* Store.define({
					stores: {},
					schemaVersion: "timeline/1",
				})
				const base = yield* MemoryPersistence.make
				let reads: ReadonlyArray<Timeline.VersionId> = [],
					saves: ReadonlyArray<SessionStore.Delta> = []
				let reject = false
				const storage: SessionStore.Persistence = {
					...base,
					snapshot: (id) =>
						Effect.gen(function* () {
							reads = EffectArray.append(reads, id)
							if (reject)
								return yield* new SessionStore.SessionStoreError({
									reason: "storage-failed",
									message: "Fixture unavailable",
								})
							return yield* base.snapshot(id)
						}),
					save: (delta) =>
						Effect.gen(function* () {
							saves = EffectArray.append(saves, delta)
							yield* base.save(delta)
						}),
				}
				const runtimeStore = yield* SessionStoreRepository.make({
					definition: definition,
					persistence: storage,
				})

				assert.deepEqual(reads, [])
				const initial = yield* runtimeStore.create({
					metadata: {},
					value: TimelineState.initial({}),
				})
				let refs = [initial.session]
				for (let index = 0; index < 70; index++)
					refs = EffectArray.append(
						refs,
						(yield* runtimeStore.create({
							metadata: initial.session.metadata,
							value: TimelineState.initial({}),
						})).session,
					)
				assert.equal((yield* runtimeStore.list()).length, 71)
				assert.deepEqual(reads, [])
				yield* runtimeStore.read(initial.session.id)
				assert.deepEqual(reads, [initial.session.head])
				for (const ref of refs.slice(1)) yield* runtimeStore.read(ref.id)
				reads = []
				yield* runtimeStore.read(initial.session.id)
				assert.deepEqual(reads, [initial.session.head])
				reads = []
				saves = []
				const next = yield* runtimeStore
					.modifyEffect({
						session: initial.session.id,
						update: (current) =>
							Effect.gen(function* () {
								return [
									undefined,
									Option.some({
										value: ((value: typeof current.state.value) => ({
											...value,
											conversation: {
												...value.conversation,
												mode: "plan",
											},
										}))(current.state.value),
									}),
								] as const
							}),
					})
					.pipe(Effect.map(({ view }) => view))
				assert.equal(saves.length, 1)
				assert.equal(saves[0]!.versions.length, 1)
				assert.equal(saves[0]!.messages.length, 0)
				assert.equal(Object.hasOwn(saves[0]!, "record"), false)
				assert.deepEqual(reads, [])
				const freshStore = yield* SessionStoreRepository.make({
					definition: definition,
					persistence: storage,
				})

				assert.deepEqual(reads, [])
				reject = true
				assert.ok(
					Exit.isFailure(
						yield* Effect.exit(freshStore.read(initial.session.id)),
					),
				)
				reject = false
				assert.equal(
					(yield* freshStore.read(initial.session.id)).session.head,
					next.session.head,
				)
				reads = []
				assert.equal(
					(yield* freshStore.read(initial.session.id, initial.session.head))
						.value.conversation.closed,
					true,
				)
				assert.deepEqual(reads, [initial.session.head])
			}),
		),
	)
})

test("content revisions share identity and keep old bodies, without merging distinct messages", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* Store.define({
					stores: {},
					schemaVersion: "timeline/1",
				})
				const storage = yield* MemoryPersistence.make
				const runtimeStore = yield* SessionStoreRepository.make({
					definition: definition,
					persistence: storage,
				})

				const firstId = Item.Id.make("first"),
					secondId = Item.Id.make("second")
				const content = Prompt.make("shared text")
				const created = yield* runtimeStore.create({
					metadata: {},
					value: {
						...TimelineState.initial({}),
						conversation: {
							...TimelineState.initial({}).conversation,
							history: [{ id: firstId, content }],
						},
					},
				})
				const first = yield* runtimeStore.export(created.session.id)
				yield* runtimeStore
					.modifyEffect({
						session: created.session.id,
						update: (current) =>
							Effect.gen(function* () {
								return [
									undefined,
									Option.some({
										value: ((value: typeof current.state.value) => ({
											...value,
											conversation: {
												...value.conversation,
												mode: "plan",
											},
										}))(current.state.value),
									}),
								] as const
							}),
					})
					.pipe(Effect.map(({ view }) => view))
				assert.equal(
					(yield* runtimeStore.export(created.session.id)).messages.length,
					1,
				)
				yield* runtimeStore
					.modifyEffect({
						session: created.session.id,
						update: (current) =>
							Effect.gen(function* () {
								return [
									undefined,
									Option.some({
										value: ((value: typeof current.state.value) => ({
											...value,
											conversation: {
												...value.conversation,
												history: [
													...value.conversation.history,
													{ id: secondId, content },
												],
											},
										}))(current.state.value),
									}),
								] as const
							}),
					})
					.pipe(Effect.map(({ view }) => view))
				const duplicate = yield* runtimeStore.export(created.session.id)
				assert.equal(duplicate.messages.length, 2)
				assert.notEqual(duplicate.messages[0]!.id, duplicate.messages[1]!.id)
				yield* runtimeStore
					.modifyEffect({
						session: created.session.id,
						update: (current) =>
							Effect.gen(function* () {
								return [
									undefined,
									Option.some({
										value: ((value: typeof current.state.value) => ({
											...value,
											conversation: {
												...value.conversation,
												history: value.conversation.history.map((entry) =>
													entry.id === firstId
														? {
																...entry,
																content: Prompt.concat(
																	entry.content,
																	Prompt.make([
																		{ role: "assistant", content: "result" },
																	]),
																),
															}
														: entry,
												),
											},
										}))(current.state.value),
									}),
								] as const
							}),
					})
					.pipe(Effect.map(({ view }) => view))
				const revised = yield* runtimeStore.export(created.session.id)
				assert.equal(revised.messages.length, 3)
				assert.deepEqual(
					(yield* runtimeStore.read(created.session.id, created.session.head))
						.value.conversation.history[0]!.content,
					content,
				)
				assert.deepEqual(
					yield* RecordSerialization.original(first),
					yield* RecordSerialization.original(revised, created.session.head),
				)
				const renamed = {
					...revised,
					messages: revised.messages.map((m) => ({
						...m,
						id: `import-${m.id}`,
					})),
					versions: revised.versions.map((v) => ({
						...v,
						history: v.history.map((ref) => ({
							...ref,
							content: `import-${ref.content}`,
						})),
					})),
				}
				yield* storage.save({ ...renamed, expected: revised.session })
				assert.deepEqual(
					yield* runtimeStore.export(created.session.id),
					revised,
				)
				const foreign = yield* runtimeStore.create({
					metadata: created.session.metadata,
					value: {
						...TimelineState.initial({}),
						conversation: {
							...TimelineState.initial({}).conversation,
							history: [
								{
									id: Item.Id.make("foreign"),
									content: Prompt.make("foreign body"),
								},
							],
						},
					},
				})
				const foreignContent = (yield* runtimeStore.export(foreign.session.id))
					.messages[0]!.id
				const originalContent = revised.messages[0]!.id
				const conflicting = {
					...revised,
					messages: revised.messages.map((m) =>
						m.id === originalContent ? { ...m, id: foreignContent } : m,
					),
					versions: revised.versions.map((v) => ({
						...v,
						history: v.history.map((ref) =>
							ref.content === originalContent
								? { ...ref, content: foreignContent }
								: ref,
						),
					})),
				}
				assert.equal(
					(yield* storage
						.save({ ...conflicting, expected: revised.session })
						.pipe(Effect.flip)).reason,
					"message-conflict",
				)

				const incomplete = { ...revised, messages: [] }
				const empty = yield* MemoryPersistence.make
				assert.equal(
					(yield* empty
						.save({ ...incomplete, expected: null })
						.pipe(Effect.flip)).reason,
					"message-missing",
				)
				assert.ok(Option.isNone(yield* empty.getRef(created.session.id)))
				const encoded = yield* Schema.encodeEffect(
					Schema.fromJsonString(SessionStore.Record),
				)(revised)
				assert.equal(JSON.parse(encoded).formatVersion, 3)
			}),
		),
	)
})

test("interruption before durable commit does not publish a reference or snapshot", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* Store.define({
					stores: {},
					schemaVersion: "timeline/1",
				})
				const storage = yield* MemoryPersistence.make
				const entered = yield* Deferred.make<void>(),
					release = yield* Deferred.make<void>()
				const runtimeStore = yield* SessionStoreRepository.make({
					definition: definition,
					persistence: storage,
					onCommit: ({ delta }) =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.andThen(storage.save(delta)),
						),
				})

				const fiber = yield* Effect.forkChild(
					runtimeStore.create({
						metadata: {},
						value: TimelineState.initial({}),
					}),
				)
				yield* Deferred.await(entered)
				yield* Fiber.interrupt(fiber)
				assert.deepEqual(yield* runtimeStore.list(), [])
			}),
		),
	)
})

test("cache eviction keeps active execution and scoped interruption working", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* Store.define({
					stores: {},
					schemaVersion: "timeline/1",
				})
				const storage = yield* MemoryPersistence.make
				const runtimeStore = yield* SessionStoreRepository.make({
					definition: definition,
					persistence: storage,
				})
				const runtime = yield* SessionRuntime.make({
					store: runtimeStore,
					bot: {},
				})
				const entered = yield* Deferred.make<void>()
				const model = yield* LanguageModel.make({
					generateText: () => Effect.succeed([]),
					streamText: () =>
						Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
							Stream.flatMap(() => Stream.never),
						),
				})
				const first = yield* runtimeStore.create({
					metadata: {},
					value: TimelineState.initial({}),
				})
				const fiber = yield* Effect.forkChild(
					runtime
						.stream({
							base: {
								session: first.session.id,
								revision: first.session.revision,
							},
							input: "work",
						})
						.pipe(
							Stream.runDrain,
							Effect.provideService(LanguageModel.LanguageModel, model),
						),
				)
				yield* Deferred.await(entered)
				for (let index = 0; index < 70; index++) {
					const other = yield* runtimeStore.create({
						metadata: first.session.metadata,
						value: TimelineState.initial({}),
					})
					yield* runtimeStore.read(other.session.id)
				}
				assert.equal(yield* runtime.isActive(first.session.id), true)
				assert.equal(
					Session.status((yield* runtimeStore.read(first.session.id)).session)
						._tag,
					"Running",
				)
				yield* Fiber.interrupt(fiber)
				assert.equal(
					Session.status((yield* runtimeStore.read(first.session.id)).session)
						._tag,
					"Interrupted",
				)
				assert.equal(yield* runtime.isActive(first.session.id), false)
			}),
		),
	)
})

test("recursive storage reads keep batch boundaries and walk deep ancestry", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			let calls: ReadonlyArray<ReadonlyArray<number>> = []
			const ids = EffectArray.range(0, 400)
			const read = (batch: ReadonlyArray<number>) =>
				Effect.sync(() => {
					calls = EffectArray.append(calls, batch)
					return batch
				})
			assert.deepEqual(yield* batches([], read), [])
			assert.equal(calls.length, 0)
			assert.deepEqual(yield* batches(ids, read), ids)
			assert.deepEqual(
				calls.map((batch) => batch.length),
				[200, 200, 1],
			)

			const base = yield* MemoryPersistence.make
			const depth = 12000
			let reads = 0
			const storage: SessionStore.Persistence = {
				...base,
				headers: (ids) =>
					Effect.sync(() => {
						reads++
						return ids.map((id): Timeline.Version => ({
							id,
							schemaVersion: "timeline/1",
							parents:
								Number(id) === 0
									? []
									: [Timeline.VersionId.make(String(Number(id) - 1))],
						}))
					}),
			}
			const head = Timeline.VersionId.make(String(depth - 1))
			const graph = yield* VersionGraph.graph(storage, head)
			assert.equal(HashMap.size(graph), depth)
			assert.equal(reads, depth)
			assert.deepEqual(
				HashMap.getUnsafe(graph, Timeline.VersionId.make("0")).parents,
				[],
			)
		}),
	)
})
