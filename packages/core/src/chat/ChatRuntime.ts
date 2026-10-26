import {
	Array as Arr,
	Cause,
	Chunk,
	Clock,
	Context,
	Deferred,
	Effect,
	Equal,
	Exit,
	Fiber,
	FiberMap,
	FiberSet,
	HashMap,
	Layer,
	Match,
	Option,
	Predicate,
	PubSub,
	Queue,
	Record as Rec,
	Ref,
	Schema,
	Semaphore,
	Stream,
	Struct,
	pipe,
	Scope,
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
import * as Config from "../models/Config.ts"
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
import { logFailure } from "./Failures.ts"

/** What the model gets for a tool call that waits for a decision, when no host decides. */
export const pendingResult = {
	pending: true,
	note: "This call waits for a decision. The answer comes back to this Chat as a message later.",
}
/**
 * How many events wait for a slow subscriber. When more events come, the oldest
 * go, so a slow client cannot make memory grow without limit.
 */
const eventCapacity = 1024
/** How many recent events a new subscriber gets first, so it can catch up with recent revisions. */
const replayedEvents = 64
/** How many events of a Turn wait for a slow caller of `stream`. Then the Turn waits for it. */
const streamCapacity = 64
/**
 * Each start of a Turn holds one permit. The runtime takes all of them when it
 * closes, so it waits for the starts that are in progress.
 */
const admissionPermits = Number.MAX_SAFE_INTEGER
/** Finish reasons that end a Turn, also when input for the Turn waits. */
const turnEndingReasons: ReadonlyArray<Response.FinishReason> = [
	"length",
	"content-filter",
	"error",
	"pause",
]
const isJson = Schema.is(Schema.Json)

/**
 * The status of a Turn that failed. The message of a model failure is short and
 * safe to show. Other failures can hold private details, such as an error of the
 * database, so the status gets a fixed text, and the cause goes only to the log.
 */
const failedStatus = (cause: Cause.Cause<unknown>): Turn.Status => {
	const internal: Turn.Status = {
		_tag: "Failed",
		code: "internal_error",
		message: "The Turn stopped because of an internal error.",
	}
	if (Cause.hasDies(cause)) return internal
	return Option.match(Cause.findErrorOption(cause), {
		onNone: () => internal,
		onSome: (error): Turn.Status =>
			AiError.isAiError(error) ||
			Schema.is(ContextCompaction.ContextCompactionError)(error)
				? { _tag: "Failed", code: "model_error", message: error.message }
				: internal,
	})
}

/** The inbox after a Turn ends. Steers that the Turn did not read wait for the next Turn. */
const inboxAfter = (
	inbox: ReadonlyArray<Chat.InboxEntry>,
	turn: Turn.Id,
): ReadonlyArray<Chat.InboxEntry> =>
	Arr.flatMap(inbox, (entry) =>
		entry.turn !== turn
			? [entry]
			: entry.kind === "steer"
				? [{ ...Struct.omit(entry, ["turn"]), kind: "message" as const }]
				: [],
	)

/** What one model step has received so far. */
interface StepState<Tools extends Record<string, Tool.Any>> {
	readonly text: string
	readonly finishReason: Response.FinishReason
	/** A tool of the host gave a result, so the model must read it at the next step. */
	readonly followUp: boolean
	readonly approval: boolean
	readonly usage: Response.Usage | undefined
	/** Every part, so a step that fails can save what it received. */
	readonly received: Chunk.Chunk<Response.StreamPart<Tools, "opaque">>
}

/** Adds one part of the response to the state of a step. Only a model step keeps its usage. */
const stepWith = <Tools extends Record<string, Tool.Any>>(
	state: StepState<Tools>,
	part: Response.StreamPart<Tools, "opaque">,
	model: boolean,
): StepState<Tools> => {
	const next = { ...state, received: Chunk.append(state.received, part) }
	return Match.value<Response.StreamPart<Record<string, Tool.Any>>>(part).pipe(
		Match.discriminator("type")("text-delta", (part) => ({
			...next,
			text: next.text + part.delta,
		})),
		Match.discriminator("type")("finish", (part) => ({
			...next,
			finishReason: part.reason,
			usage: model ? part.usage : undefined,
		})),
		Match.discriminator("type")("tool-result", (part) =>
			!part.providerExecuted && !part.preliminary
				? { ...next, followUp: true }
				: next,
		),
		Match.discriminator("type")("tool-approval-request", () => ({
			...next,
			approval: true,
		})),
		Match.orElse(() => next),
	)
}

/** Where a tool call of a Turn sends the end of its Operation. */
interface Background {
	readonly chat: Chat.Id
	readonly turn: Turn.Id
	readonly author?: Turn.Author
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
	Chat.Runtime<P, Tools, E, HostTools>,
	BuildE,
	BuildR | R | Bot.RuntimeServices<Tools, R> | Scope.Scope
> =>
	Effect.gen(function* () {
		type Event = Bot.Event<
			Toolkit.MergedTools<[Toolkit.Toolkit<Tools>, Toolkit.Toolkit<HostTools>]>,
			P
		>
		const services = yield* Effect.context<R | Bot.RuntimeServices<Tools, R>>()
		const bot = options.bot
		const store = options.store
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
		const compactionService = Option.fromUndefinedOr(bot.compaction)
		const approvals = Option.fromUndefinedOr(bot.approvals)
		const decide = (
			request: Chat.ApprovalRequest,
		): Effect.Effect<Chat.Decision> =>
			Option.match(approvals, {
				onNone: () =>
					Effect.succeed(Chat.Decision.Pending({ result: pendingResult })),
				onSome: (service) => service.decide(request),
			})
		const operations = Option.fromUndefinedOr(options.operations)
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
		const bus = yield* PubSub.sliding<Event>({
			capacity: eventCapacity,
			replay: replayedEvents,
		})
		// A waiter subscribes before it reads the Chat, so it needs no old signals.
		const activity = yield* PubSub.sliding<Chat.Id>(eventCapacity)
		yield* Effect.addFinalizer(() => PubSub.shutdown(bus))
		yield* Effect.addFinalizer(() => PubSub.shutdown(activity))
		const scope = yield* Effect.scope
		const whileRunning = options.whileRunning ?? (() => Effect.void)
		const running = yield* FiberMap.make<Chat.Id>()
		const watchers = yield* FiberSet.make()
		/** True when the runtime closes. Then no Turn starts, and input waits in the inbox. */
		const closing = yield* Ref.make(false)
		const admission = yield* Semaphore.make(admissionPermits)
		const isActive = (chat: Chat.Id) => FiberMap.has(running, chat)
		const publish = (event: Event) =>
			PubSub.publish(bus, event).pipe(Effect.asVoid)
		const chatEvent = (view: Chat.View<P>): Event => ({
			_tag: "ChatUpdated",
			view,
		})
		yield* Effect.forkScoped(
			store.changes().pipe(
				Stream.runForEach((change) =>
					change._tag === "Committed"
						? publish(chatEvent(change.view))
						: Effect.void,
				),
				Effect.tapCause(logFailure("The listener for Chat changes stopped")),
			),
			{ startImmediately: true },
		)
		// The scope closes what it holds in the reverse order, so this runs first,
		// while the buses are open. After it, no Turn starts, and it waits for the
		// starts that are in progress. Then it stops the running Turns while their
		// watchers still run, so each watcher closes its Turn, also a Turn whose
		// fiber stopped before it ran.
		yield* Effect.addFinalizer(() =>
			Ref.set(closing, true).pipe(
				Effect.andThen(admission.withPermits(admissionPermits)(Effect.void)),
				Effect.andThen(FiberMap.clear(running)),
				Effect.andThen(FiberSet.awaitEmpty(watchers)),
			),
		)
		const requireTurn = (view: Chat.View<P>, turn: Turn.Id) => {
			const current = Chat.currentTurn(view.chat)
			return current?.id === turn
				? Effect.succeed(current)
				: Effect.fail(
						Turn.Conflict.make({
							chat: view.chat.id,
							turn,
							message: "The target Turn is no longer current",
						}),
					)
		}
		/**
		 * Like `requireTurn`, and the Turn must still run. Another process can end it,
		 * for example with an interrupt, and a write must not undo that end.
		 */
		const requireOpenTurn = (view: Chat.View<P>, turn: Turn.Id) =>
			Effect.gen(function* () {
				const current = yield* requireTurn(view, turn)
				if (Turn.isTerminal(current.status))
					return yield* Turn.Conflict.make({
						chat: view.chat.id,
						turn,
						message: "The Turn has already ended",
					})
				return current
			})
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
			).pipe(Effect.map(Arr.flatten))
		/** A native window cannot be sent to another model. Its Item log is portable. */
		const portableContext = (view: Chat.View<P>) =>
			Effect.gen(function* () {
				const window = view.state.conversation.context
				if (window._tag === "Prompt") return window.prompt
				const items = yield* store.items(view.chat.id, {
					before: view.chat.seq + 1,
					order: "asc",
				})
				if (
					items.length !== view.chat.seq ||
					!Arr.every(items, (item, index) => item.seq === index + 1) ||
					(view.chat.seq === 0 && window.items.length > 0)
				)
					return yield* Chat.ChatError.make({
						reason: "unavailable",
						message:
							"The full Item log is needed to use this context with another model",
					})
				return ChatState.promptOf(items)
			})
		const context: Chat.Runtime<P, Tools, E, HostTools>["context"] = (input) =>
			Effect.gen(function* () {
				const view = yield* store.read(input.chat)
				if (
					input.expected !== undefined &&
					input.expected !== view.chat.revision
				)
					return yield* Chat.Conflict.make({
						chat: input.chat,
						message: "The Chat revision is out of date",
					})
				const prompt = yield* portableContext(view)
				const current = yield* store.read(input.chat)
				if (current.chat.revision !== view.chat.revision)
					return yield* Chat.Conflict.make({
						chat: input.chat,
						message: "The Chat changed while its context was read",
					})
				return {
					chat: input.chat,
					revision: view.chat.revision,
					seq: view.chat.seq,
					prompt,
				}
			})
		/** A window for the model of a Turn. A native window of another model is rebuilt. */
		const windowFor = (view: Chat.View<P>, settings: Turn.Settings) => {
			const window = view.state.conversation.context
			return window._tag === "Native" &&
				settings.model?.provider === window.provider &&
				settings.model.model === window.model
				? Effect.succeed(window)
				: Effect.map(portableContext(view), ContextWindow.fromPrompt)
		}
		/**
		 * Starts a Turn in one atomic step. `select` picks the input from the inbox
		 * of the current Chat. It gives nothing when no Turn should start.
		 */
		const accept = (input: {
			readonly chat: Chat.Id
			readonly select: (
				view: Chat.View<P>,
			) => Option.Option<Arr.NonEmptyReadonlyArray<Chat.InboxEntry>>
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
							if (yield* Ref.get(closing))
								return yield* Chat.Conflict.make({
									chat: view.chat.id,
									message: "The runtime is closing",
								})
							if (yield* isActive(view.chat.id))
								return yield* Chat.Conflict.make({
									chat: view.chat.id,
									message: "The previous Turn is still releasing its resources",
								})
							const previous = Chat.currentTurn(view.chat)
							if (previous !== undefined && !Turn.isTerminal(previous.status))
								return yield* Chat.Conflict.make({
									chat: view.chat.id,
									message: "The Chat already has an unfinished Turn",
								})
							if (
								options.canStart !== undefined &&
								!(yield* options.canStart(view))
							)
								return yield* Chat.Conflict.make({
									chat: view.chat.id,
									message: "Another process runs the Turns of this Chat",
								})
							const selected = input.select(view)
							if (Option.isNone(selected))
								return [Option.none(), Option.none()] as const
							const head = Arr.headNonEmpty(selected.value)
							const author = input.author ?? head.author
							const settings = { ...view.chat.settings, ...input.overrides }
							const items = yield* itemsOf(
								view.chat.id,
								turn,
								0,
								selected.value,
							)
							const selectedIds = Arr.map(selected.value, (entry) => entry.id)
							const record: Turn.Record = {
								...(input.action === undefined ? {} : { action: input.action }),
								...(author === undefined ? {} : { author }),
								id: turn,
								chat: view.chat.id,
								settings,
								status: Turn.StatusSchema.make({ _tag: "Running" }),
								steps: 0,
								input: selectedIds,
								items: Arr.map(items, (item) => item.id),
								startedAt: yield* Clock.currentTimeMillis,
							}
							const window = yield* windowFor(view, settings)
							const prepared: Chat.View<P> = {
								...view,
								state: {
									...view.state,
									conversation: { ...view.state.conversation, context: window },
								},
							}
							return [
								Option.some({ items, first: head.id }),
								Option.some({
									...appending(prepared, items, { closed: false }),
									chat: {
										turn: record,
										inbox: Arr.filter(
											view.chat.inbox,
											(entry) => !selectedIds.includes(entry.id),
										),
									},
								}),
							] as const
						}),
				})
				return Option.map(changed.result, (result): Accepted<P> => ({
					view: changed.view,
					turn,
					item: result.first,
					prompt: ChatState.promptOf(result.items),
				}))
			})
		const close = (chat: Chat.Id, turn: Turn.Id, status: Turn.Status) =>
			store
				.modifyEffect({
					chat,
					update: (view) =>
						Effect.gen(function* () {
							const current = yield* requireTurn(view, turn)
							if (Turn.isTerminal(current.status))
								return [Option.none(), Option.none()] as const
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
							const closed: Turn.Record = {
								...current,
								status,
								completedAt,
								items: [
									...current.items,
									...Arr.map(items, (entry) => entry.id),
								],
							}
							return [
								Option.some(closed),
								Option.some({
									...appending(view, items, { closed: true }),
									chat: {
										inbox: inboxAfter(view.chat.inbox, turn),
										turn: closed,
									},
								}),
							] as const
						}),
				})
				.pipe(
					Effect.tap(({ result, view }) =>
						Option.match(result, {
							onNone: () => Effect.void,
							onSome: (turn) => publish({ _tag: "TurnCompleted", view, turn }),
						}),
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
						window: yield* windowFor(view, {
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
								const program = SummaryCompaction.compact({
									prompt: request.window.prompt,
									targetTokens: input.targetTokens,
									...Rec.filter(
										{ keepRecentMessages: configuration.keepRecentMessages },
										Predicate.isNotUndefined,
									),
								}).pipe(
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
								const toolHandlers = Option.isNone(operations)
									? raw
									: inBackground(raw, operations.value, {
											chat: chatId,
											turn,
											...(turnRecord.author === undefined
												? {}
												: { author: turnRecord.author }),
											notify: deliver,
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
											// Only a model step reads steers. A host action does not ask
											// the model, so its steers wait for the end of the Turn.
											const injected =
												action === undefined
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
																	...appending(current, items),
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
											const compaction = compactionService
											const limits = Option.flatMap(
												model,
												ConfigurationOperations.contextLimits,
											)
											// The window of a model can come from its own setting or from its limit.
											if (
												action === undefined &&
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
															Rec.keys(toolkit.tools),
														)
													: []
											if (missing.length > 0)
												yield* Ref.update(chat.history, (history) =>
													Prompt.concat(
														history,
														Prompt.make([
															{
																role: "tool",
																content: Arr.map(missing, (call) =>
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
											const state = yield* Ref.make<StepState<Tools>>({
												text: "",
												finishReason: "unknown",
												followUp: false,
												approval: false,
												usage: undefined,
												received: Chunk.empty(),
											})
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
											const nativeResponse = chat
												.streamText({
													prompt: Prompt.empty,
													toolkit: toolHandlers,
													toolChoice:
														action === undefined ? inner.toolChoice : "auto",
													concurrency: inner.concurrency,
												})
												.pipe(
													Stream.tap((part) =>
														Ref.update(state, (current) =>
															stepWith(current, part, action === undefined),
														),
													),
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
														const { received } = yield* Ref.get(state)
														if (Exit.isSuccess(exit) || Chunk.isEmpty(received))
															return
														if (
															Option.exists(
																Cause.findErrorOption(exit.cause),
																Schema.is(ChatStoreError),
															)
														)
															return
														const added = ChatState.resultsFirst(
															Prompt.fromResponseParts(
																Chunk.toReadonlyArray(received),
															),
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
																		// A Turn that ended, for example by an interrupt from
																		// another process, gets no more Items.
																		if (
																			Turn.isTerminal(currentTurn.status) ||
																			currentTurn.items.includes(item)
																		)
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
																						items: Arr.append(
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
																Effect.catchCause(
																	logFailure(
																		"The partial model response could not be saved",
																	),
																),
															)
													}),
												),
											)
											const finish = Stream.unwrap(
												Effect.gen(function* () {
													const {
														text,
														finishReason,
														followUp,
														approval,
														usage,
													} = yield* Ref.get(state)
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
																		content: Arr.flatMap(
																			decisions,
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
													const endsTurn = Arr.contains(
														turnEndingReasons,
														finishReason,
													)
													const wouldStop =
														!answered &&
														(action !== undefined || endsTurn || !followUp)
													const output = { text, finishReason }
													const {
														result: { stop, turn: ended },
														view: committed,
													} = yield* store.modifyEffect({
														chat: chatId,
														update: (current) =>
															Effect.gen(function* () {
																const currentTurn = yield* requireOpenTurn(
																	current,
																	turn,
																)
																// A steer keeps the Turn going, so the model reads it at
																// the next step. A host action does not read steers.
																const steered =
																	action === undefined &&
																	Arr.some(
																		current.chat.inbox,
																		(entry) =>
																			entry.kind === "steer" &&
																			entry.turn === turn,
																	)
																const stop = wouldStop && (endsTurn || !steered)
																const moreActions = Arr.some(
																	current.chat.inbox,
																	(entry) =>
																		entry.kind === "action" &&
																		entry.turn === turn,
																)
																const terminal = stop && !moreActions
																const now = yield* Clock.currentTimeMillis
																const status: Turn.Status = terminal
																	? { _tag: "Completed", result: output }
																	: { _tag: "Running" }
																const nextTurn: Turn.Record = {
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
																	items: Arr.append(currentTurn.items, item),
																	usage:
																		usage === undefined
																			? (currentTurn.usage ?? [])
																			: [...(currentTurn.usage ?? []), usage],
																	...(terminal ? { completedAt: now } : {}),
																}
																return [
																	{ stop, turn: nextTurn },
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
																			turn: nextTurn,
																			...(terminal
																				? {
																						inbox: inboxAfter(
																							current.chat.inbox,
																							turn,
																						),
																					}
																				: {}),
																		},
																	}),
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
					const body = Stream.suspend(() =>
						middleware(next, {
							...context.options,
							toolkit: Effect.succeed(Toolkit.empty),
							instructions: Prompt.empty,
						}).pipe(Stream.map((event) => event as Event)),
					)
					return Bot.Context.provide(
						Stream.concat(
							Stream.make<ReadonlyArray<Event>>(chatEvent(accepted.view), {
								_tag: "TurnStarted",
								at: Chat.position(accepted.view.chat),
								turn,
							}),
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
										!Arr.some(
											latest.chat.inbox,
											(entry) => entry.kind === "action" && entry.turn === turn,
										)
									// `phases` logs a failure once, so this only closes the Turn.
									if (shouldClose)
										yield* close(
											chatId,
											turn,
											Exit.isSuccess(exit) ||
												Cause.hasInterruptsOnly(exit.cause)
												? { _tag: "Interrupted" }
												: failedStatus(exit.cause),
										)
								}
							}).pipe(
								// Best effort: the end of the phases, the watcher of the Turn, or
								// else the host closes the Turn later if this cleanup cannot.
								Effect.catchCause(
									logFailure("The ended Turn could not be closed"),
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
			never
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
										const selected = Arr.findFirst(view.chat.inbox, (entry) =>
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
			// Every failure of the Turn ends here, also one between two phases, and
			// one of a Turn that no caller waits for. So this logs it once, with its
			// cause, and closes the Turn if no phase did.
			return next(accepted).pipe(
				Stream.provideContext(services),
				Stream.onExit((exit) =>
					Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)
						? Effect.void
						: Effect.logWarning("A Turn failed", exit.cause).pipe(
								Effect.andThen(
									close(
										accepted.view.chat.id,
										accepted.turn,
										failedStatus(exit.cause),
									),
								),
								// A later Turn is current.
								Effect.catchTag("TurnConflict", () => Effect.void),
								Effect.catchCause(
									logFailure("The ended Turn could not be closed"),
								),
							),
				),
			)
		}
		/**
		 * Runs a Turn in its own fiber. A Chat has one such fiber at most, and the
		 * runtime stops them all when it closes. A watcher waits for the end of the
		 * fiber, when the Chat is no longer active. It closes the Turn if the fiber
		 * did not, tells the waiters, and starts the next Turn from the inbox.
		 *
		 * The fiber can stop before it runs any work, so a caller that waits for
		 * the Turn must also wait for the end of the fiber.
		 *
		 * The caller holds a permit of `admission` from `accept` to the end of this,
		 * so the runtime does not close between the two.
		 */
		const start = <EW, RW>(
			accepted: Accepted<P>,
			work: Effect.Effect<void, EW, RW>,
		) =>
			Effect.gen(function* () {
				const chat = accepted.view.chat.id
				// Every log line of the Turn and of its watcher names the Chat and the Turn.
				const annotations = { chatId: chat, turnId: accepted.turn }
				// The host part holds until the watcher ends. Its scope belongs to the
				// runtime, so it also closes when the runtime closes first.
				const held = yield* Scope.fork(scope)
				yield* whileRunning(chat).pipe(Scope.provide(held))
				// `accept` found no fiber for the Chat. But a Turn can end before its fiber
				// starts, and a newer Turn can start in that time. Then the second fiber
				// does not run, and its watcher closes its Turn if it is still open.
				// The fiber starts only when it is in the map, so the Chat is active
				// before the Turn does any work.
				const turn = yield* FiberMap.run(
					running,
					chat,
					work.pipe(Effect.annotateLogs(annotations)),
					{ onlyIfMissing: true, startImmediately: false },
				)
				yield* PubSub.publish(activity, chat)
				const watcher = yield* FiberSet.run(
					watchers,
					Fiber.await(turn).pipe(
						Effect.andThen(
							close(chat, accepted.turn, { _tag: "Interrupted" }).pipe(
								// A later Turn is current.
								Effect.catchTag("TurnConflict", () => Effect.void),
								Effect.catchCause(
									logFailure("The ended Turn could not be closed"),
								),
							),
						),
						Effect.andThen(PubSub.publish(activity, chat)),
						// After any end, the next input in the inbox starts the next Turn.
						Effect.andThen(drainQuietly(chat)),
						Effect.ensuring(Scope.close(held, Exit.void)),
						Effect.annotateLogs(annotations),
					),
				)
				return { turn, watcher }
			})
		/**
		 * Runs a Turn in the background. `untilStarted` waits until it has started,
		 * so the caller can let its permit go before it waits.
		 */
		const launch = (accepted: Accepted<P>) =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const { turn } = yield* start(
					accepted,
					phases(accepted).pipe(
						Stream.runForEach((event) =>
							event._tag === "TurnStarted"
								? Deferred.succeed(started, undefined)
								: Effect.void,
						),
					),
				)
				return { started, turn }
			})
		const untilStarted = (launched: {
			readonly started: Deferred.Deferred<void>
			readonly turn: Fiber.Fiber<void, unknown>
		}) =>
			Effect.asVoid(
				Effect.raceFirst(
					Deferred.await(launched.started),
					Fiber.await(launched.turn),
				),
			)
		/** The first active message, with this author's waiting context and next messages. */
		const leading = (
			view: Chat.View<P>,
		): Option.Option<Arr.NonEmptyReadonlyArray<Chat.InboxEntry>> => {
			const messages = Arr.filter(
				view.chat.inbox,
				(entry) => entry.kind === "message",
			)
			return Option.flatMap(
				Arr.findFirstIndex(messages, (entry) => entry.passive !== true),
				(index) => {
					const head = messages[index]!
					const before = Arr.filter(
						Arr.take(messages, index),
						(entry) => entry.author === head.author,
					)
					const after = Arr.takeWhile(
						Arr.drop(messages, index + 1),
						(entry) => entry.author === head.author,
					)
					return Option.some(Arr.appendAll(before, Arr.prepend(after, head)))
				},
			)
		}
		const drain: Chat.Runtime<P, Tools, E, HostTools>["drain"] = (chat) =>
			Effect.gen(function* () {
				// A quick check first. `accept` checks the same things again in one step.
				const view = yield* store.read(chat)
				const current = Chat.currentTurn(view.chat)
				if (
					(current !== undefined && !Turn.isTerminal(current.status)) ||
					(yield* isActive(chat)) ||
					Option.isNone(leading(view))
				)
					return Option.none()
				return yield* Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						const started = yield* admission.withPermits(1)(
							Effect.gen(function* () {
								const accepted = yield* restore(
									accept({ chat, select: leading }),
								).pipe(
									// Another caller started a Turn first, and its end drains the inbox
									// again. Or the runtime closes, and the input waits for the next one.
									Effect.catchTag("ChatConflict", () => Effect.succeedNone),
								)
								if (Option.isNone(accepted)) return Option.none()
								const launched = yield* launch(accepted.value)
								return Option.some({ accepted: accepted.value, launched })
							}),
						)
						if (Option.isNone(started)) return Option.none()
						const { accepted, launched } = started.value
						yield* untilStarted(launched)
						const delivery: Chat.Delivery = {
							delivery: "started",
							chat,
							turn: accepted.turn,
							item: accepted.item,
							revision: accepted.view.chat.revision,
						}
						return Option.some(delivery)
					}),
				)
			})
		const drainQuietly = (chat: Chat.Id) =>
			drain(chat).pipe(
				Effect.catchCause(logFailure("The next Turn could not start")),
				Effect.asVoid,
				Effect.annotateLogs({ chatId: chat }),
			)
		/** The inbox entry for input that a caller gives. */
		const entryOf = (input: Chat.DeliverInput) =>
			Effect.map(id(), (item): Chat.InboxEntry => ({
				id: Item.Id.make(item),
				content: Prompt.make(input.input),
				kind: "message",
				...(input.author === undefined ? {} : { author: input.author }),
				...(input.notice === undefined ? {} : { notice: input.notice }),
				...(input.approved === undefined ? {} : { approved: input.approved }),
				...(input.passive === true ? { passive: true } : {}),
			}))
		const deliver: Chat.Runtime<P, Tools, E, HostTools>["deliver"] = (input) =>
			Effect.gen(function* () {
				const entry = yield* entryOf(input)
				const item = entry.id
				const placed = yield* store
					.modifyEffect({
						chat: input.chat,
						...(input.expected === undefined
							? {}
							: { expectedRevision: input.expected }),
						update: (view) =>
							Effect.sync(() => {
								const current = Chat.currentTurn(view.chat)
								const steer =
									current !== undefined &&
									current.status._tag === "Running" &&
									current.author === input.author &&
									input.passive !== true &&
									input.queue !== true
										? Option.some(current.id)
										: Option.none()
								const stored: Chat.InboxEntry = Option.match(steer, {
									onNone: () => entry,
									onSome: (turn) => ({ ...entry, kind: "steer", turn }),
								})
								return [
									steer,
									Option.some({
										chat: { inbox: [...view.chat.inbox, stored] },
									}),
								] as const
							}),
					})
					.pipe(
						// This conflict is safe to retry: the inbox write did not commit.
						Effect.catchTag(
							"ChatStoreError",
							(
								error,
							): Effect.Effect<
								never,
								ChatStore.ChatStoreError | Chat.Conflict
							> =>
								error.reason === "reference-conflict"
									? Effect.fail(
											Chat.Conflict.make({
												chat: input.chat,
												message: "The Chat changed before this input was saved",
											}),
										)
									: Effect.fail(error),
						),
					)
				if (Option.isSome(placed.result)) {
					const steered: Chat.Delivery = {
						delivery: "steered",
						chat: input.chat,
						turn: placed.result.value,
						item,
						revision: placed.view.chat.revision,
					}
					return steered
				}
				if (input.passive !== true) yield* drain(input.chat)
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
		const acceptNow = (input: Chat.StartInput, action?: Turn.Action) =>
			Effect.gen(function* () {
				const entry = yield* entryOf(input)
				const accepted = yield* accept({
					chat: input.chat,
					...(input.expected === undefined
						? {}
						: { expectedRevision: input.expected }),
					select: () => Option.some(Arr.of(entry)),
					...(input.author === undefined ? {} : { author: input.author }),
					...(input.overrides === undefined
						? {}
						: { overrides: input.overrides }),
					...(action === undefined ? {} : { action }),
				})
				if (Option.isNone(accepted))
					return yield* Chat.Conflict.make({
						chat: input.chat,
						message: "The Turn could not start",
					})
				return accepted.value
			})
		const stream: Chat.Runtime<P, Tools, E, HostTools>["stream"] = (input) =>
			Stream.unwrap(
				Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						const { turn, watcher, events } = yield* admission.withPermits(1)(
							Effect.gen(function* () {
								const accepted = yield* restore(acceptNow(input))
								const events = yield* Queue.bounded<
									Event,
									Chat.RuntimeError | Bot.ExecutionError<Tools, E> | Cause.Done
								>(streamCapacity)
								const { turn, watcher } = yield* start(
									accepted,
									phases(accepted).pipe(Stream.runIntoQueue(events)),
								)
								return { turn, watcher, events }
							}),
						)
						const stop = Fiber.interrupt(turn).pipe(
							Effect.andThen(Fiber.await(watcher)),
						)
						// The caller can stop before it reads the stream, also while the Turn
						// starts. The scope of the stream still closes then, so this stops the Turn.
						yield* Effect.addFinalizer(() => stop)
						return Stream.merge(
							Stream.fromQueue(events),
							// The fiber ends the queue. When it stops before it runs, its
							// end ends the queue here.
							Stream.fromEffectDrain(
								Effect.flatMap(Fiber.await(turn), (exit) =>
									Queue.into(events)(exit),
								),
							),
						).pipe(
							// A caller that stops early stops the Turn. The stream ends after
							// the watcher, so input that waits in the inbox has started its
							// Turn by then.
							Stream.ensuring(stop),
						)
					}),
				),
			)
		const interrupt: Chat.Runtime<P, Tools, E, HostTools>["interrupt"] = (
			input,
		) =>
			Effect.gen(function* () {
				// Keep this fiber, not just the Chat ID. The next Turn may start while the
				// stored Turn is being read, and an old stop must never stop that new work.
				const active = yield* FiberMap.get(running, input.chat)
				const view = yield* store.read(input.chat),
					turn = yield* requireTurn(view, input.turn)
				if (Turn.isTerminal(turn.status))
					return yield* Turn.Conflict.make({
						chat: input.chat,
						turn: input.turn,
						message: "The Turn has already ended",
					})
				if (Option.isSome(active)) yield* Fiber.interrupt(active.value)
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
		const events: Chat.Runtime<P, Tools, E, HostTools>["events"] = (input) =>
			Stream.unwrap(
				Effect.gen(function* () {
					yield* store.read(input.chat)
					const subscription = yield* PubSub.subscribe(bus)
					// The subscription gives the replay first: the recent events from before
					// it began. Later events come once, after them.
					const recent = yield* PubSub.takeUpTo(
						subscription,
						yield* PubSub.remaining(subscription),
					)
					return Stream.concat(
						Stream.fromArray(
							Arr.filter(
								recent,
								(event) =>
									positionOf(event).chat === input.chat &&
									input.after !== undefined &&
									revision(event) > input.after,
							),
						),
						Stream.fromSubscription(subscription).pipe(
							Stream.filter((event) => positionOf(event).chat === input.chat),
						),
					)
				}),
			)
		const wait: Chat.Runtime<P, Tools, E, HostTools>["wait"] = (input) =>
			Effect.scoped(
				Effect.gen(function* () {
					// The fiber belongs to the scope of this call, so it stops on every return.
					const observed = yield* Effect.forkScoped(
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
		const startAction: Chat.Runtime<P, Tools, E, HostTools>["startAction"] = (
			input,
		) =>
			Effect.gen(function* () {
				const content = Prompt.make(
					input.input ?? "Host-selected action: " + input.action.name,
				)
				if (input.turn === undefined) {
					const accepted = yield* Effect.suspend(() =>
						Effect.uninterruptibleMask((restore) =>
							Effect.gen(function* () {
								const { accepted, launched } = yield* admission.withPermits(1)(
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
										return { accepted, launched: yield* launch(accepted) }
									}),
								)
								yield* untilStarted(launched)
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
							// The Turn is current and open, so a fiber of its Chat here runs it.
							if (
								!(yield* isActive(view.chat.id)) ||
								Turn.isTerminal(record.status)
							)
								return yield* Turn.Conflict.make({
									chat: view.chat.id,
									turn,
									message:
										"Related host actions need the current Turn to run in this runtime",
								})
							return [
								undefined,
								Option.some({
									chat: {
										inbox: Arr.append(view.chat.inbox, {
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
			context,
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
			compact: (input) => compact(input).pipe(Effect.provideContext(services)),
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
		tag: Context.Service<I, Chat.Runtime<P, Tools, E, HostTools>>,
	) => Layer.Layer<
		I,
		BuildE,
		Exclude<BuildR | R | Bot.RuntimeServices<Tools, R>, Scope.Scope>
	>
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
		tag: Context.Service<I, Chat.Runtime<P, Tools, E, HostTools>>,
		options: Chat.RuntimeOptions<P, Tools, E, R, BuildE, BuildR, HostTools>,
	): Layer.Layer<
		I,
		BuildE,
		Exclude<BuildR | R | Bot.RuntimeServices<Tools, R>, Scope.Scope>
	>
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
		tag: Context.Service<I, Chat.Runtime<P, Tools, E, HostTools>>,
		options: Chat.RuntimeOptions<P, Tools, E, R, BuildE, BuildR, HostTools>,
	) => Layer.effect(tag, make(options)),
)
