import {
	Array as Arr,
	Clock,
	Context,
	Duration,
	Effect,
	Equal,
	Exit,
	Match,
	Option,
	Predicate,
	Record as Rec,
	RcRef,
	Ref,
	Schema,
	Scope,
	Stream,
	pipe,
} from "effect"
import {
	AiError,
	IdGenerator,
	LanguageModel,
	Prompt,
	Toolkit,
	type Tool,
} from "effect/ai"
import * as Chat from "./Chat.ts"
import * as HostActionDriver from "./HostActionDriver.ts"
import * as Turn from "./Turn.ts"
import * as StepRunner from "./StepRunner.ts"
import type * as ModelStep from "./ModelStep.ts"
import type * as ToolStep from "./ToolStep.ts"
import * as TurnState from "./TurnState.ts"
import * as Item from "./Item.ts"
import * as ChatState from "./ChatState.ts"
import * as Bot from "../bot/Bot.ts"
import * as Config from "../models/Config.ts"
import * as ConfigurationOperations from "../models/ConfigurationOperations.ts"
import * as ContextWindow from "../context/ContextWindow.ts"
import * as ContextCompaction from "../context/ContextCompaction.ts"
import * as SummaryCompaction from "../context/SummaryCompaction.ts"
import * as Plugin from "../plugins/Plugin.ts"
import * as PluginComposition from "../plugins/PluginComposition.ts"
import * as Registration from "../plugins/ToolRegistration.ts"
import * as Operation from "./Operation.ts"
import * as Operations from "./Operations.ts"
import { logFailure } from "./Failures.ts"

const isJson = Schema.is(Schema.Json)

/** Where a tool call of a Turn sends the end of its Operation. */
interface Background {
	readonly chat: Chat.Id
	readonly turn: Turn.Id
	readonly author?: Turn.Author
	readonly retain: Effect.Effect<void, never, Scope.Scope>
	readonly notify: (
		input: Chat.DeliverInput,
	) => Effect.Effect<unknown, Chat.RuntimeError>
}

/**
 * Gives every call a time budget. A call that ends in its budget gives its result as
 * before. A call that does not goes on as an Operation, and the model gets its id.
 * The handler runs inside the Operation fiber, so its work does not end with the Turn.
 */
const inBackground = <Tools extends Record<string, Tool.Any>>(
	raw: Toolkit.WithHandler<Tools>,
	operations: typeof Operations.Operations.Service,
	background: Background,
): Toolkit.WithHandler<Tools> => ({
	tools: raw.tools,
	handle: ((
		name: string,
		params: unknown,
		toolCallId?: string,
		options?: unknown,
	) =>
		Effect.gen(function* () {
			const tool = (raw.tools as Record<string, Tool.Any>)[name]
			const budget =
				tool === undefined
					? undefined
					: Option.getOrUndefined(
							Context.getOption(tool.annotations, Operation.Budget),
						)
			const handle = raw.handle as (
				...args: ReadonlyArray<unknown>
			) => Effect.Effect<
				Stream.Stream<Tool.HandlerResult<Tool.Any>, AiError.AiError>,
				AiError.AiError
			>
			const call = handle(name, params, toolCallId, options)
			if (budget === "foreground") return yield* call
			// Preliminary results only matter to a waiting caller, so the work keeps the last one.
			const work = Effect.flatMap(call, (results) =>
				results.pipe(
					Stream.filter((result) => !result.preliminary),
					Stream.runLast,
				),
			)
			const outcome = yield* operations.run(
				{
					chat: background.chat,
					turn: background.turn,
					callId: toolCallId ?? name,
					tool: name,
					acquire: background.retain,
					...(budget === undefined ? {} : { budget }),
					notify: (record) =>
						background
							.notify({
								chat: background.chat,
								input: Operations.noticeText(record),
								notice: { kind: "operation", ref: record.id },
								...(background.author === undefined
									? {}
									: { author: background.author }),
							})
							.pipe(
								Effect.catchCause((cause) =>
									logFailure(
										"The end of an Operation could not reach its Chat",
									)(cause).pipe(
										Effect.annotateLogs({
											chatId: background.chat,
											turnId: background.turn,
											operationId: record.id,
										}),
									),
								),
								Effect.asVoid,
							),
				},
				work,
				(exit) =>
					Exit.match(exit, {
						onFailure: (cause) =>
							Operation.Status.Failed({
								message: Operations.failureMessage(cause),
							}),
						onSuccess: (last) =>
							Option.match(last, {
								onNone: () =>
									Operation.Status.Failed({
										message: "The call gave no result.",
									}),
								// The record keeps the result as JSON, so a result that is not JSON is a failure here.
								onSome: (result) =>
									!isJson(result.encodedResult)
										? Operation.Status.Failed({
												message: "The call gave a result that is not JSON.",
											})
										: result.isFailure
											? Operation.Status.Failed({
													message: "The call failed.",
													result: result.encodedResult,
												})
											: Operation.Status.Completed({
													result: result.encodedResult,
												}),
							}),
					}),
			)
			if (outcome._tag === "Done")
				return Exit.match(outcome.exit, {
					onFailure: (cause) => Stream.failCause(cause),
					onSuccess: (last) =>
						Option.match(last, {
							onNone: () => Stream.empty,
							onSome: (result) => Stream.succeed(result),
						}),
				})
			const result = Operations.backgroundResult(outcome.record)
			return Stream.succeed({
				result,
				encodedResult: result,
				isFailure: false,
				preliminary: false,
			})
		})) as never,
})

/** One Turn that the runtime accepted, with its first Items. */
export interface Accepted<P> {
	readonly view: Chat.View<P>
	readonly turn: Turn.Id
	readonly item: Item.Id
	readonly prompt: Prompt.Prompt
}

/** A Turn runner owns no fibers. Its caller owns the scope and its end state. */
export const make = <
	P = {},
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
	HostTools extends Record<string, Tool.Any> = {},
	ModelE = never,
	ToolE = never,
>(
	options: Pick<
		Chat.RuntimeOptions<P, Tools, E, R, BuildE, BuildR, HostTools>,
		"bot" | "store"
	> & {
		readonly executeModel?: ModelStep.Executor<ModelE>
		/** The server saves summary model calls in the same call log as model steps. */
		readonly summarize?: (
			selection: Config.Selection,
			input: ContextCompaction.NonNativeRequest,
		) => Effect.Effect<
			Effect.Success<ReturnType<ContextCompaction.NonNativeCompact>>,
			ContextCompaction.ContextCompactionError | ModelE,
			LanguageModel.LanguageModel
		>
		readonly executeTool?: ToolStep.Executor<ToolE>
		/** The memory runtime owns background work and its return path together. */
		readonly background?: {
			readonly operations: typeof Operations.Operations.Service
			readonly notify: (
				input: Chat.DeliverInput,
			) => Effect.Effect<unknown, Chat.RuntimeError>
		}
	},
) =>
	Effect.gen(function* () {
		type Event = Bot.Event<
			Toolkit.MergedTools<[Toolkit.Toolkit<Tools>, Toolkit.Toolkit<HostTools>]>,
			P
		>
		const services = yield* Effect.context<
			Exclude<BuildR, Bot.Context> | Bot.RuntimeServices<Tools, R>
		>()
		const bot = options.bot
		const store = options.store
		const chatEvent = (view: Chat.View<P>): Event => ({
			_tag: "ChatUpdated",
			view,
		})
		const requireTurn = TurnState.requireTurn
		const requireOpenTurn = TurnState.requireOpen
		const suppliedTools = bot.toolkit
		const basePlugin =
			bot.plugin ??
			Plugin.make({ id: Plugin.Id.make("@openbot-build/core/runtime-tools") })<
				Tools,
				E,
				R
			>(() =>
				Effect.succeed({
					tools: {} as Tools,
					handlers: Context.empty() as Context.Context<Tool.HandlersFor<Tools>>,
				}),
			)
		const hosted =
			bot.hostPlugin ??
			Plugin.make({
				id: Plugin.Id.make("@openbot-build/core/empty-host-tools"),
			})<HostTools>(() =>
				Effect.succeed({
					tools: {} as HostTools,
					handlers: Context.empty() as Context.Context<
						Tool.HandlersFor<HostTools>
					>,
				}),
			)
		const build = PluginComposition.merge(basePlugin, hosted).register

		const generator = Option.getOrElse(
			yield* Effect.serviceOption(IdGenerator.IdGenerator),
			() => IdGenerator.defaultIdGenerator,
		)
		const id = () => generator.generateId()
		const compactionService = Option.fromUndefinedOr(bot.compaction)
		const approvals = Option.fromUndefinedOr(bot.approvals)
		const decide = (
			request: Chat.ApprovalRequest,
		): Effect.Effect<Chat.Decision> =>
			Option.match(approvals, {
				onNone: () =>
					Effect.succeed(Chat.Decision.Pending({ result: Chat.pendingResult })),
				onSome: (service) => service.decide(request),
			})
		const background = Option.fromUndefinedOr(options.background)
		const findModel = (selection: Config.Selection | undefined) =>
			(bot.modelCatalog ?? Effect.succeed([])).pipe(
				Effect.map((models) =>
					Arr.findFirst(
						models,
						(model) =>
							model.provider === selection?.provider &&
							model.id === selection?.model,
					),
				),
			)

		const itemsOf = (
			chat: Chat.Id,
			turn: Turn.Id,
			step: number,
			entries: ReadonlyArray<Chat.InboxEntry>,
		) => TurnState.inputs(id, chat, turn, step, entries)
		const compact = (input: {
			chat: Chat.Id
			targetTokens: number
			request: Omit<ContextCompaction.Request, "window" | "selection">
			expected?: Chat.Revision
			selection?: Config.Selection
		}) =>
			Effect.gen(function* () {
				if (
					!Number.isSafeInteger(input.targetTokens) ||
					input.targetTokens <= 0
				)
					return yield* ContextCompaction.ContextCompactionError.make({
						reason: "invalid-target",
						message: "The target must be a positive safe integer",
					})
				const view = yield* store.read(input.chat)
				if (
					input.expected !== undefined &&
					view.chat.revision !== input.expected
				)
					return yield* ContextCompaction.ContextCompactionError.make({
						reason: "head-conflict",
						message: "The Chat changed since it was read",
					})
				const selection = input.selection ?? view.chat.settings.model
				const service = compactionService
				if (selection === undefined || Option.isNone(service))
					return yield* ContextCompaction.ContextCompactionError.make({
						reason: "unsupported",
						message: "The current model has no compaction service or selection",
					})
				const compaction = service.value
				const model = yield* findModel(selection)
				const request = {
						...input.request,
						window: TurnState.windowFor(view.state.conversation.context, {
							...view.chat.settings,
							model: selection,
						}),
						selection,
					},
					beforeTokens = yield* compaction.count(request)
				if (
					Option.exists(
						Option.flatMap(model, ConfigurationOperations.contextLimits),
						(limits) => beforeTokens > limits.inputTokens,
					)
				)
					return yield* ContextCompaction.ContextCompactionError.make({
						reason: "input-too-large",
						message: "The full input is larger than the model context window",
					})
				const window = yield* pipe(
					model,
					Option.flatMapNullishOr((model) => model.compaction),
					Option.filter(Config.Compaction.$is("NonNative")),
					Option.match({
						onNone: () => compaction.compact(request),
						onSome: (configuration) =>
							Effect.gen(function* () {
								const summarySelection = configuration.model ?? selection
								const provider = Arr.findFirst(
									bot.providers ?? [],
									(provider) => provider.id === summarySelection.provider,
								)
								const summaryInput: ContextCompaction.NonNativeRequest = {
									prompt: request.window.prompt,
									targetTokens: input.targetTokens,
									...Rec.filter(
										{ keepRecentMessages: configuration.keepRecentMessages },
										Predicate.isNotUndefined,
									),
								}
								const program = (
									options.summarize === undefined
										? SummaryCompaction.compact(summaryInput)
										: options.summarize(summarySelection, summaryInput)
								).pipe(
									Effect.provideService(
										ContextWindow.CurrentWindow,
										ContextWindow.fromPrompt(Prompt.empty),
									),
								)
								if (Option.isSome(provider)) {
									const summaryModel =
										yield* provider.value.model(summarySelection)
									// @effect-diagnostics-next-line strictEffectProvide:off -- The host picks the summary model, and it is given to this one generation only.
									return yield* program.pipe(Effect.provide(summaryModel))
								}
								if (configuration.model !== undefined)
									return yield* ContextCompaction.ContextCompactionError.make({
										reason: "unsupported",
										message: "No provider is available for the summary model",
									})
								return yield* program.pipe(
									Effect.provideService(
										LanguageModel.LanguageModel,
										Context.get(services, LanguageModel.LanguageModel),
									),
								)
							}),
					}),
				)
				const afterTokens = yield* compaction.count({ ...request, window })
				if (afterTokens > input.targetTokens)
					return yield* ContextCompaction.ContextCompactionError.make({
						reason: "target-not-reached",
						message: `The compacted context has ${afterTokens} tokens, which is more than the target of ${input.targetTokens}`,
					})
				// Other changes can come during the compaction, such as new input in the
				// inbox. Only a change of the context makes the new window wrong.
				const committed = yield* store.modifyEffect({
					chat: input.chat,
					update: (current) =>
						Effect.gen(function* () {
							if (
								!Equal.equals(
									current.state.conversation.context,
									view.state.conversation.context,
								)
							)
								return yield* ContextCompaction.ContextCompactionError.make({
									reason: "head-conflict",
									message:
										"The context of the Chat changed during the compaction",
								})
							return [
								undefined,
								Option.some({
									value: {
										...current.state,
										conversation: {
											...current.state.conversation,
											context: window,
										},
									},
								}),
							] as const
						}),
				})
				return { view: committed.view, beforeTokens, afterTokens }
			})

		const run = (
			accepted: Accepted<P>,
			stopped: Ref.Ref<boolean>,
		): Stream.Stream<
			Event,
			| Chat.RuntimeError
			| Bot.ExecutionError<Tools, E | BuildE | ModelE | ToolE>,
			Bot.RuntimeServices<Tools, R>
		> =>
			Stream.scoped(
				Stream.unwrap(
					Effect.gen(function* () {
						const chatId = accepted.view.chat.id
						const turn = accepted.turn
						const turnRecord = yield* requireTurn(accepted.view, turn)
						const action = turnRecord.activeAction?.action ?? turnRecord.action
						const actionModel =
							action === undefined
								? undefined
								: yield* HostActionDriver.make({
										action,
										callId:
											"host-action-" + (turnRecord.activeAction?.item ?? turn),
									})

						const step = yield* Ref.make(0),
							history = yield* Ref.make(
								accepted.view.state.conversation.context.prompt,
							)
						const context = Bot.Context.of({
							options: {
								prompt: accepted.prompt,
								...(action === undefined ? {} : { action }),
								...Rec.filter(
									{
										toolChoice: bot.toolChoice,
										concurrency: bot.concurrency,
									},
									Predicate.isNotUndefined,
								),
							},
							at: store
								.read(chatId)
								.pipe(Effect.map((view) => Chat.position(view.chat))),
							turn: Effect.succeed(turn),
							step: Ref.get(step),
							history: Ref.get(history),
						})
						const resources = yield* RcRef.make({
							acquire: Effect.gen(function* () {
								const scope = yield* Effect.scope
								return yield* Effect.gen(function* () {
									const plugin = yield* build
									const registration: Bot.ToolRegistration<
										HostTools,
										E | BuildE,
										R
									> =
										bot.registerTools === undefined
											? {
													tools: {} as HostTools,
													handlers: Context.empty() as Context.Context<
														Tool.HandlersFor<HostTools>
													>,
													instructions: Prompt.empty,
												}
											: yield* bot.registerTools
									return Registration.merge(plugin, registration)
								}).pipe(
									Effect.provideService(Bot.Context, context),
									Effect.provideService(Scope.Scope, scope),
									Effect.provideContext(services),
								)
							}),
						})
						const registration = yield* RcRef.get(resources)
						// A background call holds the registration until its own Scope closes.
						yield* Effect.addFinalizer(() => RcRef.invalidate(resources))
						const next = <TK extends Toolkit.Any, ToolkitE, ToolkitR>(
							inner: Plugin.Options<TK, ToolkitE, ToolkitR>,
						) =>
							Stream.unwrap(
								Effect.gen(function* () {
									const supplied =
										suppliedTools === undefined
											? Toolkit.make()
											: Predicate.hasProperty(suppliedTools, "toHandlers")
												? suppliedTools
												: yield* suppliedTools
									const definitions: Toolkit.Any = Toolkit.merge(
										supplied,
										yield* inner.toolkit,
									)
									const toolkit = definitions as Toolkit.Toolkit<Tools>
									const raw = yield* toolkit
									const toolHandlers = Option.isNone(background)
										? raw
										: inBackground(raw, background.value.operations, {
												chat: chatId,
												turn,
												...(turnRecord.author === undefined
													? {}
													: { author: turnRecord.author }),
												notify: background.value.notify,
												retain: RcRef.get(resources).pipe(
													Effect.asVoid,
													Effect.orDie,
												),
											})
									const loop = (
										n: number,
									): Stream.Stream<
										Event,
										| Chat.RuntimeError
										| Bot.ExecutionError<
												Tools,
												E | BuildE | ModelE | ToolE | ToolkitE
										  >,
										R | Bot.Requirements<Tools, ToolkitR>
									> =>
										Stream.unwrap(
											Effect.gen(function* () {
												let view = yield* store.read(chatId)
												let record = yield* requireTurn(view, turn)
												if (Turn.isTerminal(record.status)) return Stream.empty
												// Only a model step reads steers. A host action does not ask
												// the model, so its steers wait for the end of the Turn.
												const injected =
													action === undefined &&
													record.pendingStep === undefined
														? Arr.filter(
																view.chat.inbox,
																(entry) =>
																	entry.kind === "steer" && entry.turn === turn,
															)
														: []
												if (injected.length > 0)
													view = (yield* store.modifyEffect({
														chat: chatId,
														update: (current) =>
															Effect.gen(function* () {
																const currentTurn = yield* requireOpenTurn(
																	current,
																	turn,
																)
																const entries = Arr.filter(
																	current.chat.inbox,
																	(entry) =>
																		Arr.some(
																			injected,
																			(selected) => selected.id === entry.id,
																		),
																)
																const items = yield* itemsOf(
																	chatId,
																	turn,
																	n,
																	entries,
																)
																return [
																	undefined,
																	Option.some({
																		...TurnState.append(current, items),
																		chat: {
																			inbox: Arr.filter(
																				current.chat.inbox,
																				(entry) =>
																					!Arr.some(
																						entries,
																						(selected) =>
																							selected.id === entry.id,
																					),
																			),
																			turn: {
																				...currentTurn,
																				items: [
																					...currentTurn.items,
																					...Arr.map(items, (item) => item.id),
																				],
																			},
																		},
																	}),
																] as const
															}),
													})).view
												record = yield* requireTurn(view, turn)
												const selection = record.settings.model
												const model =
													action === undefined
														? yield* findModel(selection)
														: Option.none()
												const instructions = Option.match(
													Option.flatMapNullishOr(
														model,
														(model) => model.instructionsTemplate,
													),
													{
														onNone: () => inner.instructions,
														onSome: (template) =>
															Prompt.concat(
																Prompt.make([
																	{ role: "system", content: template },
																]),
																inner.instructions,
															),
													},
												)
												if (
													inner.beforeStep !== undefined &&
													!(yield* inner.beforeStep({
														turn: record,
														step: n,
														kind: action === undefined ? "model" : "action",
														history:
															record.pendingStep?.input ??
															Prompt.concat(
																instructions,
																view.state.conversation.context.prompt,
															),
													}))
												) {
													yield* Ref.set(stopped, true)
													return Stream.empty
												}
												const compaction = compactionService
												const limits = Option.flatMap(
													model,
													ConfigurationOperations.contextLimits,
												)
												// The window of a model can come from its own setting or from its limit.
												if (
													action === undefined &&
													record.pendingStep === undefined &&
													selection !== undefined &&
													Option.isSome(model) &&
													Option.isSome(limits) &&
													Option.isSome(compaction)
												) {
													const request = {
														selection,
														window: view.state.conversation.context,
														toolkit,
														instructions,
														...Rec.filter(
															{ toolChoice: inner.toolChoice },
															Predicate.isNotUndefined,
														),
													}
													const tokens = yield* compaction.value.count(request),
														autoCompactTokens = limits.value.autoCompactTokens
													if (tokens > limits.value.inputTokens)
														return yield* ContextCompaction.ContextCompactionError.make(
															{
																reason: "input-too-large",
																message:
																	"The input is larger than the configured model context capacity",
															},
														)
													if (
														model.value.compaction !== undefined &&
														tokens >= autoCompactTokens
													) {
														const before = view
														view = yield* compact({
															chat: chatId,
															targetTokens: autoCompactTokens,
															selection,
															request,
														}).pipe(
															Effect.map((result) => result.view),
															// The context is still under the input limit, so the step can
															// go on without a smaller context.
															Effect.catchTag(
																"ContextCompactionError",
																(error) =>
																	Effect.logWarning(
																		"The context of a Chat could not get smaller",
																		error,
																	).pipe(Effect.as(before)),
															),
														)
													}
												}
												const window = view.state.conversation.context
												// A changed conversation must keep its messages, because the new
												// messages of this step are found by their position after it.
												const shown =
													inner.transformPrompt === undefined
														? window.prompt
														: yield* inner
																.transformPrompt(window.prompt)
																.pipe(
																	Effect.map((changed) =>
																		changed.content.length ===
																		window.prompt.content.length
																			? changed
																			: window.prompt,
																	),
																)
												const starting =
													record.pendingStep?.input ??
													Prompt.concat(instructions, shown)
												yield* Ref.set(history, starting)
												yield* Ref.set(step, action === undefined ? n : 0)
												const item =
														record.pendingStep?.item ??
														Item.Id.make(yield* id()),
													at = Chat.position(view.chat)
												const provider = Arr.findFirst(
													bot.providers ?? [],
													(provider) => provider.id === selection?.provider,
												)
												const nativeModel =
													action === undefined &&
													Option.isSome(provider) &&
													selection !== undefined
														? yield* provider.value.model(selection)
														: undefined
												const phase = StepRunner.make({
													...(options.executeTool === undefined
														? {}
														: { executeTool: options.executeTool }),
													...(action === undefined &&
													options.executeModel !== undefined
														? { executeModel: options.executeModel }
														: {}),
													store,
													chat: chatId,
													turn,
													step: n,
													item,
													prompt: starting,
													history,
													toolkit,
													handlers: toolHandlers,
													toolChoice:
														action === undefined ? inner.toolChoice : "auto",
													concurrency: inner.concurrency,
												})
												const nativeResponse = phase.stream.pipe(
													Stream.map(
														(part) =>
															({
																_tag: "ResponsePart",
																at,
																turn,
																step: action === undefined ? n : 0,
																item,
																part,
															}) as Event,
													),
												)
												// At this execution boundary, the selected provider provides only the model services.
												const response = (
													actionModel !== undefined
														? nativeResponse.pipe(
																Stream.provideService(
																	LanguageModel.LanguageModel,
																	actionModel,
																),
															)
														: nativeModel === undefined
															? nativeResponse
															: nativeResponse.pipe(Stream.provide(nativeModel))
												) as Stream.Stream<
													Event,
													| Chat.RuntimeError
													| Bot.ExecutionError<
															Tools,
															E | BuildE | ModelE | ToolE
													  >,
													R | Bot.Requirements<Tools>
												>
												const finish = Stream.unwrap(
													Effect.gen(function* () {
														const { model: completed, added } =
															yield* phase.result
														const text = Arr.join(
															Arr.flatMap(
																completed.output.content,
																(message) =>
																	message.role === "assistant"
																		? Arr.flatMap(message.content, (part) =>
																				part.type === "text" ? [part.text] : [],
																			)
																		: [],
															),
															"",
														)
														const finishReason = completed.finishReason
														const usage =
															action === undefined ? completed.usage : undefined
														const followUp = Arr.some(
															added.content,
															(message) =>
																message.role === "tool" &&
																Arr.some(
																	message.content,
																	(part) =>
																		part.type === "tool-result" &&
																		!part.providerExecuted,
																),
														)
														// A Turn never waits: each approval request gets an answer now.
														const open = ChatState.openApprovals(added)
														const decisions = yield* Effect.forEach(
															open,
															(request) =>
																decide({
																	chat: chatId,
																	turn,
																	approvalId: request.approvalId,
																	toolCall: request.toolCall,
																	...(record.author === undefined
																		? {}
																		: { author: record.author }),
																}).pipe(
																	Effect.map((decision) => ({
																		request,
																		decision,
																	})),
																),
														)
														const answers = Prompt.make(
															decisions.length === 0
																? []
																: [
																		{
																			role: "tool",
																			content: Arr.flatMap(
																				decisions,
																				({ request, decision }) =>
																					Match.value(decision).pipe(
																						Match.tagsExhaustive({
																							Allow: () => [
																								Prompt.toolApprovalResponsePart(
																									{
																										approvalId:
																											request.approvalId,
																										approved: true,
																									},
																								),
																							],
																							Deny: (decision) => [
																								Prompt.toolApprovalResponsePart(
																									{
																										approvalId:
																											request.approvalId,
																										approved: false,
																										...(decision.reason ===
																										undefined
																											? {}
																											: {
																													reason:
																														decision.reason,
																												}),
																									},
																								),
																							],
																							// A tool result next to the approval tells Effect AI that the
																							// call is done, so it never runs the tool handler.
																							Pending: (decision) => [
																								Prompt.toolApprovalResponsePart(
																									{
																										approvalId:
																											request.approvalId,
																										approved: true,
																									},
																								),
																								Prompt.toolResultPart({
																									id: request.toolCall.id,
																									name: request.toolCall.name,
																									isFailure: false,
																									result: decision.result,
																									providerExecuted: false,
																								}),
																							],
																						}),
																					),
																			),
																		},
																	],
														)
														const content = Prompt.concat(added, answers)
														const answered = decisions.length > 0

														if (inner.afterStep !== undefined)
															yield* inner.afterStep({
																chat: chatId,
																turn: record,
																step: n,
																kind: action === undefined ? "model" : "action",
																history: starting,
																output: content,
																finishReason,
															})
														const output = { text, finishReason }
														const {
															result: { stop, turn: ended },
															view: committed,
														} = yield* store.modifyEffect({
															chat: chatId,
															update: (current) =>
																Effect.gen(function* () {
																	const result = yield* TurnState.finishStep(
																		current,
																		{
																			turn,
																			item,
																			step: n,
																			content,
																			output,
																			model: action === undefined,
																			followUp,
																			answered,
																			...(usage === undefined ? {} : { usage }),
																			completedAt:
																				yield* Clock.currentTimeMillis,
																		},
																	)
																	return [
																		{ stop: result.stop, turn: result.turn },
																		Option.some(result.mutation),
																	] as const
																}),
														})
														return stop && ended.status._tag === "Running"
															? Stream.succeed(chatEvent(committed))
															: stop
																? Stream.make<ReadonlyArray<Event>>(
																		chatEvent(committed),
																		{
																			_tag: "TurnCompleted",
																			view: committed,
																			turn: ended,
																		},
																	)
																: Stream.concat(
																		Stream.succeed(chatEvent(committed)),
																		loop(n + 1),
																	)
													}),
												)
												return Stream.concat(
													action === undefined
														? Stream.succeed<Event>({
																_tag: "ModelStepStarted",
																at,
																turn,
																step: n,
															})
														: Stream.empty,
													Stream.concat(response, finish),
												).pipe(
													Stream.provideService(
														ContextWindow.CurrentWindow,
														window,
													),
												)
											}),
										)
									return loop(turnRecord.steps + 1).pipe(
										Stream.map(
											(event) => event as Bot.Event<Toolkit.MergedTools<[TK]>>,
										),
									)
								}),
							)
						const registered: Readonly<Record<string, Tool.Any>> =
							registration.tools
						const body = Stream.suspend(() =>
							next({
								...registration,
								...context.options,
								toolkit: Effect.succeed(
									Toolkit.make(...Rec.values(registered)),
								),
								instructions: registration.instructions ?? Prompt.empty,
							}).pipe(
								Stream.map((event) => event as Event),
								Stream.provideContext(registration.handlers),
							),
						)
						const limit = registration.timeLimit
						const limited =
							limit === undefined
								? body
								: Stream.unwrap(
										Effect.gen(function* () {
											const now = yield* Clock.currentTimeMillis
											const remaining =
												turnRecord.startedAt +
												Duration.toMillis(limit.duration) -
												now
											const expired = Ref.get(history).pipe(
												Effect.flatMap((history) =>
													Effect.fail(limit.error(history)),
												),
											)
											if (remaining <= 0) return yield* expired
											return body.pipe(
												Stream.interruptWhen(
													Effect.sleep(remaining).pipe(Effect.andThen(expired)),
												),
											)
										}),
									)
						return Bot.Context.provide(
							Stream.concat(
								Stream.make<ReadonlyArray<Event>>(chatEvent(accepted.view), {
									_tag: "TurnStarted",
									at: Chat.position(accepted.view.chat),
									turn,
								}),
								limited,
							),
							context,
						)
					}),
				),
			)
		const phases = (
			accepted: Accepted<P>,
		): Stream.Stream<
			Event,
			| Chat.RuntimeError
			| Bot.ExecutionError<Tools, E | BuildE | ModelE | ToolE>,
			never
		> =>
			Stream.unwrap(
				Effect.gen(function* () {
					const stopped = yield* Ref.make(false)
					const next = (
						phase: Accepted<P>,
					): Stream.Stream<
						Event,
						| Chat.RuntimeError
						| Bot.ExecutionError<Tools, E | BuildE | ModelE | ToolE>,
						Bot.RuntimeServices<Tools, R>
					> =>
						Stream.concat(
							run(phase, stopped),
							Stream.unwrap(
								Effect.gen(function* () {
									if (yield* Ref.get(stopped)) return Stream.empty
									const current = yield* store.read(phase.view.chat.id)
									const turn = yield* requireTurn(current, phase.turn)
									if (turn.status._tag !== "Running") return Stream.empty
									const changed = yield* store.modifyEffect({
										chat: current.chat.id,
										update: (view) =>
											Effect.gen(function* () {
												const turn = yield* requireTurn(view, phase.turn)
												const selected = Arr.findFirst(
													view.chat.inbox,
													(entry) =>
														entry.kind === "action" &&
														entry.turn === phase.turn &&
														entry.action !== undefined
															? Option.some({
																	pending: entry,
																	action: entry.action,
																})
															: Option.none(),
												)
												if (
													Option.isNone(selected) ||
													turn.status._tag !== "Running"
												)
													return [Option.none(), Option.none()] as const
												const { pending, action } = selected.value
												return [
													Option.some(pending),
													Option.some({
														...TurnState.append(
															view,
															[
																{
																	id: pending.id,
																	content: pending.content,
																	origin: {
																		chat: view.chat.id,
																		turn: phase.turn,
																		step: turn.steps,
																	},
																},
															],
															{ closed: false },
														),
														chat: {
															inbox: Arr.filter(
																view.chat.inbox,
																(entry) => entry.id !== pending.id,
															),
															turn: {
																...turn,
																activeAction: { item: pending.id, action },
																items: Arr.append(turn.items, pending.id),
															},
														},
													}),
												] as const
											}),
									})
									return Option.match(changed.result, {
										onNone: () => Stream.empty,
										onSome: (pending) =>
											next({
												view: changed.view,
												turn: phase.turn,
												item: pending.id,
												prompt: pending.content,
											}),
									})
								}),
							),
						)
					return next(accepted).pipe(Stream.provideContext(services))
				}),
			)

		return {
			run: phases,
			compact: (input: Parameters<typeof compact>[0]) =>
				compact(input).pipe(Effect.provideContext(services)),
		}
	})
