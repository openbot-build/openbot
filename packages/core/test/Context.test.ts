import { Item } from "@openbot-build/core"
import { SessionStoreRepository, MemoryPersistence } from "@openbot-build/core"
import {
	Array as EffectArray,
	Match,
	Effect,
	Deferred,
	Fiber,
	Layer,
	Option,
	Stream,
	Predicate,
} from "effect"
import { RecordSerialization } from "@openbot-build/core"
// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"

import { Prompt, Response, Toolkit } from "effect/ai"
import {
	SessionRuntime,
	Config,
	ContextCompaction,
	ContextWindow,
	ConversationContextOperations,
	Model,
	Provider,
} from "@openbot-build/core"
import { SessionTest } from "./SessionTest.ts"
import { ContextCompactionTest } from "./ContextCompactionTest.ts"
import { finish, LanguageModelTest, textParts } from "./LanguageModelTest.ts"

const provider = Provider.Id.make("openai"),
	model = Model.Id.make("model")
const selection = Config.Selection.make({ provider, model })
const catalog = Config.Model.make({
	provider,
	id: model,
	name: "Model",
	reasoningEfforts: [],
	serviceTiers: [],
	contextWindow: 100,
	compaction: Config.Compaction.Native(),
})
const request = {
	instructions: Prompt.make([{ role: "system", content: "instructions" }]),
	toolkit: Toolkit.empty,
}
const selected = (
	runtimeStore: import("@openbot-build/core").SessionStore.Store,
	session: import("@openbot-build/core").Session.Id,
) =>
	runtimeStore
		.modifyEffect({
			session,
			update: (current) =>
				Effect.succeed([
					undefined,
					Option.some({
						value: {
							...current.state.value,
							conversation: {
								...current.state.value.conversation,
								history: [
									{
										id: Item.Id.make("history"),
										content: Prompt.make("whole history"),
									},
								],
								context: ContextWindow.fromPrompt("whole history"),
							},
						},
						session: {
							settings: { ...current.session.settings, model: selection },
						},
					}),
				] as const),
		})
		.pipe(Effect.map(({ view }) => view))

test("explicit compaction keeps complete opaque items and full history after a restore", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const test = ContextCompactionTest()
				const { runtime, runtimeStore, view, definition } = yield* SessionTest({
					compaction: test.service,
					modelCatalog: Effect.succeed([catalog]),
				})
				const before = yield* selected(runtimeStore, view.session.id)
				const service = ConversationContextOperations.make({
					store: runtimeStore,
					runtime,
					session: view.session.id,
					request,
				})
				const result = yield* service.compact({ targetTokens: 20 })
				assert.ok(Option.isNone(result.summary))
				assert.equal(result.afterTokens, 10)
				assert.equal(test.compactions, 1)
				const compacted = yield* runtimeStore.read(view.session.id)
				assert.deepEqual(
					compacted.state.value.conversation.history,
					before.state.value.conversation.history,
				)
				assert.deepEqual(compacted.state.version.parents, [before.session.head])
				assert.equal(compacted.state.value.conversation.context._tag, "Native")
				const freshStore = yield* SessionStoreRepository.make({
					definition: definition,
					persistence: yield* MemoryPersistence.make,
				})
				const fresh = yield* SessionRuntime.make({
					store: freshStore,
					agent: { compaction: test.service },
				})
				const codec = RecordSerialization.make<{}>()
				const record = yield* runtimeStore.export(view.session.id)
				const restored = yield* freshStore.import({
					record: yield* codec.decode({
						definition,
						input: yield* codec.encode({ definition, record }),
					}),
					expected: null,
				})
				assert.deepEqual(
					restored.state.value.conversation.context,
					compacted.state.value.conversation.context,
				)
				const continued = yield* fresh.execute({
					base: {
						session: restored.session.id,
						revision: restored.session.revision,
					},
					input: "continue",
				})
				assert.equal(continued.state.value.conversation.context._tag, "Native")
				assert.match(
					JSON.stringify(continued.state.value.conversation.history),
					/whole history|continue/,
				)
				const load = yield* service.load({ additional: "tail" })
				assert.equal(load.window._tag, "Native")
				assert.equal(load.estimatedTokens, 10)
			}),
		).pipe(
			Effect.provide(
				Layer.merge(
					LanguageModelTest({
						streamText: () => Stream.fromArray(textParts("answer")),
					}),
					Layer.succeed(
						ContextCompaction.ContextCompaction,
						ContextCompactionTest().service,
					),
				),
			),
		),
	)
})

test("invalid targets, large input, provider failure and a missed target never commit or repeat compaction", async () => {
	const cases = [
		{ options: {}, target: 0, reason: "invalid-target", calls: 0 },
		{
			options: { before: 101 },
			target: 50,
			reason: "input-too-large",
			calls: 0,
		},
		{
			options: { after: 60 },
			target: 50,
			reason: "target-not-reached",
			calls: 1,
		},
		{
			options: {
				compact: () =>
					Effect.fail(
						new ContextCompaction.ContextCompactionError({
							reason: "request-failed",
							message: "failed",
						}),
					),
			},
			target: 50,
			reason: "request-failed",
			calls: 1,
		},
	] as const
	for (const entry of cases)
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const test = ContextCompactionTest(entry.options)
					const { runtime, runtimeStore, view } = yield* SessionTest({
						compaction: test.service,
						modelCatalog: Effect.succeed([catalog]),
					})
					const before = yield* selected(runtimeStore, view.session.id)
					const error = yield* runtime
						.compact({
							session: view.session.id,
							targetTokens: entry.target,
							request,
						})
						.pipe(Effect.flip)
					assert.ok(Predicate.hasProperty(error, "reason"))
					assert.equal(error.reason, entry.reason)
					assert.equal(test.compactions, entry.calls)
					assert.deepEqual(yield* runtimeStore.read(view.session.id), before)
				}),
			),
		)
})

test("compaction uses compare-and-set on the head after network work and rejects a competing update", async () => {
	const start = Deferred.makeUnsafe<void>(),
		finish = Deferred.makeUnsafe<void>()
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const test = ContextCompactionTest({
					compact: (r) =>
						Deferred.succeed(start, undefined).pipe(
							Effect.andThen(Deferred.await(finish)),
							Effect.as({
								_tag: "Native" as const,
								provider: r.selection.provider,
								model: r.selection.model,
								items: [],
								prompt: Prompt.empty,
							}),
						),
				})
				const { runtime, runtimeStore, view } = yield* SessionTest({
					compaction: test.service,
					modelCatalog: Effect.succeed([catalog]),
				})
				yield* selected(runtimeStore, view.session.id)
				const fiber = yield* Effect.forkChild(
					runtime
						.compact({ session: view.session.id, targetTokens: 20, request })
						.pipe(Effect.flip),
				)
				yield* Deferred.await(start)
				const changed = yield* runtimeStore
					.modifyEffect({
						session: view.session.id,
						update: (current) =>
							Effect.gen(function* () {
								return [
									undefined,
									Option.some({
										value: ((v: typeof current.state.value) => ({
											...v,
											conversation: {
												...v.conversation,
												context: ContextWindow.append(
													v.conversation.context,
													"competing Timeline edit",
												),
											},
										}))(current.state.value),
									}),
								] as const
							}),
					})
					.pipe(Effect.map(({ view }) => view))
				yield* Deferred.succeed(finish, undefined)
				const error = yield* Fiber.join(fiber)
				assert.ok(Predicate.hasProperty(error, "reason"))
				assert.equal(error.reason, "reference-conflict")
				assert.deepEqual(yield* runtimeStore.read(view.session.id), changed)
			}),
		),
	)
})

for (const strategy of [
	Config.Compaction.Native(),
	Config.Compaction.NonNative({ keepRecentMessages: 1 }),
]) {
	test(`automatic ${strategy._tag} compaction defaults to 90 percent, runs once and gives CurrentWindow to the model call`, async () => {
		let windows: ReadonlyArray<ContextWindow.Window> = []
		const test = ContextCompactionTest()
		let summaries = 0
		const lm = LanguageModelTest({
			streamText: () =>
				Stream.unwrap(
					Effect.map(
						Effect.serviceOption(ContextWindow.CurrentWindow),
						(window) => {
							const w = Option.getOrThrow(window)
							windows = EffectArray.append(windows, w)
							return Stream.fromArray(textParts("answer"))
						},
					),
				),
			generateText: () =>
				Effect.sync(() => {
					summaries++
					return [Response.makePart("text", { text: "summary" }), finish()]
				}),
		})
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { runtime, runtimeStore, view } = yield* SessionTest({
						compaction: {
							...test.service,
							count: (request) =>
								JSON.stringify(request.window.prompt).includes("summary")
									? Effect.succeed(10)
									: test.service.count(request),
							compact: test.service.compact,
						},
						modelCatalog: Effect.succeed([
							Config.Model.make({ ...catalog, compaction: strategy }),
						]),
					})
					const before = yield* selected(runtimeStore, view.session.id)
					const result = yield* runtime.execute({
						base: {
							session: view.session.id,
							revision: before.session.revision,
						},
						input: "new",
					})
					assert.equal(
						test.compactions,
						Match.value(strategy).pipe(
							Match.tag("Native", () => 1),
							Match.orElse(() => 0),
						),
					)
					assert.equal(
						summaries,
						Match.value(strategy).pipe(
							Match.tag("NonNative", () => 1),
							Match.orElse(() => 0),
						),
					)
					assert.equal(
						windows[0]?._tag,
						Match.value(strategy).pipe(
							Match.tag("Native", () => "Native" as const),
							Match.orElse(() => "Prompt" as const),
						),
					)
					assert.equal(
						result.state.value.conversation.context._tag,
						Match.value(strategy).pipe(
							Match.tag("Native", () => "Native" as const),
							Match.orElse(() => "Prompt" as const),
						),
					)
					assert.equal(result.state.value.conversation.history.length, 3)
					assert.match(
						JSON.stringify(test.requests[0]?.instructions),
						/instructions|content/,
					)
				}),
			).pipe(Effect.provide(lm)),
		)
	})
}

test("summarize only returns text and does not change any version data", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, view } = yield* SessionTest()
				const before = yield* selected(runtimeStore, view.session.id)
				const summary = yield* ConversationContextOperations.make({
					store: runtimeStore,
					runtime,
					session: view.session.id,
					request,
				}).summarize
				assert.equal(summary.text, "summary")
				assert.equal(summary.sourceMessages, 1)
				assert.deepEqual(yield* runtimeStore.read(view.session.id), before)
			}),
		).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.empty,
					generateText: () =>
						Effect.succeed([Response.makePart("text", { text: "summary" })]),
				}),
			),
		),
	)
})

test("Fork keeps compatible native context and rebuilds input for an incompatible model from the selected full history", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const test = ContextCompactionTest(),
					{ runtime, runtimeStore, view } = yield* SessionTest({
						compaction: test.service,
						modelCatalog: Effect.succeed([catalog]),
					})
				const source = yield* selected(runtimeStore, view.session.id)
				const compacted = (yield* runtime.compact({
					session: source.session.id,
					targetTokens: 20,
					request,
				})).view
				const same = yield* runtimeStore.fork({ source: source.session.id })
				assert.deepEqual(
					same.state.value.conversation.context,
					compacted.state.value.conversation.context,
				)
				const other = yield* runtimeStore.fork({
					source: source.session.id,
					settings: {
						model: Config.Selection.make({
							provider,
							model: Model.Id.make("other"),
						}),
					},
				})
				assert.equal(other.state.value.conversation.context._tag, "Prompt")
				assert.match(
					JSON.stringify(other.state.value.conversation.context),
					/whole history/,
				)
				assert.deepEqual(
					(yield* runtimeStore.read(source.session.id)).state.value,
					compacted.state.value,
				)
				assert.equal(test.compactions, 1)
			}),
		),
	)
})
