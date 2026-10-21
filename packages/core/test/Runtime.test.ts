import { Item } from "@openbot-build/core"
import { SessionStoreRepository, MemoryPersistence } from "@openbot-build/core"
import {
	Array as EffectArray,
	Order,
	Effect,
	Exit,
	Layer,
	Option,
	Schema,
	Stream,
	Predicate,
} from "effect"
import * as TimelineState from "../src/timeline/TimelineState.ts"
import * as RecordSerialization from "../src/store/RecordSerialization.ts"
import * as Store from "../src/store/Store.ts"
// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"

import { LanguageModel, Prompt, Response } from "effect/ai"
import * as Session from "../src/session/Session.ts"
import * as SessionRuntime from "../src/session/SessionRuntime.ts"
import * as SessionStoreMemory from "../src/store/SessionStoreMemory.ts"

const setup = Effect.gen(function* () {
	const definition = yield* Store.define({
		stores: {},
		schemaVersion: "timeline/1",
	})
	const runtimeStore = yield* SessionStoreRepository.make({
		definition: definition,
		persistence: yield* MemoryPersistence.make,
	})
	const runtime = yield* SessionRuntime.make({ store: runtimeStore, agent: {} })
	const view = yield* runtimeStore.create({
		metadata: {},
		value: TimelineState.initial({}),
	})
	return { definition, runtime, runtimeStore, view }
})

test("store compare-and-set includes metadata and rejects conflicts with immutable versions in one step", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { definition, runtimeStore, view } = yield* setup
				const store = yield* SessionStoreMemory.make(definition)
				const before = yield* runtimeStore.export(view.session.id)
				yield* store.import({ record: before, expected: null })
				yield* runtimeStore.read(view.session.id).pipe(
					Effect.flatMap((current) =>
						runtimeStore.updateMetadata({
							expected: current.session,
							metadata: { ...current.session.metadata, title: "new" },
						}),
					),
				)
				const renamed = yield* runtimeStore.export(view.session.id)
				yield* store.import({ record: renamed, expected: before.session })
				const stale = yield* Effect.exit(
					store.import({ record: before, expected: before.session }),
				)
				assert.equal(Exit.isFailure(stale), true)
				const conflict = {
					...renamed,
					versions: renamed.versions.map((v) => ({
						...v,
						schemaVersion: "different",
					})),
				}
				assert.equal(
					Exit.isFailure(
						yield* Effect.exit(
							store.import({ record: conflict, expected: renamed.session }),
						),
					),
					true,
				)
				const loaded = yield* store.read(view.session.id)
				assert.equal(loaded.session.metadata.title, "new")
				assert.equal(
					Option.getOrThrow(yield* store.getVersion(before.session.head))
						.schemaVersion,
					"timeline/1",
				)
				yield* store.remove(loaded.session)
				assert.equal(Option.isNone(yield* store.get(view.session.id)), true)
				assert.equal(
					Option.isSome(yield* store.getVersion(before.session.head)),
					true,
				)
			}),
		),
	)
})
test("media and unknown namespaces round-trip with the same runtime and encoded layout", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { definition, runtimeStore, view } = yield* setup
				const prompt = Prompt.make([
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
				yield* runtimeStore
					.modifyEffect({
						session: view.session.id,
						update: (current) =>
							Effect.gen(function* () {
								return [
									undefined,
									Option.some({
										value: ((value: typeof current.state.value) => ({
											...value,
											future: { tokens: 4, encrypted: "secret" },
											conversation: {
												...value.conversation,
												history: [
													{
														id: Item.Record.fields.id.make("media"),
														content: prompt,
													},
												],
												context: { _tag: "Prompt", prompt },
											},
										}))(current.state.value),
									}),
								] as const
							}),
					})
					.pipe(Effect.map(({ view }) => view))
				const codec = RecordSerialization.make<{}>(),
					record = yield* runtimeStore.export(view.session.id)
				const restored = yield* codec.materialize({
					definition,
					record: yield* codec.decode({
						definition,
						input: yield* codec.encode({ definition, record }),
					}),
				})
				assert.deepEqual(
					restored.value.conversation.history[0]!.content,
					prompt,
				)
				assert.deepEqual(restored.value["future"], {
					tokens: 4,
					encrypted: "secret",
				})
				const json = yield* Schema.encodeEffect(definition.schema)(
					restored.value,
				)
				assert.deepEqual(
					EffectArray.sort(
						Object.keys(json as Schema.JsonObject),
						Order.String,
					),
					["conversation", "future"],
				)
				assert.deepEqual(
					EffectArray.sort(Object.keys(restored.value), Order.String),
					["conversation", "future"],
				)
				assert.equal(
					Object.hasOwn(record.versions.at(-1)!.value, "history"),
					false,
				)
				assert.equal(
					Object.hasOwn(
						record.versions.at(-1)!.value["conversation"] as object,
						"history",
					),
					false,
				)
				assert.ok(
					Exit.isFailure(
						yield* Effect.exit(
							Schema.decodeUnknownEffect(definition.schema)({
								...TimelineState.initial({}).conversation,
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

const LanguageModelTest = (onRequest: (prompt: Prompt.Prompt) => void) =>
	Layer.effect(
		LanguageModel.LanguageModel,
		LanguageModel.make({
			generateText: () => Effect.succeed([]),
			streamText: (options) =>
				Stream.suspend(() => {
					onRequest(options.prompt)
					return Stream.fromArray([
						Response.makePart("text-start", { id: "text" }),
						Response.makePart("text-delta", { id: "text", delta: "answer" }),
						Response.makePart("text-end", { id: "text" }),
						Response.makePart("finish", {
							reason: "stop",
							usage: Response.Usage.make({
								inputTokens: {
									total: 1,
									uncached: 1,
									cacheRead: undefined,
									cacheWrite: undefined,
								},
								outputTokens: { total: 1, text: 1, reasoning: undefined },
							}),
						}),
					])
				}),
		}),
	)

test("execute commits the input and the completed turn, and a stale head fails before any model call", async () => {
	let calls = 0
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, view } = yield* setup
				const input = {
					base: { session: view.session.id, revision: view.session.revision },
					input: "hello",
				}
				const result = yield* runtime.execute(input)
				assert.equal(Session.status(result.session)._tag, "Completed")
				assert.equal(Session.currentTurn(result.session)!.steps, 1)
				assert.equal(result.state.value.conversation.history.length, 2)
				assert.equal(
					(yield* runtimeStore.export(view.session.id)).versions.length,
					3,
				)
				const failure = yield* Effect.exit(runtime.execute(input))
				assert.equal(Exit.isFailure(failure), true)
				assert.equal(calls, 1)
			}),
		).pipe(
			Effect.provide(
				LanguageModelTest(() => {
					calls++
				}),
			),
		),
	)
})

test("serialization tells apart invalid JSON, unsupported formats and corrupt graphs, and restores no partial state", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { definition, runtimeStore, view } = yield* setup
				const codec = RecordSerialization.make<{}>()
				const record = yield* runtimeStore.export(view.session.id)
				const version = record.versions[0]!
				const freshStore = yield* SessionStoreRepository.make({
					definition: definition,
					persistence: yield* MemoryPersistence.make,
				})

				const cases = [
					{ input: "{", reason: "invalid-json" },
					{
						input: JSON.stringify({ ...record, formatVersion: 99 }),
						reason: "unsupported-format",
					},
					{
						input: JSON.stringify({
							...record,
							session: { ...record.session, head: "missing" },
						}),
						reason: "reference-invalid",
					},
					{
						input: JSON.stringify({ ...record, versions: [version, version] }),
						reason: "version-conflict",
					},
					{
						input: JSON.stringify({
							...record,
							versions: [{ ...version, parents: ["missing"] }],
						}),
						reason: "parent-missing",
					},
					{
						input: JSON.stringify({
							...record,
							versions: [{ ...version, parents: [version.id] }],
						}),
						reason: "version-cycle",
					},
					{
						input: JSON.stringify({
							...record,
							versions: [
								{ ...version, parents: [version.id, version.id, version.id] },
							],
						}),
						reason: "decode-failed",
					},
					{
						input: JSON.stringify({
							...record,
							versions: [{ ...version, schemaVersion: "session/unknown" }],
						}),
						reason: "unsupported-format",
					},
				]
				for (const scenario of cases) {
					const error = yield* codec
						.decode({ definition, input: scenario.input })
						.pipe(Effect.flip)
					assert.equal(error.reason, scenario.reason)
				}
				const broken = {
					...record,
					versions: [{ ...version, parents: [version.id] as const }],
				}
				const error = yield* freshStore
					.import({ record: broken, expected: null })
					.pipe(Effect.flip)
				assert.ok(Predicate.hasProperty(error, "reason"))
				assert.equal(error.reason, "version-cycle")
				assert.deepEqual(yield* freshStore.list(), [])
				assert.deepEqual(yield* runtimeStore.read(view.session.id), view)
			}),
		),
	)
})
