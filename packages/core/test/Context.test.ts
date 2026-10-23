// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import {
	Array as EffectArray,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Match,
	Option,
	Predicate,
	Stream,
} from "effect"
import { Prompt, Response, Toolkit } from "effect/ai"
import {
	type Chat,
	type ChatStore,
	ChatRuntime,
	ChatStoreRepository,
	Config,
	ContextCompaction,
	ContextWindow,
	ConversationContextOperations,
	Item,
	Model,
	Provider,
} from "@openbot-build/core"
import { ChatTest } from "./ChatTest.ts"
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
/** Gives the Chat one Item, a window with the same message, and the model of the catalog. */
const selected = (runtimeStore: ChatStore.Store, chat: Chat.Id) =>
	runtimeStore
		.modifyEffect({
			chat,
			update: (current) =>
				Effect.succeed([
					undefined,
					Option.some({
						append: [
							{
								id: Item.Id.make("history"),
								content: Prompt.make("whole history"),
							},
						],
						value: {
							...current.state,
							conversation: {
								...current.state.conversation,
								context: ContextWindow.fromPrompt("whole history"),
							},
						},
						chat: {
							settings: { ...current.chat.settings, model: selection },
						},
					}),
				] as const),
		})
		.pipe(Effect.map(({ view }) => view))

test("explicit compaction keeps opaque items and the whole Item log, also for a new store over the same persistence", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const test = ContextCompactionTest()
				const { runtime, runtimeStore, chat, definition, persistence } =
					yield* ChatTest({
						compaction: test.service,
						modelCatalog: Effect.succeed([catalog]),
					})
				const before = yield* selected(runtimeStore, chat)
				const log = yield* runtimeStore.items(chat)
				const service = ConversationContextOperations.make({
					store: runtimeStore,
					runtime,
					chat,
					request,
				})
				const result = yield* service.compact({ targetTokens: 20 })
				assert.ok(Option.isNone(result.summary))
				assert.equal(result.afterTokens, 10)
				assert.equal(test.compactions, 1)
				const compacted = yield* runtimeStore.read(chat)
				assert.deepEqual(yield* runtimeStore.items(chat), log)
				assert.equal(compacted.chat.revision, before.chat.revision + 1)
				assert.equal(compacted.state.conversation.context._tag, "Native")
				assert.deepEqual(
					(
						compacted.state.conversation.context as Extract<
							ContextWindow.Window,
							{ _tag: "Native" }
						>
					).items,
					[
						{
							type: "message",
							content: [{ type: "output_text", text: "retained" }],
						},
						{
							type: "compaction",
							encrypted_content: "encrypted",
							opaque: { v: 1 },
						},
					],
				)
				const freshStore = yield* ChatStoreRepository.make({
					definition,
					persistence,
				})
				const fresh = yield* ChatRuntime.make({
					store: freshStore,
					bot: { compaction: test.service },
				})
				const restored = yield* freshStore.read(chat)
				assert.deepEqual(
					restored.state.conversation.context,
					compacted.state.conversation.context,
				)
				const continued = yield* fresh.execute({ chat, input: "continue" })
				assert.equal(continued.state.conversation.context._tag, "Native")
				assert.match(
					JSON.stringify(yield* freshStore.items(chat)),
					/whole history.*continue/,
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
					const { runtime, runtimeStore, chat } = yield* ChatTest({
						compaction: test.service,
						modelCatalog: Effect.succeed([catalog]),
					})
					const before = yield* selected(runtimeStore, chat)
					const error = yield* runtime
						.compact({ chat, targetTokens: entry.target, request })
						.pipe(Effect.flip)
					assert.ok(Predicate.hasProperty(error, "reason"))
					assert.equal(error.reason, entry.reason)
					assert.equal(test.compactions, entry.calls)
					assert.deepEqual(yield* runtimeStore.read(chat), before)
				}),
			),
		)
})

test("compaction checks the revision after its network work and rejects a competing change", async () => {
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
				const { runtime, runtimeStore, chat } = yield* ChatTest({
					compaction: test.service,
					modelCatalog: Effect.succeed([catalog]),
				})
				yield* selected(runtimeStore, chat)
				const fiber = yield* Effect.forkChild(
					runtime
						.compact({ chat, targetTokens: 20, request })
						.pipe(Effect.flip),
				)
				yield* Deferred.await(start)
				const changed = (yield* runtimeStore.modifyEffect({
					chat,
					update: (current) =>
						Effect.succeed([
							undefined,
							Option.some({
								value: {
									...current.state,
									conversation: {
										...current.state.conversation,
										context: ContextWindow.append(
											current.state.conversation.context,
											"competing change",
										),
									},
								},
							}),
						] as const),
				})).view
				yield* Deferred.succeed(finish, undefined)
				const error = yield* Fiber.join(fiber)
				assert.ok(Predicate.hasProperty(error, "reason"))
				assert.equal(error.reason, "reference-conflict")
				assert.deepEqual(yield* runtimeStore.read(chat), changed)
			}),
		),
	)
})

for (const strategy of [
	Config.Compaction.Native(),
	Config.Compaction.NonNative({ keepRecentMessages: 1 }),
]) {
	test(`automatic ${strategy._tag} compaction starts at 90 percent, runs once and gives CurrentWindow to the model call`, async () => {
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
					const { runtime, runtimeStore, chat } = yield* ChatTest({
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
					yield* selected(runtimeStore, chat)
					const result = yield* runtime.execute({ chat, input: "new" })
					const expected = Match.value(strategy).pipe(
						Match.tag("Native", () => "Native" as const),
						Match.orElse(() => "Prompt" as const),
					)
					assert.equal(test.compactions, expected === "Native" ? 1 : 0)
					assert.equal(summaries, expected === "Native" ? 0 : 1)
					assert.equal(windows[0]?._tag, expected)
					assert.equal(result.state.conversation.context._tag, expected)
					assert.equal((yield* runtimeStore.items(chat)).length, 3)
					assert.match(
						JSON.stringify(test.requests[0]?.instructions),
						/instructions|content/,
					)
				}),
			).pipe(Effect.provide(lm)),
		)
	})
}

test("summarize only returns text and changes nothing", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, chat } = yield* ChatTest()
				const before = yield* selected(runtimeStore, chat)
				const summary = yield* ConversationContextOperations.make({
					store: runtimeStore,
					runtime,
					chat,
					request,
				}).summarize
				assert.equal(summary.text, "summary")
				assert.equal(summary.sourceMessages, 1)
				assert.deepEqual(yield* runtimeStore.read(chat), before)
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

test("a native window stays for its own model, and another model gets a Prompt window with a note first", async () => {
	let prompts: ReadonlyArray<Prompt.Prompt> = []
	let windows: ReadonlyArray<ContextWindow.Window> = []
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const test = ContextCompactionTest(),
					{ runtime, runtimeStore, chat } = yield* ChatTest({
						compaction: test.service,
						modelCatalog: Effect.succeed([catalog]),
					})
				const source = yield* selected(runtimeStore, chat)
				yield* runtime.compact({
					chat: source.chat.id,
					targetTokens: 20,
					request,
				})
				const same = yield* runtime.execute({ chat, input: "same model" })
				assert.equal(windows[0]?._tag, "Native")
				assert.equal(same.state.conversation.context._tag, "Native")
				const other = Config.Selection.make({
					provider,
					model: Model.Id.make("other"),
				})
				yield* runtimeStore.modifyEffect({
					chat,
					update: (current) =>
						Effect.succeed([
							undefined,
							Option.some({
								chat: { settings: { ...current.chat.settings, model: other } },
							}),
						] as const),
				})
				const switched = yield* runtime.execute({ chat, input: "other model" })
				assert.equal(windows[1]?._tag, "Prompt")
				assert.equal(switched.state.conversation.context._tag, "Prompt")
				const shown = prompts[1]!.content
				const note = shown[0]
				assert.ok(note !== undefined && note.role === "user")
				assert.match(JSON.stringify(note), /compacted/)
				assert.doesNotMatch(JSON.stringify(prompts[1]), /whole history/)
				assert.match(JSON.stringify(prompts[1]), /same model.*other model/)
				assert.match(
					JSON.stringify(yield* runtimeStore.items(chat)),
					/whole history/,
				)
				assert.equal(test.compactions, 1)
			}),
		).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: ({ prompt }) =>
						Stream.unwrap(
							Effect.map(
								Effect.serviceOption(ContextWindow.CurrentWindow),
								(window) => {
									prompts = EffectArray.append(prompts, prompt)
									windows = EffectArray.append(
										windows,
										Option.getOrThrow(window),
									)
									return Stream.fromArray(textParts("answer"))
								},
							),
						),
				}),
			),
		),
	)
})
