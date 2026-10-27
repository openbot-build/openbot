import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Effect,
	Option,
	Schema,
	Stream,
	String as Str,
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
	TurnRunner,
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
/** The JSON text of a value, so a test can match a pattern in it. */
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
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
						append: Arr.map(conversation.content, (message, index) => ({
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

it.effect(
	"summary generation keeps system instructions, media and complete tool and approval exchanges",
	() => {
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
		return Effect.gen(function* () {
			const window = yield* SummaryCompaction.compact({
				prompt,
				keepRecentMessages: 2,
				targetTokens: 80,
			}).pipe(
				Effect.provide(
					LanguageModelTest({
						streamText: () => Stream.empty,
						generateText: (options) =>
							Effect.gen(function* () {
								const source = yield* json(options.prompt).pipe(Effect.orDie)
								sources = Arr.append(sources, source)
								assert.strictEqual(options.toolChoice, "none")
								assert.strictEqual(options.tools.length, 0)
								return [
									Response.makePart("text", {
										text: "summary of the goal and decision",
									}),
									finish(),
								]
							}),
					}),
				),
			)
			assert.strictEqual(window._tag, "Prompt")
			assert.deepStrictEqual(window.prompt.content.slice(2), [
				call,
				approval,
				result,
				media,
			])
			assert.strictEqual(window.prompt.content[0], system)
			assert.strictEqual(window.prompt.content.at(-1), media)
			assert.match(sources[0]!, /old goal/)
			assert.notMatch(sources[0]!, /read result|image.png/)
		})
	},
)

it.effect(
	"repeated compaction summarizes the existing summary and keeps eight recent messages by default",
	() => {
		let sources: ReadonlyArray<string> = []
		const layer = LanguageModelTest({
			streamText: () => Stream.empty,
			generateText: (options) =>
				Effect.gen(function* () {
					const source = yield* json(options.prompt).pipe(Effect.orDie)
					sources = Arr.append(sources, source)
					return [
						Response.makePart("text", { text: `summary-${sources.length}` }),
						finish(),
					]
				}),
		})
		return Effect.gen(function* () {
			const messages = Array.from({ length: 10 }, (_, index) =>
				text(`original-${index}`),
			)
			const first = yield* SummaryCompaction.compact({
				prompt: Prompt.fromMessages(messages),
				targetTokens: 80,
			})
			assert.deepStrictEqual(first.prompt.content.slice(1), messages.slice(2))
			const next = ContextWindow.append(
				first,
				Prompt.fromMessages([text("new-1"), text("new-2")]),
			)
			const second = yield* SummaryCompaction.compact({
				prompt: next.prompt,
				targetTokens: 80,
			})
			assert.strictEqual(second.prompt.content.length, 9)
			assert.match(sources[1]!, /summary-1/)
			assert.match(sources[1]!, /original-2/)
			assert.match(sources[1]!, /original-3/)
			assert.notMatch(sources[1]!, /original-0|original-1|new-2/)
			const unchanged = yield* SummaryCompaction.compact({
				prompt: Prompt.fromMessages([text("short")]),
				targetTokens: 80,
			})
			assert.deepStrictEqual(
				unchanged.prompt,
				Prompt.fromMessages([text("short")]),
			)
			assert.strictEqual(sources.length, 2)
		}).pipe(Effect.provide(layer))
	},
)

it.effect(
	"the configured summary provider is chosen separately, and committed windows survive a new store",
	() => {
		let selections: ReadonlyArray<Config.Selection> = []
		let counts: ReadonlyArray<ContextCompaction.Request> = []
		let summaries = 0
		const summaryProvider = new Provider.Provider({
			id: summarySelection.provider,
			model: (selection) =>
				Effect.sync(() => {
					selections = Arr.append(selections, selection)
					return Model.make({
						provider: selection.provider,
						model: selection.model,
						layer: LanguageModelTest({
							streamText: () => Stream.die("summary must use generateText"),
							generateText: (options) =>
								Effect.gen(function* () {
									assert.strictEqual(
										Option.getOrThrow(
											yield* Effect.serviceOption(AiModel.ProviderName),
										),
										summarySelection.provider,
									)
									assert.strictEqual(
										Option.getOrThrow(
											yield* Effect.serviceOption(AiModel.ModelName),
										),
										summarySelection.model,
									)
									assert.strictEqual(
										Option.getOrThrow(
											yield* Effect.serviceOption(ContextWindow.CurrentWindow),
										).prompt.content.length,
										0,
									)
									const source = yield* json(options.prompt).pipe(Effect.orDie)
									assert.match(source, /old goal/)
									assert.match(source, /old decisions/)
									assert.notMatch(source, /recent request/)
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
		return Effect.gen(function* () {
			const counter = {
				count: (input: ContextCompaction.Request) =>
					Effect.gen(function* () {
						counts = Arr.append(counts, input)
						const text = yield* json(input.window.prompt).pipe(Effect.orDie)
						return Str.includes("preserved summary")(text) ? 20 : 90
					}),
				compact: () => Effect.die("NonNative must not call the native service"),
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
			assert.strictEqual(summaries, 1)
			assert.deepStrictEqual(selections, [summarySelection])
			assert.strictEqual(result.afterTokens, 20)
			assert.deepStrictEqual(yield* runtimeStore.items(chat), log)
			assert.deepStrictEqual(
				result.view.chat.settings.model,
				before.chat.settings.model,
			)
			assert.deepStrictEqual(
				result.view.state.conversation.context.prompt.content.slice(1),
				conversation.content.slice(-1),
			)
			for (const counted of counts) {
				assert.strictEqual(counted.selection.model, modelId)
				assert.strictEqual(counted.instructions, request.instructions)
				assert.strictEqual(counted.toolkit, request.toolkit)
			}
			const restored = yield* ChatStoreRepository.make({
				definition,
				persistence,
			})
			assert.deepStrictEqual(
				(yield* restored.read(chat)).state.conversation.context,
				result.view.state.conversation.context,
			)
		})
	},
)

class BuildFailure extends Schema.TaggedError<
	BuildFailure,
	{ readonly brand: unique symbol }
>()("BuildFailure", {}) {}

for (const scenario of [
	"missing-provider",
	"build-failure",
	"generation-failure",
	"empty-summary",
	"truncated-summary",
	"missed-target",
	"head-conflict",
] as const) {
	it.effect(
		`non-native ${scenario} leaves the Item log and the window uncommitted`,
		() => {
			let calls = 0
			const failure = BuildFailure.make({})
			return Effect.gen(function* () {
				const counter = {
					count: (input: ContextCompaction.Request) =>
						json(input.window.prompt).pipe(
							Effect.orDie,
							Effect.map((text) =>
								Str.includes("summary")(text) && scenario !== "missed-target"
									? 10
									: 90,
							),
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
				const competing = ContextWindow.append(
					before.state.conversation.context,
					"competing change",
				)
				if (scenario === "head-conflict")
					race = runtimeStore
						.modifyEffect({
							chat,
							update: (current) =>
								Effect.succeed([
									undefined,
									Option.some({
										value: {
											...current.state,
											conversation: {
												...current.state.conversation,
												context: competing,
											},
										},
									}),
								] as const),
						})
						.pipe(Effect.orDie)
				const error = yield* runtime
					.compact({ chat, targetTokens: 50, request })
					.pipe(Effect.flip)
				if (scenario === "build-failure") assert.strictEqual(error, failure)
				else {
					assert.ok(Predicate.hasProperty(error, "reason"))
					assert.strictEqual(
						error.reason,
						scenario === "missing-provider"
							? "unsupported"
							: scenario === "missed-target"
								? "target-not-reached"
								: scenario === "head-conflict"
									? "head-conflict"
									: "request-failed",
					)
				}
				const after = yield* runtimeStore.read(chat)
				assert.deepStrictEqual(
					after.state.conversation.context,
					scenario === "head-conflict"
						? competing
						: before.state.conversation.context,
				)
				assert.deepStrictEqual(yield* runtimeStore.items(chat), log)
				if (scenario !== "head-conflict")
					assert.strictEqual(after.chat.revision, before.chat.revision)
				assert.strictEqual(
					calls,
					scenario === "missing-provider" || scenario === "build-failure"
						? 0
						: 1,
				)
			})
		},
	)
}

it.effect(
	"the Turn runner gives summary work to its host before saving the window",
	() =>
		Effect.gen(function* () {
			const { runtimeStore, chat } = yield* ChatTest()
			yield* populate(runtimeStore, chat)
			const runner = yield* TurnRunner.make({
				store: runtimeStore,
				bot: {
					modelCatalog: Effect.succeed([
						Config.Model.make({
							...catalog,
							compaction: Config.Compaction.NonNative({
								keepRecentMessages: 1,
							}),
						}),
					]),
					compaction: {
						count: () => Effect.succeed(10),
						compact: () => Effect.die("This model uses a summary."),
					},
				},
				summarize: (selection, input) =>
					Effect.gen(function* () {
						assert.equal(selection.model, modelId)
						const saved = yield* runtimeStore.read(chat).pipe(Effect.orDie)
						assert.deepEqual(
							saved.state.conversation.context.prompt,
							conversation,
						)
						const prepared = yield* SummaryCompaction.prepare(input)
						assert.equal(prepared._tag, "Summary")
						if (prepared._tag === "Unchanged") return prepared.window
						return yield* prepared.complete(
							"The host saved this summary.",
							"stop",
						)
					}),
			})
			const result = yield* runner.compact({ chat, targetTokens: 50, request })
			assert.deepEqual(
				result.view.state.conversation.context.prompt.content.slice(1),
				conversation.content.slice(-1),
			)
			assert.include(
				yield* json(result.view.state.conversation.context.prompt),
				"The host saved this summary.",
			)
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					generateText: () => Effect.die("The host owns summary model calls."),
					streamText: () => Stream.die("No model step runs in this test."),
				}),
			),
		),
)
