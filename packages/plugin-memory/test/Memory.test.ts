// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Exit, Layer, Option, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import {
	Item,
	MemoryPersistence,
	TimelineState,
	RecordSerialization,
	Session,
	SessionStoreRepository,
	Store,
} from "@openbot-build/core"
import {
	Memory,
	MemoryOperations,
	MemoryRules,
} from "@openbot-build/plugin-memory"
const unusedModel = Layer.effect(
	LanguageModel.LanguageModel,
	LanguageModel.make({
		generateText: () => Effect.die("Unexpected generation"),
		streamText: () => Stream.die("Unexpected streaming"),
	}),
)
const setup = Effect.gen(function* () {
	const definition = yield* Store.define({
		schemaVersion: "timeline/1",
		stores: Memory.stores,
	})
	const store = yield* SessionStoreRepository.make({
		definition,
		persistence: yield* MemoryPersistence.make,
	})
	const view = yield* store.create({ metadata: {} })
	return { store, view, definition }
})
const noOutput: typeof Memory.MemoryModel.Service = {
	extract: () => Effect.succeed({ changes: [] }),
}

test("memory edits, retractions, Fork and records keep exact evidence and do not inherit settings", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { store, view, definition } = yield* setup
				const memory = MemoryOperations.make({
					store,
					policy: MemoryRules.policy,
					model: noOutput,
				})
				const first = yield* memory.update(Session.position(view.session), {
					_tag: "Remember",
					key: "language",
					content: "Use English",
					kind: "preference",
				})
				const disabled = yield* memory.update(Session.position(first.session), {
					_tag: "Configure",
					use: false,
					generate: false,
				})
				assert.equal(disabled.session.head, first.session.head)
				assert.ok(disabled.session.revision > first.session.revision)
				const retracted = yield* memory.update(
					Session.position(disabled.session),
					{ _tag: "Forget", key: "language" },
				)
				const fork = yield* store.fork({
					source: view.session.id,
					version: first.session.head,
					settings: { memoryEnabled: true, memoryGenerationEnabled: true },
				})
				assert.equal(
					(yield* memory.read(fork.session.id)).entries["language"]!.status,
					"active",
				)
				assert.equal(
					(yield* memory.read(view.session.id)).entries["language"]!.status,
					"retracted",
				)
				assert.equal(fork.session.settings.memoryEnabled, true)
				assert.equal(retracted.session.settings.memoryEnabled, false)
				assert.equal(
					MemoryRules.policy
						.project(yield* memory.read(fork.session.id))
						.includes("Use English"),
					true,
				)
				const independent = yield* store.create({ metadata: {} })
				assert.equal(
					MemoryRules.policy.project(
						yield* memory.read(independent.session.id),
					),
					"",
				)
				assert.equal(
					MemoryRules.policy.project(yield* memory.read(view.session.id)),
					"",
				)
				const codec = RecordSerialization.make<Memory.States>(),
					record = yield* store.export(fork.session.id)
				const decoded = yield* codec.decode({
					definition,
					input: yield* codec.encode({ definition, record }),
				})
				const fresh = yield* SessionStoreRepository.make({
					definition,
					persistence: yield* MemoryPersistence.make,
				})
				const restored = yield* fresh.import({
					record: decoded,
					expected: null,
				})
				assert.deepEqual(
					restored.state.value[Memory.pluginId],
					fork.state.value[Memory.pluginId],
				)
				assert.ok(
					Exit.isFailure(
						yield* Effect.exit(
							memory.update(Session.position(first.session), {
								_tag: "Remember",
								key: "stale",
								content: "stale",
								kind: "fact",
							}),
						),
					),
				)
			}),
		).pipe(Effect.provide(unusedModel)),
	)
})

test("extraction of new history checks source IDs, and failures keep progress unchanged", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { store, view } = yield* setup
				const evidence = Item.Id.make("evidence")
				const supplied = (yield* store.modifyEffect({
					session: view.session.id,
					update: (current) =>
						Effect.succeed([
							undefined,
							Option.some({
								value: {
									...current.state.value,
									conversation: {
										...current.state.value.conversation,
										history: [
											{ id: evidence, content: Prompt.make("a durable fact") },
										],
									},
								},
							}),
						] as const),
				})).view
				let requests = 0
				const memory = MemoryOperations.make({
					store,
					policy: MemoryRules.policy,
					model: {
						extract: ({ history }) =>
							Effect.sync(() => {
								requests++
								assert.deepEqual(
									history.map((entry) => entry.id),
									[evidence],
								)
								return {
									changes: [
										{
											key: "fact",
											content: "a durable fact",
											kind: "fact" as const,
											sources: [evidence],
											status: "active" as const,
										},
									],
								}
							}),
					},
				})
				const learned = yield* memory.consolidate(view.session.id)
				assert.equal(requests, 1)
				assert.deepEqual((yield* memory.read(view.session.id)).processed, [
					evidence,
				])
				assert.equal(
					(yield* memory.consolidate(view.session.id)).session.head,
					learned.session.head,
				)
				assert.equal(requests, 1)
				const edited = yield* memory.update(Session.position(learned.session), {
					_tag: "Forget",
					key: "fact",
				})
				const retried = yield* MemoryRules.policy.apply({
					state: yield* memory.read(view.session.id),
					history: supplied.state.value.conversation.history,
					changes: [
						{
							key: "fact",
							content: "obsolete evidence",
							kind: "fact",
							sources: [evidence],
							status: "active",
						},
					],
					now: Date.now(),
				})
				assert.equal(retried.entries["fact"]!.status, "retracted")
				const added = (yield* store.modifyEffect({
					session: view.session.id,
					update: (current) =>
						Effect.succeed([
							undefined,
							Option.some({
								value: {
									...current.state.value,
									conversation: {
										...current.state.value.conversation,
										history: [
											...current.state.value.conversation.history,
											{
												id: Item.Id.make("new"),
												content: Prompt.make("new input"),
											},
										],
									},
								},
							}),
						] as const),
				})).view
				for (const extractor of [
					() =>
						Effect.fail(
							new Memory.MemoryError({
								reason: "model-failed",
								message: "failed",
							}),
						),
					() =>
						Effect.succeed({
							changes: [
								{
									key: "invalid",
									content: "unavailable",
									kind: "fact" as const,
									sources: [Item.Id.make("missing")],
									status: "active" as const,
								},
							],
						}),
				]) {
					const invalid = MemoryOperations.make({
						store,
						policy: MemoryRules.policy,
						model: { extract: extractor },
					})
					assert.ok(
						Exit.isFailure(
							yield* Effect.exit(invalid.consolidate(view.session.id)),
						),
					)
					assert.equal(
						(yield* store.read(view.session.id)).session.head,
						added.session.head,
					)
					assert.deepEqual(
						(yield* memory.read(view.session.id)).processed,
						edited.state.value["@openbot-build/plugin-memory"]!.processed,
					)
				}
			}),
		).pipe(Effect.provide(unusedModel)),
	)
})

test("disabling generation only changes Session settings and never runs extraction on Fork", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { store, view } = yield* setup
				const memory = MemoryOperations.make({
					store,
					policy: MemoryRules.policy,
					model: {
						extract: () => Effect.die("Disabled extraction must not run"),
					},
				})
				const configured = yield* memory.update(
					Session.position(view.session),
					{ _tag: "Configure", use: true, generate: false },
				)
				assert.deepEqual(configured.state, view.state)
				assert.equal(
					(yield* memory.consolidate(view.session.id)).session.head,
					view.session.head,
				)
				const fork = yield* store.fork({ source: view.session.id })
				assert.equal(fork.session.settings.memoryGenerationEnabled, false)
				assert.deepEqual(fork.state.value, TimelineState.initial({}))
			}),
		).pipe(Effect.provide(unusedModel)),
	)
})
