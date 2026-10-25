import {
	Array as A,
	Cause,
	Clock,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Layer,
	Match,
	Option,
	Predicate,
	PubSub,
	Record as R,
	Ref,
	Stream,
	Struct,
	SynchronizedRef,
	type Scope,
} from "effect"
import { dual } from "effect/Function"
import {
	AiError,
	Chat as AiChat,
	IdGenerator,
	LanguageModel,
	Prompt,
	Toolkit,
	type Tool,
	type Response,
} from "effect/ai"
import * as Chat from "./Chat.ts"
import * as HostActionDriver from "./HostActionDriver.ts"
import * as Turn from "./Turn.ts"
import * as Item from "./Item.ts"
import * as ChatState from "./ChatState.ts"
import * as Bot from "../bot/Bot.ts"
import type * as Config from "../models/Config.ts"
import * as ConfigurationOperations from "../models/ConfigurationOperations.ts"
import * as ContextWindow from "../context/ContextWindow.ts"
import * as ContextCompaction from "../context/ContextCompaction.ts"
import * as SummaryCompaction from "../context/SummaryCompaction.ts"
import { ChatStoreError } from "../store/ChatStore.ts"
import type * as ChatStore from "../store/ChatStore.ts"
import * as Plugin from "../plugins/Plugin.ts"
import * as PluginComposition from "../plugins/PluginComposition.ts"
import * as Operation from "./Operation.ts"
import * as Operations from "./Operations.ts"

/** What the model gets for a tool call that waits for a decision, when no host decides. */
const pendingResult = {
	pending: true,
	note: "This call waits for a decision. The answer comes back to this Chat as a message later.",
}
/** The first message of a window that was rebuilt for another model. */
const compactedNote =
	"Earlier messages of this Chat were compacted for another model, so they are not shown here."

/** Where a tool call of a Turn sends the end of its Operation. */
interface Background {
	readonly chat: Chat.Id
	readonly turn: Turn.Id
	readonly author?: Turn.Author
	readonly notify: (input: Chat.DeliverInput) => Effect.Effect<void>
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
					...(budget === undefined ? {} : { budget }),
					notify: (record) =>
						background.notify({
							chat: background.chat,
							input: Operations.noticeText(record),
							notice: { kind: "operation", ref: record.id },
							...(background.author === undefined
								? {}
								: { author: background.author }),
						}),
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
								onSome: (result) =>
									result.isFailure
										? Operation.Status.Failed({
												message: "The call failed.",
												result: result.encodedResult as never,
											})
										: Operation.Status.Completed({
												result: result.encodedResult as never,
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
interface Accepted<P> {
	readonly view: Chat.View<P>
	readonly turn: Turn.Id
	readonly item: Item.Id
	readonly prompt: Prompt.Prompt
}

export const make = <
	P = {},
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
	HostTools extends Record<string, Tool.Any> = {},
>(
	options: Chat.RuntimeOptions<P, Tools, E, R, BuildE, BuildR, HostTools>,
): Effect.Effect<
	Chat.Runtime<P, Tools, E, R, HostTools>,
	BuildE,
	BuildR | Scope.Scope
> =>
	Effect.gen(function* () {
		type Event = Bot.Event<
			Toolkit.MergedTools<[Toolkit.Toolkit<Tools>, Toolkit.Toolkit<HostTools>]>,
			P
		>
		const bot = options.bot
		const store = options.store
		const scope = yield* Effect.scope
		const basePlugin =
			bot.plugin ??
			Plugin.make({ id: Plugin.Id.make("@openbot-build/core/runtime-tools") })<
				Tools,
				E,
				R
			>(() =>
				Effect.succeed((next, input) =>
					next({
						...input,
						toolkit:
							bot.toolkit === undefined
								? input.toolkit
								: Predicate.hasProperty(bot.toolkit, "toHandlers")
									? Effect.succeed(bot.toolkit)
									: bot.toolkit,
					}),
				),
			)
		const hosted =
			bot.hostPlugin ??
			Plugin.make({
				id: Plugin.Id.make("@openbot-build/core/empty-host-tools"),
			})<HostTools>(() => Effect.succeed((next, input) => next(input)))
		const middleware = yield* PluginComposition.merge(basePlugin, hosted)
			.middleware

		const generator = Option.getOrElse(
			yield* Effect.serviceOption(IdGenerator.IdGenerator),
			() => IdGenerator.defaultIdGenerator,
		)
		const id = () => generator.generateId()
		// The services of the bot come first. Otherwise the host may provide them.
		const compactionService =
			bot.compaction === undefined
				? Effect.serviceOption(ContextCompaction.ContextCompaction)
				: Effect.succeedSome(bot.compaction)
		const approvals =
			bot.approvals === undefined
				? yield* Effect.serviceOption(Chat.Approvals)
				: Option.some(bot.approvals)
		const decide = (
			request: Chat.ApprovalRequest,
		): Effect.Effect<Chat.Decision> =>
			Option.match(approvals, {
				onNone: () =>
					Effect.succeed(Chat.Decision.Pending({ result: pendingResult })),
				onSome: (service) => service.decide(request),
			})
		const operations = yield* Effect.serviceOption(Operations.Operations)
		const findModel = (selection: Config.Selection | undefined) =>
			(bot.modelCatalog ?? Effect.succeed([])).pipe(
				Effect.map((models) =>
					models.find(
						(model) =>
							model.provider === selection?.provider &&
							model.id === selection?.model,
					),
				),
			)
		const active = yield* SynchronizedRef.make(
			HashMap.empty<
				Chat.Id,
				{
					readonly turn: Turn.Id
					readonly fiber: Fiber.Fiber<unknown, unknown>
				}
			>(),
		)
		const isActive = (chat: Chat.Id) =>
			SynchronizedRef.get(active).pipe(
				Effect.map((entries) => HashMap.has(entries, chat)),
			)
		const bus = yield* PubSub.unbounded<Event>()
		const activity = yield* PubSub.unbounded<Chat.Id>()
		yield* Effect.addFinalizer(() => PubSub.shutdown(bus))
		yield* Effect.addFinalizer(() => PubSub.shutdown(activity))
		// The latest events, so a new subscriber can catch up with recent revisions.
		const retained = yield* Ref.make<ReadonlyArray<Event>>([])
		const publish = (event: Event) =>
			Ref.update(retained, (events) =>
				A.takeRight(A.append(events, event), 64),
			).pipe(Effect.andThen(PubSub.publish(bus, event)), Effect.asVoid)
		const chatEvent = (view: Chat.View<P>): Event => ({
			_tag: "ChatUpdated",
			view,
		})
		yield* Effect.forkScoped(
			store
				.changes()
				.pipe(
					Stream.runForEach((change) =>
						change._tag === "Committed"
							? publish(chatEvent(change.view))
							: Effect.void,
					),
				),
			{ startImmediately: true },
		)
		const requireTurn = (view: Chat.View<P>, turn: Turn.Id) => {
			const current = Chat.currentTurn(view.chat)
			return current?.id === turn
				? Effect.succeed(current)
				: Effect.fail(
						new Turn.Conflict({
							chat: view.chat.id,
							turn,
							message: "The target Turn is no longer current",
						}),
					)
		}
		/** The changes that add Items to the log and to the window of the model. */
		const appending = (
			view: Chat.View<P>,
			entries: ReadonlyArray<Item.Entry>,
			conversation: Partial<ChatState.Conversation> = {},
		): Pick<ChatStore.Mutation<P>, "value" | "append"> => ({
			append: entries,
			value: {
				...view.state,
				conversation: {
					...view.state.conversation,
					context: ContextWindow.append(
						view.state.conversation.context,
						ChatState.promptOf(entries),
					),
					...conversation,
				},
			},
		})
		/**
		 * The Items for input from the inbox. An approved call also gets an assistant
		 * message with the call and a tool message with the approval, so the next model
		 * request runs the call without asking again.
		 */
		const itemsOf = (
			chat: Chat.Id,
			turn: Turn.Id,
			step: number,
			entries: ReadonlyArray<Chat.InboxEntry>,
		) =>
			Effect.forEach(entries, (entry) =>
				Effect.gen(function* () {
					const origin: Item.Origin = {
						chat,
						turn,
						step,
						...(entry.notice === undefined ? {} : { notice: entry.notice }),
					}
					const input: Item.Entry = {
						id: entry.id,
						content: entry.content,
						origin,
					}
					if (entry.approved === undefined) return [input]
					const call = entry.approved
					const approved: Item.Entry = {
						id: Item.Id.make(yield* id()),
						content: Prompt.make([
							{
								role: "assistant",
								content: [
									Prompt.toolCallPart({
										id: call.id,
										name: call.name,
										params: call.params,
										providerExecuted: false,
									}),
									Prompt.toolApprovalRequestPart({
										approvalId: call.id,
										toolCallId: call.id,
									}),
								],
							},
							{
								role: "tool",
								content: [
									Prompt.toolApprovalResponsePart({
										approvalId: call.id,
										approved: true,
									}),
								],
							},
						]),
						origin,
					}
					return [input, approved]
				}),
			).pipe(Effect.map(A.flatten))
		/** A window for the model of a Turn. A native window of another model is rebuilt. */
		const windowFor = (
			window: ChatState.Conversation["context"],
			settings: Turn.Settings,
		) =>
			Match.value(window).pipe(
				Match.tag("Native", (window) =>
					settings.model?.provider === window.provider &&
					settings.model.model === window.model
						? window
						: ContextWindow.fromPrompt(
								Prompt.concat(
									Prompt.make([{ role: "user", content: compactedNote }]),
									window.prompt,
								),
							),
				),
				Match.tag("Prompt", (window) => window),
				Match.exhaustive,
			)
		/**
		 * Starts a Turn in one atomic step. `select` picks the input from the inbox
		 * of the current Chat. It gives nothing when no Turn should start.
		 */
		const accept = (input: {
			readonly chat: Chat.Id
			readonly select: (
				view: Chat.View<P>,
			) => ReadonlyArray<Chat.InboxEntry> | undefined
			readonly author?: Turn.Author
			readonly overrides?: Partial<Turn.Settings>
			readonly action?: Turn.Action
			readonly expectedRevision?: Chat.Revision
		}) =>
			Effect.gen(function* () {
				const turn = Turn.Id.make(yield* id())
				const changed = yield* store.modifyEffect({
					chat: input.chat,
					...(input.expectedRevision === undefined
						? {}
						: { expectedRevision: input.expectedRevision }),
					update: (view) =>
						Effect.gen(function* () {
							if (HashMap.has(yield* SynchronizedRef.get(active), view.chat.id))
								return yield* new Chat.Conflict({
									chat: view.chat.id,
									message: "The previous Turn is still releasing its resources",
								})
							const previous = Chat.currentTurn(view.chat)
							if (previous !== undefined && !Turn.isTerminal(previous.status))
								return yield* new Chat.Conflict({
									chat: view.chat.id,
									message: "The Chat already has an unfinished Turn",
								})
							if (
								options.canStart !== undefined &&
								!(yield* options.canStart(view))
							)
								return yield* new Chat.Conflict({
									chat: view.chat.id,
									message: "Another process runs the Turns of this Chat",
								})
							const selected = input.select(view)
							if (selected === undefined || selected.length === 0)
								return [undefined, Option.none()] as const
							const author = input.author ?? selected[0]!.author
							const settings = { ...view.chat.settings, ...input.overrides }
							const items = yield* itemsOf(view.chat.id, turn, 0, selected)
							const record: Turn.Record = {
								...(input.action === undefined ? {} : { action: input.action }),
								...(author === undefined ? {} : { author }),
								id: turn,
								chat: view.chat.id,
								settings,
								status: Turn.StatusSchema.make({ _tag: "Running" }),
								steps: 0,
								input: selected.map((entry) => entry.id),
								items: items.map((item) => item.id),
								startedAt: yield* Clock.currentTimeMillis,
							}
							const window = windowFor(
								view.state.conversation.context,
								settings,
							)
							const prepared: Chat.View<P> = {
								...view,
								state: {
									...view.state,
									conversation: { ...view.state.conversation, context: window },
								},
							}
							const selectedIds = selected.map((entry) => entry.id)
							return [
								{ items, first: selected[0]!.id },
								Option.some({
									...appending(prepared, items, { closed: false }),
									chat: {
										turn: record,
										inbox: view.chat.inbox.filter(
											(entry) => !selectedIds.includes(entry.id),
										),
									},
								}),
							] as const
						}),
				})
				if (changed.result === undefined) return undefined
				const accepted: Accepted<P> = {
					view: changed.view,
					turn,
					item: changed.result.first,
					prompt: ChatState.promptOf(changed.result.items),
				}
				return accepted
			})
		const close = (chat: Chat.Id, turn: Turn.Id, status: Turn.Status) =>
			store
				.modifyEffect({
					chat,
					update: (view) =>
						Effect.gen(function* () {
							const current = yield* requireTurn(view, turn)
							if (Turn.isTerminal(current.status))
								return [false, Option.none()] as const
							// Record an unavailable result for each unanswered tool call before later input uses this history.
							const calls = ChatState.unansweredCalls(
								yield* store.items(chat, { turn }),
							)
							const completedAt = yield* Clock.currentTimeMillis
							const item = Item.Id.make(yield* id())
							const prompt = Prompt.make(
								HashMap.size(calls) === 0
									? []
									: [
											{
												role: "tool",
												content: Array.from(calls, ([id, call]) =>
													Prompt.toolResultPart({
														id,
														name: call.name,
														isFailure: true,
														providerExecuted: false,
														result:
															"The tool result is unavailable because its execution context ended.",
													}),
												),
											},
										],
							)
							const items: ReadonlyArray<Item.Entry> =
								prompt.content.length === 0
									? []
									: [
											{
												id: item,
												content: prompt,
												origin: { chat, turn, step: current.steps },
											},
										]
							return [
								true,
								Option.some({
									...appending(view, items, { closed: true }),
									chat: {
										// Input for this Turn that it did not read waits for the next Turn.
										inbox: view.chat.inbox.flatMap((entry) =>
											entry.turn !== turn
												? [entry]
												: entry.kind === "steer"
													? [
															{
																...Struct.omit(entry, ["turn"]),
																kind: "message" as const,
															},
														]
													: [],
										),
										turn: {
											...current,
											status,
											completedAt,
											items: [
												...current.items,
												...items.map((entry) => entry.id),
											],
										},
									},
								}),
							] as const
						}),
				})
				.pipe(
					Effect.tap(({ result, view }) =>
						result
							? publish({
									_tag: "TurnCompleted",
									view,
									turn: Chat.currentTurn(view.chat)!,
								})
							: Effect.void,
					),
					Effect.map(({ view }) => view),
				)
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
					return yield* new ContextCompaction.ContextCompactionError({
						reason: "invalid-target",
						message: "The target must be a positive safe integer",
					})
				const view = yield* store.read(input.chat)
				if (
					input.expected !== undefined &&
					view.chat.revision !== input.expected
				)
					return yield* new ContextCompaction.ContextCompactionError({
						reason: "head-conflict",
						message: "The Chat changed since it was read",
					})
				const selection = input.selection ?? view.chat.settings.model
				const service = yield* compactionService
				if (selection === undefined || Option.isNone(service))
					return yield* new ContextCompaction.ContextCompactionError({
						reason: "unsupported",
						message: "The current model has no compaction service or selection",
					})
				const compaction = service.value
				const model = yield* findModel(selection)
				const request = {
						...input.request,
						window: windowFor(view.state.conversation.context, {
							...view.chat.settings,
							model: selection,
						}),
						selection,
					},
					beforeTokens = yield* compaction.count(request)
				if (
					model !== undefined &&
					beforeTokens >
						(ConfigurationOperations.contextLimits(model).inputTokens ??
							Infinity)
				)
					return yield* new ContextCompaction.ContextCompactionError({
						reason: "input-too-large",
						message: "The full input is larger than the model context window",
					})
				const configuration = model?.compaction
				const window = yield* Match.value(configuration).pipe(
					Match.when({ _tag: "NonNative" }, (configuration) =>
						Effect.gen(function* () {
							const summarySelection = configuration.model ?? selection
							const provider = bot.providers?.find(
								(p) => p.id === summarySelection.provider,
							)
							const program = SummaryCompaction.compact({
								prompt: request.window.prompt,
								targetTokens: input.targetTokens,
								...R.filter(
									{ keepRecentMessages: configuration.keepRecentMessages },
									Predicate.isNotUndefined,
								),
							}).pipe(
								Effect.provideService(
									ContextWindow.CurrentWindow,
									ContextWindow.fromPrompt(Prompt.empty),
								),
							)
							if (provider !== undefined) {
								const summaryModel = yield* provider.model(summarySelection)
								// This boundary provides the host-selected summary model for one generation only.
								// @effect-diagnostics-next-line strictEffectProvide:off
								return yield* program.pipe(Effect.provide(summaryModel))
							}
							const languageModel =
								configuration.model === undefined
									? yield* Effect.serviceOption(LanguageModel.LanguageModel)
									: Option.none()
							if (Option.isNone(languageModel))
								return yield* new ContextCompaction.ContextCompactionError({
									reason: "unsupported",
									message:
										"No provider or LanguageModel is available for non-native compaction",
								})
							return yield* program.pipe(
								Effect.provideService(
									LanguageModel.LanguageModel,
									languageModel.value,
								),
							)
						}),
					),
					Match.orElse(() => compaction.compact(request)),
				)
				const afterTokens = yield* compaction.count({ ...request, window })
				if (afterTokens > input.targetTokens)
					return yield* new ContextCompaction.ContextCompactionError({
						reason: "target-not-reached",
						message: `The compacted context has ${afterTokens} tokens, which is more than the target of ${input.targetTokens}`,
					})
				const committed = yield* store.modifyEffect({
					chat: input.chat,
					expectedRevision: view.chat.revision,
					update: (current) =>
						Effect.succeed([
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
						] as const),
				})
				return { view: committed.view, beforeTokens, afterTokens }
			})

		const runner = (chat: Chat.Id, turn: Turn.Id) =>
			Effect.gen(function* () {
				const fiber = yield* Effect.fiber
				yield* Effect.acquireRelease(
					SynchronizedRef.modifyEffect(active, (entries) =>
						Effect.gen(function* () {
							if (HashMap.has(entries, chat))
								return yield* new Turn.Conflict({
									chat,
									turn,
									message: "The Chat already has an active runner",
								})
							return [
								undefined,
								HashMap.set(entries, chat, { turn, fiber }),
							] as const
						}),
					).pipe(Effect.tap(() => PubSub.publish(activity, chat))),
					() =>
						SynchronizedRef.update(active, (entries) =>
							HashMap.get(entries, chat).pipe(
								Option.exists((entry) => entry.fiber === fiber),
							)
								? HashMap.remove(entries, chat)
								: entries,
						).pipe(Effect.andThen(() => PubSub.publish(activity, chat))),
				)
			})
		const run = (
			accepted: Accepted<P>,
		): Stream.Stream<
			Event,
			Chat.RuntimeError | Bot.ExecutionError<Tools, E>,
			Bot.RuntimeServices<Tools, R>
		> =>
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
						chatRef = yield* Ref.make(
							yield* AiChat.fromPrompt(
								accepted.view.state.conversation.context.prompt,
							),
						)
					const context = Bot.Context.of({
						options: {
							prompt: accepted.prompt,
							...(action === undefined ? {} : { action }),
							...R.filter(
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
						history: Ref.get(chatRef).pipe(
							Effect.flatMap((chat) => Ref.get(chat.history)),
						),
					})
					const next: Plugin.Next<
						Chat.RuntimeError | Bot.ExecutionError<Tools, E>,
						R | Bot.Requirements<Tools, Tool.HandlersFor<Tools>>
					> = <TK extends Toolkit.Any, ToolkitE, ToolkitR>(
						inner: Plugin.Options<TK, ToolkitE, ToolkitR>,
					) =>
						Stream.unwrap(
							Effect.gen(function* () {
								const definitions: Toolkit.Any = yield* inner.toolkit
								const toolkit = definitions as Toolkit.Toolkit<Tools>
								const raw = yield* toolkit
								const services = yield* Effect.context<never>()
								const toolHandlers = Option.isNone(operations)
									? raw
									: inBackground(raw, operations.value, {
											chat: chatId,
											turn,
											...(turnRecord.author === undefined
												? {}
												: { author: turnRecord.author }),
											notify: (input) =>
												deliver(input).pipe(
													// The services are the ones of this Turn. The background call ends later.
													Effect.provideContext(
														services as Context.Context<
															Effect.Services<ReturnType<typeof deliver>>
														>,
													),
													Effect.catchCause((cause) =>
														Effect.logWarning(
															"The end of an Operation could not reach its Chat",
															cause,
														),
													),
													Effect.asVoid,
												),
										})
								const loop = (
									n: number,
								): Stream.Stream<
									Event,
									Chat.RuntimeError | Bot.ExecutionError<Tools, E | ToolkitE>,
									R | Bot.Requirements<Tools, ToolkitR>
								> =>
									Stream.unwrap(
										Effect.gen(function* () {
											let view = yield* store.read(chatId)
											let record = yield* requireTurn(view, turn)
											if (Turn.isTerminal(record.status)) return Stream.empty
											const injected = view.chat.inbox.filter(
												(entry) =>
													entry.kind === "steer" && entry.turn === turn,
											)
											if (injected.length > 0)
												view = (yield* store.modifyEffect({
													chat: chatId,
													update: (current) =>
														Effect.gen(function* () {
															const currentTurn = yield* requireTurn(
																current,
																turn,
															)
															const entries = current.chat.inbox.filter(
																(entry) =>
																	injected.some(
																		(selected) => selected.id === entry.id,
																	),
															)
															const items = yield* itemsOf(
																chatId,
																turn,
																action === undefined ? n : 0,
																entries,
															)
															return [
																undefined,
																Option.some({
																	...appending(current, items),
																	chat: {
																		inbox: current.chat.inbox.filter(
																			(entry) =>
																				!entries.some(
																					(selected) =>
																						selected.id === entry.id,
																				),
																		),
																		turn: {
																			...currentTurn,
																			items: [
																				...currentTurn.items,
																				...items.map((item) => item.id),
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
													: undefined
											const instructions =
												model?.instructionsTemplate === undefined
													? inner.instructions
													: Prompt.concat(
															Prompt.make([
																{
																	role: "system",
																	content: model.instructionsTemplate,
																},
															]),
															inner.instructions,
														)
											const compaction = yield* compactionService
											// The window of a model can come from its own setting or from its limit.
											if (
												action === undefined &&
												selection !== undefined &&
												model !== undefined &&
												ConfigurationOperations.contextLimits(model)
													.contextWindow !== undefined &&
												Option.isSome(compaction)
											) {
												const request = {
													selection,
													window: view.state.conversation.context,
													toolkit,
													instructions,
													...R.filter(
														{ toolChoice: inner.toolChoice },
														Predicate.isNotUndefined,
													),
												}
												const tokens = yield* compaction.value.count(request),
													limits = ConfigurationOperations.contextLimits(model),
													autoCompactTokens = limits.autoCompactTokens
												if (tokens > (limits.inputTokens ?? Infinity))
													return yield* new ContextCompaction.ContextCompactionError(
														{
															reason: "input-too-large",
															message:
																"The input is larger than the configured model context capacity",
														},
													)
												if (
													model.compaction !== undefined &&
													autoCompactTokens !== undefined &&
													tokens >= autoCompactTokens
												) {
													const before = view
													view = yield* compact({
														chat: chatId,
														expected: view.chat.revision,
														targetTokens: autoCompactTokens,
														selection,
														request,
													}).pipe(
														Effect.map((result) => result.view),
														// The context is still under the input limit, so the step can
														// go on without a smaller context.
														Effect.catchTag("ContextCompactionError", (error) =>
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
											const starting = Prompt.concat(instructions, shown)
											const chat = yield* AiChat.fromPrompt(starting)
											// An allowed call whose tool is not open in this step, for example
											// after a change to plan mode, does not run. Its result says so, and
											// the result is saved with the step.
											const missing =
												action === undefined
													? ChatState.withoutTool(
															shown,
															Object.keys(toolkit.tools),
														)
													: []
											if (missing.length > 0)
												yield* Ref.update(chat.history, (history) =>
													Prompt.concat(
														history,
														Prompt.make([
															{
																role: "tool",
																content: missing.map((call) =>
																	Prompt.toolResultPart({
																		id: call.id,
																		name: call.name,
																		isFailure: true,
																		result: {
																			error: `The call did not run, because the tool ${call.name} is not open now.`,
																		},
																		providerExecuted: false,
																	}),
																),
															},
														]),
													),
												)
											yield* Ref.set(chatRef, chat)
											yield* Ref.set(step, action === undefined ? n : 0)
											const item = Item.Id.make(yield* id()),
												at = Chat.position(view.chat)
											let text = "",
												finishReason: Response.FinishReason = "unknown",
												followUp = false,
												approval = false
											let received: ReadonlyArray<
												Response.StreamPart<Tools, "opaque">
											> = []
											let usage: Response.Usage | undefined
											const provider = bot.providers?.find(
												(provider) => provider.id === selection?.provider,
											)
											const nativeModel =
												action === undefined &&
												provider !== undefined &&
												selection !== undefined
													? yield* provider.model(selection)
													: undefined
											const nativeResponse = chat
												.streamText({
													prompt: Prompt.empty,
													toolkit: toolHandlers,
													toolChoice:
														action === undefined ? inner.toolChoice : "auto",
													concurrency: inner.concurrency,
												})
												.pipe(
													Stream.map((part): Event => {
														received = A.append(received, part)
														Match.value<
															Response.StreamPart<Record<string, Tool.Any>>
														>(part).pipe(
															Match.discriminator("type")(
																"text-delta",
																(part) => {
																	text += part.delta
																},
															),
															Match.discriminator("type")("finish", (part) => {
																finishReason = part.reason
																usage =
																	action === undefined ? part.usage : undefined
															}),
															Match.discriminator("type")(
																"tool-result",
																(part) => {
																	if (
																		!part.providerExecuted &&
																		!part.preliminary
																	)
																		followUp = true
																},
															),
															Match.discriminator("type")(
																"tool-approval-request",
																() => {
																	approval = true
																},
															),
															Match.orElse(() => {}),
														)
														return {
															_tag: "ResponsePart",
															at,
															turn,
															step: action === undefined ? n : 0,
															item,
															part,
														} as Event
													}),
												)
											// At this execution boundary, the selected provider provides only the model services.
											const response = (
												(actionModel !== undefined
													? nativeResponse.pipe(
															Stream.provideService(
																LanguageModel.LanguageModel,
																actionModel,
															),
														)
													: nativeModel === undefined
														? nativeResponse
														: nativeResponse.pipe(
																Stream.provide(nativeModel),
															)) as Stream.Stream<
													Event,
													Bot.ExecutionError<Tools, E>,
													R | Bot.Requirements<Tools>
												>
											).pipe(
												Stream.onExit((exit) =>
													Effect.gen(function* () {
														if (Exit.isSuccess(exit) || received.length === 0)
															return
														if (
															Option.exists(
																Cause.findErrorOption(exit.cause),
																(failure) => failure instanceof ChatStoreError,
															)
														)
															return
														const added = ChatState.resultsFirst(
															Prompt.fromResponseParts(received),
														)
														if (added.content.length === 0) return
														yield* store
															.modifyEffect({
																chat: chatId,
																update: (current) =>
																	Effect.gen(function* () {
																		const currentTurn = yield* requireTurn(
																			current,
																			turn,
																		)
																		if (currentTurn.items.includes(item))
																			return [undefined, Option.none()] as const
																		return [
																			undefined,
																			Option.some({
																				...appending(current, [
																					{
																						id: item,
																						content: added,
																						origin: {
																							chat: chatId,
																							turn,
																							step:
																								action === undefined ? n : 0,
																						},
																					},
																				]),
																				chat: {
																					turn: {
																						...currentTurn,
																						steps:
																							action === undefined
																								? n
																								: currentTurn.steps,
																						items: A.append(
																							currentTurn.items,
																							item,
																						),
																					},
																				},
																			}),
																		] as const
																	}),
															})
															.pipe(
																// Best effort: the step has already failed, and that failure must reach the caller.
																Effect.catchCause((cause) =>
																	Effect.logWarning(
																		"The partial model response could not be saved",
																		cause,
																	),
																),
															)
													}),
												),
											)
											const finish = Stream.unwrap(
												Effect.gen(function* () {
													const completed = yield* Ref.get(chat.history),
														added = ChatState.resultsFirst(
															Prompt.fromMessages(
																completed.content.slice(
																	starting.content.length,
																),
															),
														)
													// A Turn never waits: each approval request gets an answer now.
													const open = approval
														? ChatState.openApprovals(added)
														: []
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
																		content: decisions.flatMap(
																			({ request, decision }) =>
																				Match.value(decision).pipe(
																					Match.tagsExhaustive({
																						Allow: () => [
																							Prompt.toolApprovalResponsePart({
																								approvalId: request.approvalId,
																								approved: true,
																							}),
																						],
																						Deny: (decision) => [
																							Prompt.toolApprovalResponsePart({
																								approvalId: request.approvalId,
																								approved: false,
																								...(decision.reason ===
																								undefined
																									? {}
																									: {
																											reason: decision.reason,
																										}),
																							}),
																						],
																						// A tool result next to the approval tells Effect AI that the
																						// call is done, so it never runs the tool handler.
																						Pending: (decision) => [
																							Prompt.toolApprovalResponsePart({
																								approvalId: request.approvalId,
																								approved: true,
																							}),
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
													let stop =
														!answered &&
														(action !== undefined ||
															[
																"length",
																"content-filter",
																"error",
																"pause",
															].includes(finishReason) ||
															!followUp)
													const output = { text, finishReason }
													const committed = (yield* store.modifyEffect({
														chat: chatId,
														update: (current) =>
															Effect.gen(function* () {
																const currentTurn = yield* requireTurn(
																	current,
																	turn,
																)
																if (
																	!answered &&
																	![
																		"length",
																		"content-filter",
																		"error",
																		"pause",
																	].includes(finishReason) &&
																	current.chat.inbox.some(
																		(entry) =>
																			entry.kind === "steer" &&
																			entry.turn === turn,
																	)
																)
																	stop = false
																const moreActions = current.chat.inbox.some(
																	(entry) =>
																		entry.kind === "action" &&
																		entry.turn === turn,
																)
																const terminal = stop && !moreActions
																const now = yield* Clock.currentTimeMillis
																const status: Turn.Status = terminal
																	? { _tag: "Completed", result: output }
																	: { _tag: "Running" }
																return [
																	undefined,
																	Option.some({
																		...appending(
																			current,
																			[
																				{
																					id: item,
																					content,
																					origin: {
																						chat: chatId,
																						turn,
																						step: action === undefined ? n : 0,
																					},
																				},
																			],
																			{ closed: terminal },
																		),
																		chat: {
																			turn: {
																				...(answered
																					? currentTurn
																					: Struct.omit(currentTurn, [
																							"activeAction",
																						])),
																				status,
																				steps:
																					action === undefined
																						? n
																						: currentTurn.steps,
																				items: A.append(
																					currentTurn.items,
																					item,
																				),
																				usage:
																					usage === undefined
																						? (currentTurn.usage ?? [])
																						: [
																								...(currentTurn.usage ?? []),
																								usage,
																							],
																				...(terminal
																					? { completedAt: now }
																					: {}),
																			},
																		},
																	}),
																] as const
															}),
													})).view
													const ended = Chat.currentTurn(committed.chat)!
													return stop && ended.status._tag === "Running"
														? Stream.succeed(chatEvent(committed))
														: stop
															? Stream.make(chatEvent(committed), {
																	_tag: "TurnCompleted",
																	view: committed,
																	turn: ended,
																} as Event)
															: Stream.concat(
																	Stream.succeed(chatEvent(committed)),
																	loop(n + 1),
																)
												}),
											)
											return Stream.concat(
												action === undefined
													? Stream.succeed({
															_tag: "ModelStepStarted",
															at,
															turn,
															step: n,
														} as Event)
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
					const body = Stream.suspend(() =>
						middleware(next, {
							...context.options,
							toolkit: Effect.succeed(Toolkit.empty),
							instructions: Prompt.empty,
						}).pipe(Stream.map((event) => event as Event)),
					)
					return Bot.Context.provide(
						Stream.concat(
							Stream.make(chatEvent(accepted.view), {
								_tag: "TurnStarted",
								at: Chat.position(accepted.view.chat),
								turn,
							} as Event),
							body,
						),
						context,
					).pipe(
						Stream.tap((event) =>
							event._tag === "ChatUpdated" ? Effect.void : publish(event),
						),
						Stream.onExit((exit) =>
							Effect.gen(function* () {
								const latest = yield* store.read(chatId)
								const current = Chat.currentTurn(latest.chat)
								if (current?.id === turn && !Turn.isTerminal(current.status)) {
									const shouldClose =
										Exit.isFailure(exit) ||
										!latest.chat.inbox.some(
											(entry) => entry.kind === "action" && entry.turn === turn,
										)
									if (shouldClose)
										yield* close(
											chatId,
											turn,
											Exit.isSuccess(exit) ||
												Cause.hasInterruptsOnly(exit.cause)
												? { _tag: "Interrupted" }
												: {
														_tag: "Failed",
														code: Cause.hasDies(exit.cause)
															? "internal_error"
															: "model_error",
														message: Cause.pretty(exit.cause),
													},
										)
								}
							}).pipe(
								// Best effort: the host closes the Turn later if this cleanup cannot.
								Effect.catchCause((cause) =>
									Effect.logWarning(
										"The ended Turn could not be closed",
										cause,
									),
								),
							),
						),
					)
				}),
			)
		const phases = (
			accepted: Accepted<P>,
		): Stream.Stream<
			Event,
			Chat.RuntimeError | Bot.ExecutionError<Tools, E>,
			Bot.RuntimeServices<Tools, R>
		> => {
			const next = (
				phase: Accepted<P>,
			): Stream.Stream<
				Event,
				Chat.RuntimeError | Bot.ExecutionError<Tools, E>,
				Bot.RuntimeServices<Tools, R>
			> =>
				Stream.concat(
					run(phase),
					Stream.unwrap(
						Effect.gen(function* () {
							const current = yield* store.read(phase.view.chat.id)
							const turn = yield* requireTurn(current, phase.turn)
							if (turn.status._tag !== "Running") return Stream.empty
							const changed = yield* store.modifyEffect({
								chat: current.chat.id,
								update: (view) =>
									Effect.gen(function* () {
										const turn = yield* requireTurn(view, phase.turn)
										const selected = A.findFirst(view.chat.inbox, (entry) =>
											entry.kind === "action" &&
											entry.turn === phase.turn &&
											entry.action !== undefined
												? Option.some({ pending: entry, action: entry.action })
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
												...appending(
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
													inbox: view.chat.inbox.filter(
														(entry) => entry.id !== pending.id,
													),
													turn: {
														...turn,
														activeAction: { item: pending.id, action },
														items: A.append(turn.items, pending.id),
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
			return Stream.scoped(
				Stream.unwrap(
					runner(accepted.view.chat.id, accepted.turn).pipe(
						Effect.as(next(accepted)),
					),
				),
			)
		}
		/** Runs a Turn in the scope of the runtime. It returns when the Turn has started. */
		const launch = (
			accepted: Accepted<P>,
		): Effect.Effect<void, never, Bot.RuntimeServices<Tools, R>> =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				yield* Effect.forkIn(
					phases(accepted).pipe(
						Stream.tap((event) =>
							event._tag === "TurnStarted"
								? Deferred.succeed(started, undefined)
								: Effect.void,
						),
						Stream.runDrain,
						Effect.ensuring(Deferred.succeed(started, undefined)),
						// After any end, the next input in the inbox starts the next Turn.
						Effect.ensuring(drainQuietly(accepted.view.chat.id)),
					),
					scope,
				)
				yield* Deferred.await(started)
			})
		/** The first run of inbox messages that have the same author. */
		const leading = (view: Chat.View<P>) => {
			const messages = view.chat.inbox.filter(
				(entry) => entry.kind === "message",
			)
			const first = messages[0]
			if (first === undefined) return undefined
			const end = messages.findIndex((entry) => entry.author !== first.author)
			return end === -1 ? messages : messages.slice(0, end)
		}
		const drain: Chat.Runtime<P, Tools, E, R, HostTools>["drain"] = (chat) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					// While the runtime closes, its Turns stop and try to drain the inbox.
					// A fiber forked into the closed scope never starts, so `launch` would
					// wait for ever. The input stays in the inbox for the next runtime.
					if (scope.state._tag === "Closed") return undefined
					const view = yield* store.read(chat)
					const current = Chat.currentTurn(view.chat)
					if (
						(current !== undefined && !Turn.isTerminal(current.status)) ||
						(yield* isActive(chat)) ||
						leading(view) === undefined
					)
						return undefined
					const started = yield* restore(
						accept({ chat, select: leading }),
					).pipe(
						Effect.map(Option.fromUndefinedOr),
						// Another caller started a Turn first. Its end drains the inbox again.
						Effect.catchTag("ChatConflict", () => Effect.succeedNone),
					)
					if (Option.isNone(started)) return undefined
					const accepted = started.value
					yield* launch(accepted)
					const delivery: Chat.Delivery = {
						delivery: "started",
						chat,
						turn: accepted.turn,
						item: accepted.item,
						revision: accepted.view.chat.revision,
					}
					return delivery
				}),
			)
		const drainQuietly = (chat: Chat.Id) =>
			drain(chat).pipe(
				// A Turn that was stopped on purpose is not a problem. Other failures are.
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.void
						: Effect.logWarning("The next Turn could not start", cause),
				),
				Effect.asVoid,
			)
		const deliver: Chat.Runtime<P, Tools, E, R, HostTools>["deliver"] = (
			input,
		) =>
			Effect.gen(function* () {
				const item = Item.Id.make(yield* id())
				const entry: Chat.InboxEntry = {
					id: item,
					content: Prompt.make(input.input),
					kind: "message",
					...(input.author === undefined ? {} : { author: input.author }),
					...(input.notice === undefined ? {} : { notice: input.notice }),
					...(input.approved === undefined ? {} : { approved: input.approved }),
				}
				const placed = yield* store.modifyEffect({
					chat: input.chat,
					update: (view) =>
						Effect.sync(() => {
							const current = Chat.currentTurn(view.chat)
							const running =
								current !== undefined && current.status._tag === "Running"
							const placed: Chat.InboxEntry =
								running &&
								current.author === input.author &&
								input.queue !== true
									? { ...entry, kind: "steer", turn: current.id }
									: entry
							return [
								placed,
								Option.some({ chat: { inbox: [...view.chat.inbox, placed] } }),
							] as const
						}),
				})
				if (placed.result.kind === "steer") {
					const steered: Chat.Delivery = {
						delivery: "steered",
						chat: input.chat,
						turn: placed.result.turn!,
						item,
						revision: placed.view.chat.revision,
					}
					return steered
				}
				yield* drain(input.chat)
				const view = yield* store.read(input.chat)
				const current = Chat.currentTurn(view.chat)
				const result: Chat.Delivery =
					current !== undefined && current.input.includes(item)
						? {
								delivery: "started",
								chat: input.chat,
								turn: current.id,
								item,
								revision: view.chat.revision,
							}
						: {
								delivery: "queued",
								chat: input.chat,
								item,
								revision: view.chat.revision,
							}
				return result
			})
		const startEntry = (input: Chat.DeliverInput) =>
			Effect.map(id(), (item): Chat.InboxEntry => ({
				id: Item.Id.make(item),
				content: Prompt.make(input.input),
				kind: "message",
				...(input.author === undefined ? {} : { author: input.author }),
				...(input.notice === undefined ? {} : { notice: input.notice }),
				...(input.approved === undefined ? {} : { approved: input.approved }),
			}))
		const acceptNow = (input: Chat.StartInput, action?: Turn.Action) =>
			Effect.gen(function* () {
				const entry = yield* startEntry(input)
				const accepted = yield* accept({
					chat: input.chat,
					select: () => [entry],
					...(input.author === undefined ? {} : { author: input.author }),
					...(input.overrides === undefined
						? {}
						: { overrides: input.overrides }),
					...(action === undefined ? {} : { action }),
				})
				if (accepted === undefined)
					return yield* new Chat.Conflict({
						chat: input.chat,
						message: "The Turn could not start",
					})
				return accepted
			})
		const stream: Chat.Runtime<P, Tools, E, R, HostTools>["stream"] = (input) =>
			Stream.unwrap(
				acceptNow(input).pipe(
					Effect.map((accepted) =>
						phases(accepted).pipe(Stream.ensuring(drainQuietly(input.chat))),
					),
				),
			)
		const interrupt: Chat.Runtime<P, Tools, E, R, HostTools>["interrupt"] = (
			input,
		) =>
			Effect.gen(function* () {
				const view = yield* store.read(input.chat),
					turn = yield* requireTurn(view, input.turn)
				if (Turn.isTerminal(turn.status))
					return yield* new Turn.Conflict({
						chat: input.chat,
						turn: input.turn,
						message: "The Turn has already ended",
					})
				yield* Option.match(
					HashMap.get(yield* SynchronizedRef.get(active), input.chat).pipe(
						Option.filter((running) => running.turn === input.turn),
					),
					{
						onNone: () => Effect.void,
						onSome: (running) => Fiber.interrupt(running.fiber),
					},
				)
				// When the fiber stops, it closes the Turn, and the next input in the inbox
				// can start a new Turn at once. Then the target Turn is no longer current,
				// but it has ended, so this is not a conflict.
				return yield* close(input.chat, input.turn, {
					_tag: "Interrupted",
				}).pipe(Effect.catchTag("TurnConflict", () => store.read(input.chat)))
			})
		/** An event with a view takes its position from it. Other events carry `at`. */
		const positionOf = (event: Event) =>
			"view" in event ? Chat.position(event.view.chat) : event.at
		const revision = (event: Event) => positionOf(event).revision
		const events: Chat.Runtime<P, Tools, E, R, HostTools>["events"] = (input) =>
			Stream.unwrap(
				Effect.gen(function* () {
					yield* store.read(input.chat)
					const subscription = yield* PubSub.subscribe(bus)
					const snapshot = (yield* Ref.get(retained)).filter(
						(event) =>
							positionOf(event).chat === input.chat &&
							input.after !== undefined &&
							revision(event) > input.after,
					)
					return Stream.concat(
						Stream.fromArray(snapshot),
						Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(
							Stream.filter((event) => positionOf(event).chat === input.chat),
						),
					)
				}),
			)
		const wait: Chat.Runtime<P, Tools, E, R, HostTools>["wait"] = (input) =>
			Effect.scoped(
				Effect.gen(function* () {
					const observed = yield* Effect.forkChild(
						Effect.raceFirst(
							store
								.changes({ chat: input.chat })
								.pipe(Stream.take(1), Stream.runDrain),
							Stream.fromPubSub(activity).pipe(
								Stream.filter((chat) => chat === input.chat),
								Stream.take(1),
								Stream.runDrain,
							),
						),
						{ startImmediately: true },
					)
					const view = yield* store.read(input.chat)
					if (view.chat.revision !== input.after) return view
					if (
						input.afterActive !== undefined &&
						(yield* isActive(input.chat)) !== input.afterActive
					)
						return view
					yield* Fiber.join(observed).pipe(Effect.timeoutOption(input.timeout))
					return yield* store.read(input.chat)
				}),
			)
		const withActionDriver = <A, EX, RX>(
			action: Turn.Action,
			operation: Effect.Effect<A, EX, RX>,
		) =>
			Effect.gen(function* () {
				const existing = yield* Effect.serviceOption(
					LanguageModel.LanguageModel,
				)
				const driver = yield* Option.match(existing, {
					onSome: Effect.succeed,
					onNone: () =>
						HostActionDriver.make({ action, callId: "host-action" }),
				})
				return yield* operation.pipe(
					Effect.provideService(LanguageModel.LanguageModel, driver),
				)
			})
		const startAction: Chat.Runtime<
			P,
			Tools,
			E,
			R,
			HostTools
		>["startAction"] = (input) =>
			Effect.gen(function* () {
				const content = Prompt.make(
					input.input ?? "Host-selected action: " + input.action.name,
				)
				if (input.turn === undefined) {
					const accepted = yield* withActionDriver(
						input.action,
						Effect.uninterruptibleMask((restore) =>
							Effect.gen(function* () {
								const accepted = yield* restore(
									acceptNow(
										{
											chat: input.chat,
											input: content,
											...(input.author === undefined
												? {}
												: { author: input.author }),
										},
										input.action,
									),
								)
								yield* launch(accepted)
								return accepted
							}),
						),
					)
					const receipt: Chat.ActionReceipt = {
						chat: input.chat,
						turn: accepted.turn,
						item: accepted.item,
						revision: accepted.view.chat.revision,
						callId: "host-action-" + accepted.turn,
					}
					return receipt
				}
				const turn = input.turn
				const item = Item.Id.make(yield* id())
				const changed = yield* store.modifyEffect({
					chat: input.chat,
					update: (view) =>
						Effect.gen(function* () {
							const record = yield* requireTurn(view, turn)
							const running = HashMap.get(
								yield* SynchronizedRef.get(active),
								view.chat.id,
							)
							if (
								!Option.exists(running, (entry) => entry.turn === turn) ||
								Turn.isTerminal(record.status)
							)
								return yield* new Turn.Conflict({
									chat: view.chat.id,
									turn,
									message:
										"Related host actions need the current Turn to run in this runtime",
								})
							return [
								undefined,
								Option.some({
									chat: {
										inbox: A.append(view.chat.inbox, {
											id: item,
											kind: "action" as const,
											turn,
											action: input.action,
											content,
										}),
									},
								}),
							] as const
						}),
				})
				const receipt: Chat.ActionReceipt = {
					chat: input.chat,
					turn,
					item,
					revision: changed.view.chat.revision,
					callId: "host-action-" + item,
				}
				return receipt
			})
		return {
			isActive,
			deliver,
			stream,
			execute: (input) =>
				stream(input).pipe(
					Stream.runDrain,
					Effect.andThen(store.read(input.chat)),
				),
			startAction,
			interrupt,
			drain,
			status: store.read,
			events,
			wait,
			compact,
		}
	})
export const layer: {
	<
		P,
		Tools extends Record<string, Tool.Any> = {},
		E = never,
		R = never,
		BuildE = never,
		BuildR = never,
		HostTools extends Record<string, Tool.Any> = {},
	>(
		options: Chat.RuntimeOptions<P, Tools, E, R, BuildE, BuildR, HostTools>,
	): <I>(
		tag: Context.Service<I, Chat.Runtime<P, Tools, E, R, HostTools>>,
	) => Layer.Layer<I, BuildE, Exclude<BuildR, Scope.Scope>>
	<
		I,
		P,
		Tools extends Record<string, Tool.Any> = {},
		E = never,
		R = never,
		BuildE = never,
		BuildR = never,
		HostTools extends Record<string, Tool.Any> = {},
	>(
		tag: Context.Service<I, Chat.Runtime<P, Tools, E, R, HostTools>>,
		options: Chat.RuntimeOptions<P, Tools, E, R, BuildE, BuildR, HostTools>,
	): Layer.Layer<I, BuildE, Exclude<BuildR, Scope.Scope>>
} = dual(
	2,
	<
		I,
		P,
		Tools extends Record<string, Tool.Any> = {},
		E = never,
		R = never,
		BuildE = never,
		BuildR = never,
		HostTools extends Record<string, Tool.Any> = {},
	>(
		tag: Context.Service<I, Chat.Runtime<P, Tools, E, R, HostTools>>,
		options: Chat.RuntimeOptions<P, Tools, E, R, BuildE, BuildR, HostTools>,
	) => Layer.effect(tag, make(options)),
)
