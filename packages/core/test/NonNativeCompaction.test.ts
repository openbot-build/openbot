// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import {
	Array as EffectArray,
	Data,
	Effect,
	Option,
	Stream,
	Predicate,
} from "effect"
import { AiError, Model as AiModel, Prompt, Response, Toolkit } from "effect/ai"
import {
	type Chat,
	type ChatStore,
	ChatStoreRepository,
	Config,
	ContextCompaction,
	ContextWindow,
	Item,
	Model,
	SummaryCompaction,
	Provider,
} from "@openbot-build/core"
import { ChatTest } from "./ChatTest.ts"
import { finish, LanguageModelTest } from "./LanguageModelTest.ts"

const text = (value: string) =>
	Prompt.userMessage({ content: [Prompt.textPart({ text: value })] })
const providerId = Provider.Id.make("execution")
const modelId = Model.Id.make("execution-model")
const summarySelection = Config.Selection.make({
	provider: Provider.Id.make("summaries"),
	model: Model.Id.make("summary-model"),
	reasoningEffort: "low",
	serviceTier: "priority",
})
const request = {
	instructions: Prompt.make([{ role: "system", content: "task instructions" }]),
	toolkit: Toolkit.empty,
}
const conversation = Prompt.fromMessages([
	text("old goal"),
	text("old decisions"),
	text("recent request"),
])
const catalog = Config.Model.make({
	provider: providerId,
	id: modelId,
	name: "Execution",
	reasoningEfforts: [],
	serviceTiers: [],
	contextWindow: 100,
	compaction: Config.Compaction.NonNative({
		model: summarySelection,
		keepRecentMessages: 1,
	}),
})

/** Gives the Chat one Item for each message, a window with all of them, and the model. */
const populate = (runtimeStore: ChatStore.Store, chat: Chat.Id) =>
	runtimeStore
		.modifyEffect({
			chat,
			update: (current) =>
				Effect.succeed([
					undefined,
					Option.some({
						append: conversation.content.map((message, index) => ({
							id: Item.Id.make(`message-${index}`),
							content: Prompt.fromMessages([message]),
						})),
						value: {
							...current.state,
							conversation: {
								...current.state.conversation,
								context: ContextWindow.fromPrompt(conversation),
							},
						},
						chat: {
							settings: {
								...current.chat.settings,
								model: Config.Selection.make({
									provider: providerId,
									model: modelId,
								}),
							},
						},
					}),
				] as const),
		})
		.pipe(Effect.map(({ view }) => view))

test("summary generation keeps system instructions, media and complete tool and approval exchanges", async () => {
	let sources: ReadonlyArray<string> = []
	const system = Prompt.systemMessage({ content: "keep these instructions" })
	const call = Prompt.assistantMessage({
		content: [
			Prompt.toolCallPart({
				id: "call",
				name: "Read",
				params: {},
				providerExecuted: false,
			}),
			Prompt.toolApprovalRequestPart({
				approvalId: "approval",
				toolCallId: "call",
			}),
		],
	})
	const approval = Prompt.toolMessage({
		content: [
			Prompt.toolApprovalResponsePart({
				approvalId: "approval",
				approved: true,
			}),
		],
	})
	const result = Prompt.toolMessage({
		content: [
			Prompt.toolResultPart({
				id: "call",
				name: "Read",
				result: "read result",
				isFailure: false,
				providerExecuted: false,
			}),
		],
	})
	const media = Prompt.userMessage({
		content: [
			Prompt.filePart({
				data: new URL("https://example.com/image.png"),
				mediaType: "image/png",
			}),
		],
	})
	const prompt = Prompt.fromMessages([
		system,
		text("old goal"),
		text("old decision"),
		call,
		approval,
		result,
		media,
	])
	const window = await Effect.runPromise(
		SummaryCompaction.compact({
			prompt,
			keepRecentMessages: 2,
			targetTokens: 80,
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.empty,
					generateText: (options) =>
						Effect.sync(() => {
							sources = EffectArray.append(
								sources,
								JSON.stringify(options.prompt),
							)
							assert.equal(options.toolChoice, "none")
							assert.equal(options.tools.length, 0)
							return [
								Response.makePart("text", {
									text: "summary of the goal and decision",
								}),
								finish(),
							]
						}),
				}),
			),
		),
	)
	assert.equal(window._tag, "Prompt")
	assert.deepEqual(window.prompt.content.slice(2), [
		call,
		approval,
		result,
		media,
	])
	assert.equal(window.prompt.content[0], system)
	assert.equal(window.prompt.content.at(-1), media)
	assert.match(sources[0]!, /old goal/)
	assert.doesNotMatch(sources[0]!, /read result|image.png/)
})

test("repeated compaction summarizes the existing summary and keeps eight recent messages by default", async () => {
	let sources: ReadonlyArray<string> = []
	const layer = LanguageModelTest({
		streamText: () => Stream.empty,
		generateText: (options) =>
			Effect.sync(() => {
				sources = EffectArray.append(sources, JSON.stringify(options.prompt))
				return [
					Response.makePart("text", { text: `summary-${sources.length}` }),
					finish(),
				]
			}),
	})
	await Effect.runPromise(
		Effect.gen(function* () {
			const messages = Array.from({ length: 10 }, (_, index) =>
				text(`original-${index}`),
			)
			const first = yield* SummaryCompaction.compact({
				prompt: Prompt.fromMessages(messages),
				targetTokens: 80,
			})
			assert.deepEqual(first.prompt.content.slice(1), messages.slice(2))
			const next = ContextWindow.append(
				first,
				Prompt.fromMessages([text("new-1"), text("new-2")]),
			)
			const second = yield* SummaryCompaction.compact({
				prompt: next.prompt,
				targetTokens: 80,
			})
			assert.equal(second.prompt.content.length, 9)
			assert.match(sources[1]!, /summary-1|original-2|original-3/)
			assert.doesNotMatch(sources[1]!, /original-0|original-1|new-2/)
			const unchanged = yield* SummaryCompaction.compact({
				prompt: Prompt.fromMessages([text("short")]),
				targetTokens: 80,
			})
			assert.deepEqual(unchanged.prompt, Prompt.fromMessages([text("short")]))
			assert.equal(sources.length, 2)
		}).pipe(Effect.provide(layer)),
	)
})

test("the configured summary provider is chosen separately, and committed windows survive a new store", async () => {
	let selections: ReadonlyArray<Config.Selection> = []
	let counts: ReadonlyArray<ContextCompaction.Request> = []
	let summaries = 0
	const summaryProvider = new Provider.Provider({
		id: summarySelection.provider,
		model: (selection) =>
			Effect.sync(() => {
				selections = EffectArray.append(selections, selection)
				return Model.make({
					provider: selection.provider,
					model: selection.model,
					layer: LanguageModelTest({
						streamText: () => Stream.die("summary must use generateText"),
						generateText: (options) =>
							Effect.gen(function* () {
								assert.equal(
									Option.getOrThrow(
										yield* Effect.serviceOption(AiModel.ProviderName),
									),
									summarySelection.provider,
								)
								assert.equal(
									Option.getOrThrow(
										yield* Effect.serviceOption(AiModel.ModelName),
									),
									summarySelection.model,
								)
								assert.equal(
									Option.getOrThrow(
										yield* Effect.serviceOption(ContextWindow.CurrentWindow),
									).prompt.content.length,
									0,
								)
								assert.match(
									JSON.stringify(options.prompt),
									/old goal|old decisions/,
								)
								assert.doesNotMatch(
									JSON.stringify(options.prompt),
									/recent request/,
								)
								summaries++
								return [
									Response.makePart("text", { text: "preserved summary" }),
									finish(),
								]
							}),
					}),
				})
			}),
	})
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const counter = {
					count: (input: ContextCompaction.Request) =>
						Effect.sync(() => {
							counts = EffectArray.append(counts, input)
							return JSON.stringify(input.window.prompt).includes(
								"preserved summary",
							)
								? 20
								: 90
						}),
					compact: () =>
						Effect.die("NonNative must not call the native service"),
				}
				const { runtime, runtimeStore, chat, definition, persistence } =
					yield* ChatTest({
						modelCatalog: Effect.succeed([catalog]),
						providers: [summaryProvider],
						compaction: counter,
					})
				const before = yield* populate(runtimeStore, chat)
				const log = yield* runtimeStore.items(chat)
				const result = yield* runtime.compact({
					chat,
					targetTokens: 50,
					request,
				})
				assert.equal(summaries, 1)
				assert.deepEqual(selections, [summarySelection])
				assert.equal(result.afterTokens, 20)
				assert.deepEqual(yield* runtimeStore.items(chat), log)
				assert.deepEqual(
					result.view.chat.settings.model,
					before.chat.settings.model,
				)
				assert.deepEqual(
					result.view.state.conversation.context.prompt.content.slice(1),
					conversation.content.slice(-1),
				)
				for (const counted of counts) {
					assert.equal(counted.selection.model, modelId)
					assert.equal(counted.instructions, request.instructions)
					assert.equal(counted.toolkit, request.toolkit)
				}
				const restored = yield* ChatStoreRepository.make({
					definition,
					persistence,
				})
				assert.deepEqual(
					(yield* restored.read(chat)).state.conversation.context,
					result.view.state.conversation.context,
				)
			}),
		),
	)
})

class BuildFailure extends Data.TaggedError("BuildFailure")<{}> {}

for (const scenario of [
	"missing-provider",
	"build-failure",
	"generation-failure",
	"empty-summary",
	"truncated-summary",
	"missed-target",
	"head-conflict",
] as const) {
	test(`non-native ${scenario} leaves the Item log and the window uncommitted`, async () => {
		let calls = 0
		const failure = new BuildFailure()
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const counter = {
						count: (input: ContextCompaction.Request) =>
							Effect.succeed(
								JSON.stringify(input.window.prompt).includes("summary") &&
									scenario !== "missed-target"
									? 10
									: 90,
							),
						compact: () => Effect.die("must not call native compaction"),
					}
					let race: Effect.Effect<unknown> = Effect.void
					const summaryProvider = new Provider.Provider({
						id: summarySelection.provider,
						model: () =>
							scenario === "build-failure"
								? Effect.fail(failure)
								: Effect.succeed(
										Model.make({
											provider: summarySelection.provider,
											model: summarySelection.model,
											layer: LanguageModelTest({
												streamText: () => Stream.empty,
												generateText: () =>
													Effect.gen(function* () {
														calls++
														yield* race
														if (scenario === "generation-failure")
															return yield* AiError.make({
																module: "test",
																method: "generateText",
																reason: AiError.InvalidRequestError.make({
																	description: "generation failure",
																}),
															})
														return [
															Response.makePart("text", {
																text:
																	scenario === "empty-summary" ? "" : "summary",
															}),
															finish(
																scenario === "truncated-summary"
																	? "length"
																	: "stop",
															),
														]
													}),
											}),
										}),
									),
					})
					const { runtime, runtimeStore, chat } = yield* ChatTest({
						modelCatalog: Effect.succeed([catalog]),
						providers: scenario === "missing-provider" ? [] : [summaryProvider],
						compaction: counter,
					})
					const before = yield* populate(runtimeStore, chat)
					const log = yield* runtimeStore.items(chat)
					if (scenario === "head-conflict")
						race = runtimeStore
							.modifyEffect({
								chat,
								update: (current) =>
									Effect.succeed([
										undefined,
										Option.some({
											chat: {
												settings: { ...current.chat.settings, mode: "plan" },
											},
										}),
									] as const),
							})
							.pipe(Effect.orDie)
					const error = yield* runtime
						.compact({ chat, targetTokens: 50, request })
						.pipe(Effect.flip)
					if (scenario === "build-failure") assert.equal(error, failure)
					else {
						assert.ok(Predicate.hasProperty(error, "reason"))
						assert.equal(
							error.reason,
							scenario === "missing-provider"
								? "unsupported"
								: scenario === "missed-target"
									? "target-not-reached"
									: scenario === "head-conflict"
										? "reference-conflict"
										: "request-failed",
						)
					}
					const after = yield* runtimeStore.read(chat)
					assert.deepEqual(
						after.state.conversation.context,
						before.state.conversation.context,
					)
					assert.deepEqual(yield* runtimeStore.items(chat), log)
					if (scenario !== "head-conflict")
						assert.equal(after.chat.revision, before.chat.revision)
					assert.equal(
						calls,
						scenario === "missing-provider" || scenario === "build-failure"
							? 0
							: 1,
					)
				}),
			),
		)
	})
}
