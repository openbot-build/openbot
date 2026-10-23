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
	Chat,
	IdGenerator,
	LanguageModel,
	Prompt,
	Toolkit,
	type Tool,
	type Response,
} from "effect/ai"
import * as Session from "./Session.ts"
import * as HostActionDriver from "./HostActionDriver.ts"
import * as Turn from "./Turn.ts"
import * as Agent from "../agent/Agent.ts"
import * as Timeline from "../timeline/Timeline.ts"
import * as Item from "../timeline/Item.ts"
import { fullHistory, unansweredCalls } from "../timeline/TimelineState.ts"
import * as TimelineState from "../timeline/TimelineState.ts"
import type * as Config from "../models/Config.ts"
import * as ConfigurationOperations from "../models/ConfigurationOperations.ts"
import * as ContextWindow from "../context/ContextWindow.ts"
import * as ContextCompaction from "../context/ContextCompaction.ts"
import * as SummaryCompaction from "../context/SummaryCompaction.ts"
import { SessionStoreError } from "../store/SessionStore.ts"
import * as Plugin from "../plugins/Plugin.ts"
import * as PluginComposition from "../plugins/PluginComposition.ts"

export const make = <
	P = {},
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
	HostTools extends Record<string, Tool.Any> = {},
>(
	options: Session.RuntimeOptions<P, Tools, E, R, BuildE, BuildR, HostTools>,
): Effect.Effect<
	Session.Runtime<P, Tools, E, R, HostTools>,
	BuildE,
	BuildR | Scope.Scope
> =>
	Effect.gen(function* () {
		type Event = Agent.Event<
			Toolkit.MergedTools<[Toolkit.Toolkit<Tools>, Toolkit.Toolkit<HostTools>]>,
			P
		>
		const agent = options.agent
		const scope = yield* Effect.scope
		const basePlugin =
			agent.plugin ??
			Plugin.make({ id: Plugin.Id.make("@openbot-build/core/runtime-tools") })<
				Tools,
				E,
				R
			>(() =>
				Effect.succeed((next, input) =>
					next({
						...input,
						toolkit:
							agent.toolkit === undefined
								? input.toolkit
								: Predicate.hasProperty(agent.toolkit, "toHandlers")
									? Effect.succeed(agent.toolkit)
									: agent.toolkit,
					}),
				),
			)
		const hosted =
			agent.hostPlugin ??
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
		// The agent compaction service comes first. Otherwise the host may provide one.
		const compactionService =
			agent.compaction === undefined
				? Effect.serviceOption(ContextCompaction.ContextCompaction)
				: Effect.succeedSome(agent.compaction)
		const findModel = (selection: Config.Selection | undefined) =>
			(agent.modelCatalog ?? Effect.succeed([])).pipe(
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
				Session.Id,
				{
					readonly turn: Turn.Id
					readonly fiber: Fiber.Fiber<unknown, unknown>
				}
			>(),
		)
		const bus = yield* PubSub.unbounded<Event>()
		const activity = yield* PubSub.unbounded<Session.Id>()
		yield* Effect.addFinalizer(() => PubSub.shutdown(bus))
		yield* Effect.addFinalizer(() => PubSub.shutdown(activity))
		// The latest events, so a new subscriber can catch up with recent revisions.
		const retained = yield* Ref.make<ReadonlyArray<Event>>([])
		const publish = (event: Event) =>
			Ref.update(retained, (events) =>
				A.takeRight(A.append(events, event), 64),
			).pipe(Effect.andThen(PubSub.publish(bus, event)), Effect.asVoid)
		const versionEvent = (view: Session.View<P>): Event => ({
			_tag: "VersionCreated",
			view,
		})
		yield* Effect.forkScoped(
			options.store.changes().pipe(
				Stream.runForEach((change) =>
					Match.value(change).pipe(
						Match.tag("VersionCommitted", ({ view }) =>
							publish(versionEvent(view)),
						),
						Match.tag("RefUpdated", ({ ref }) =>
							options.store
								.readVersion(ref.head)
								.pipe(
									Effect.flatMap((state) =>
										publish(versionEvent({ session: ref, state })),
									),
								),
						),
						Match.tag("RefRemoved", () => Effect.void),
						Match.exhaustive,
					),
				),
			),
			{ startImmediately: true },
		)
		const check = (ref: Session.Ref, expected?: Timeline.VersionId) =>
			expected !== undefined && ref.head !== expected
				? Effect.fail(
						new Timeline.VersionError({
							reason: "head-conflict",
							version: expected,
							message: "The Timeline head is out of date",
						}),
					)
				: Effect.void
		const commit = (input: {
			readonly session: Session.Id
			readonly expected?: Timeline.VersionId
			readonly update: (value: Timeline.Value<P>) => Timeline.Value<P>
		}) =>
			options.store
				.modifyEffect({
					session: input.session,
					...(input.expected === undefined
						? {}
						: { expectedHead: input.expected }),
					update: (view) =>
						Effect.succeed([
							undefined,
							Option.some({ value: input.update(view.state.value) }),
						] as const),
				})
				.pipe(Effect.map(({ view }) => view))
		const requireTurn = (view: Session.View<P>, turn: Turn.Id) => {
			const current = Session.currentTurn(view.session)
			return current?.id === turn
				? Effect.succeed(current)
				: Effect.fail(
						new Turn.Conflict({
							session: view.session.id,
							turn,
							message: "The target Turn is no longer current",
						}),
					)
		}
		const receipt = (
			view: Session.View<P>,
			turn: Turn.Id,
			item: Item.Id,
		): Session.Receipt => ({
			session: view.session.id,
			turn,
			item,
			revision: view.session.revision,
			version: view.session.head,
		})
		const accept = (input: Session.Input, queued?: Session.Pending) =>
			Effect.gen(function* () {
				const turn = Turn.Id.make(yield* id()),
					item = queued?.id ?? Item.Id.make(yield* id())
				const prompt = Prompt.make(input.input)
				const changed = yield* options.store.modifyEffect({
					session: input.base.session,
					expectedRevision: input.base.revision,
					update: (view) =>
						Effect.gen(function* () {
							if (
								HashMap.has(yield* SynchronizedRef.get(active), view.session.id)
							)
								return yield* new Session.Conflict({
									session: view.session.id,
									message: "The previous Turn is still releasing its resources",
								})
							const previous = Session.currentTurn(view.session)

							if (previous !== undefined && !Turn.isTerminal(previous.status))
								return yield* new Session.Conflict({
									session: view.session.id,
									message: "The Session already has an unfinished Turn",
								})
							const settings = { ...view.session.settings, ...input.overrides }
							const window = Match.value(
								view.state.value.conversation.context,
							).pipe(
								Match.tag("Native", (window) =>
									settings.model?.provider === window.provider &&
									settings.model.model === window.model
										? window
										: ContextWindow.fromPrompt(fullHistory(view.state.value)),
								),
								Match.tag("Prompt", (window) => window),
								Match.exhaustive,
							)
							const record: Turn.Record = {
								...(input.action === undefined ? {} : { action: input.action }),
								...(input.author === undefined ? {} : { author: input.author }),
								id: turn,
								session: view.session.id,
								settings,
								status: Turn.StatusSchema.make({ _tag: "Running" }),
								steps: 0,
								input: [item],
								items: [item],
								start: view.session.head,
								startedAt: yield* Clock.currentTimeMillis,
							}
							return [
								undefined,
								Option.some({
									value: {
										...view.state.value,
										conversation: {
											...view.state.value.conversation,
											closed: false,
											history: A.append(view.state.value.conversation.history, {
												id: item,
												content: prompt,
												origin: { session: view.session.id, turn, step: 0 },
											}),
											context: ContextWindow.append(window, prompt),
										},
									},
									session: {
										turns: A.append(view.session.turns, record),
										pending:
											queued === undefined
												? view.session.pending
												: view.session.pending.filter(
														(entry) => entry.id !== queued.id,
													),
									},
								}),
							] as const
						}),
				})
				return { view: changed.view, turn, item, prompt }
			})
		const close = (session: Session.Id, turn: Turn.Id, status: Turn.Status) =>
			options.store
				.modifyEffect({
					session,
					update: (view) =>
						Effect.gen(function* () {
							const current = yield* requireTurn(view, turn)
							if (Turn.isTerminal(current.status))
								return [false, Option.none()] as const
							// Record an unavailable result for each unanswered tool call before later input uses this history.
							const calls = unansweredCalls(
								view.state.value.conversation.history,
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
							const history =
								prompt.content.length === 0
									? view.state.value.conversation.history
									: A.append(view.state.value.conversation.history, {
											id: item,
											content: prompt,
											origin: {
												session,
												turn,
												step: current.steps,
											},
										})
							return [
								true,
								Option.some({
									value: {
										...view.state.value,
										conversation: {
											...view.state.value.conversation,
											history,
											context: ContextWindow.append(
												view.state.value.conversation.context,
												prompt,
											),
											closed: true,
										},
									},
									session: {
										pending: view.session.pending.filter(
											(entry) => entry.turn !== turn,
										),
										turns: view.session.turns.map((entry) => {
											if (entry.id !== turn) return entry
											return {
												...entry,
												status,
												completedAt,
												...(prompt.content.length === 0
													? {}
													: { items: A.append(entry.items, item) }),
											}
										}),
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
									turn: Session.currentTurn(view.session)!,
								})
							: Effect.void,
					),
					Effect.map(({ view }) => view),
				)
		const compact = (input: {
			session: Session.Id
			targetTokens: number
			request: Omit<ContextCompaction.Request, "window" | "selection">
			expected?: Timeline.VersionId
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
				const view = yield* options.store.read(input.session)
				yield* check(view.session, input.expected)
				const selection = input.selection ?? view.session.settings.model
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
						window: Match.value(view.state.value.conversation.context).pipe(
							Match.tag("Native", (window) =>
								selection.provider === window.provider &&
								selection.model === window.model
									? window
									: ContextWindow.fromPrompt(fullHistory(view.state.value)),
							),
							Match.tag("Prompt", (window) => window),
							Match.exhaustive,
						),
						selection,
					},
					beforeTokens = yield* compaction.count(request)
				if (
					model?.contextWindow !== undefined &&
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
							const provider = agent.providers?.find(
								(p) => p.id === summarySelection.provider,
							)
							const program = SummaryCompaction.compact({
								prompt: Match.value(request.window).pipe(
									Match.tag("Native", () => fullHistory(view.state.value)),
									Match.tag("Prompt", (window) => window.prompt),
									Match.exhaustive,
								),
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
				const committed = yield* commit({
					session: input.session,
					expected: view.session.head,
					update: (value) => ({
						...value,
						conversation: {
							...value.conversation,
							context: window,
						},
					}),
				})
				return { view: committed, beforeTokens, afterTokens }
			})

		const runner = (session: Session.Id, turn: Turn.Id) =>
			Effect.gen(function* () {
				const fiber = yield* Effect.fiber
				yield* Effect.acquireRelease(
					SynchronizedRef.modifyEffect(active, (entries) =>
						Effect.gen(function* () {
							if (HashMap.has(entries, session))
								return yield* new Turn.Conflict({
									session,
									turn,
									message: "The Session already has an active runner",
								})
							return [
								undefined,
								HashMap.set(entries, session, { turn, fiber }),
							] as const
						}),
					).pipe(Effect.tap(() => PubSub.publish(activity, session))),
					() =>
						SynchronizedRef.update(active, (entries) =>
							HashMap.get(entries, session).pipe(
								Option.exists((entry) => entry.fiber === fiber),
							)
								? HashMap.remove(entries, session)
								: entries,
						).pipe(Effect.andThen(() => PubSub.publish(activity, session))),
				)
			})
		const run = (accepted: {
			readonly view: Session.View<P>
			readonly turn: Turn.Id
			readonly item: Item.Id
			readonly prompt: Prompt.Prompt
		}): Stream.Stream<
			Event,
			Session.RuntimeError | Agent.ExecutionError<Tools, E>,
			Agent.RuntimeServices<Tools, R>
		> =>
			Stream.unwrap(
				Effect.gen(function* () {
					const session = accepted.view.session.id
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
							yield* Chat.fromPrompt(
								accepted.view.state.value.conversation.context.prompt,
							),
						)
					const context = Agent.Context.of({
						options: {
							prompt: accepted.prompt,
							...(action === undefined ? {} : { action }),
							...R.filter(
								{
									toolChoice: agent.toolChoice,
									concurrency: agent.concurrency,
								},
								Predicate.isNotUndefined,
							),
						},
						at: options.store
							.read(session)
							.pipe(Effect.map((view) => Session.position(view.session))),
						turn: Effect.succeed(turn),
						step: Ref.get(step),
						history: Ref.get(chatRef).pipe(
							Effect.flatMap((chat) => Ref.get(chat.history)),
						),
					})
					const next: Plugin.Next<
						Session.RuntimeError | Agent.ExecutionError<Tools, E>,
						R | Agent.Requirements<Tools, Tool.HandlersFor<Tools>>
					> = <TK extends Toolkit.Any, ToolkitE, ToolkitR>(
						inner: Plugin.Options<TK, ToolkitE, ToolkitR>,
					) =>
						Stream.unwrap(
							Effect.gen(function* () {
								const definitions: Toolkit.Any = yield* inner.toolkit
								const toolkit = definitions as Toolkit.Toolkit<Tools>,
									handlers = yield* toolkit
								const loop = (
									n: number,
								): Stream.Stream<
									Event,
									| Session.RuntimeError
									| Agent.ExecutionError<Tools, E | ToolkitE>,
									R | Agent.Requirements<Tools, ToolkitR>
								> =>
									Stream.unwrap(
										Effect.gen(function* () {
											let view = yield* options.store.read(session)
											let record = yield* requireTurn(view, turn)
											if (Turn.isTerminal(record.status)) return Stream.empty
											const injected = view.session.pending.filter(
												(entry) =>
													entry.kind === "steer" && entry.turn === turn,
											)
											if (injected.length > 0)
												view = (yield* options.store.modifyEffect({
													session,
													update: (current) =>
														Effect.gen(function* () {
															yield* requireTurn(current, turn)
															const entries = current.session.pending.filter(
																(entry) =>
																	injected.some(
																		(selected) => selected.id === entry.id,
																	),
															)
															const history = [
																...current.state.value.conversation.history,
																...entries.map((entry): Item.Record => ({
																	id: entry.id,
																	content: entry.content,
																	origin: {
																		session,
																		turn,
																		step: action === undefined ? n : 0,
																	},
																})),
															]
															return [
																undefined,
																Option.some({
																	value: {
																		...current.state.value,
																		conversation: {
																			...current.state.value.conversation,
																			history,
																			context: entries.reduce(
																				(window, entry) =>
																					ContextWindow.append(
																						window,
																						entry.content,
																					),
																				current.state.value.conversation
																					.context,
																			),
																		},
																	},
																	session: {
																		pending: current.session.pending.filter(
																			(entry) =>
																				!entries.some(
																					(selected) =>
																						selected.id === entry.id,
																				),
																		),
																		turns: current.session.turns.map((entry) =>
																			entry.id === turn
																				? {
																						...entry,
																						items: [
																							...entry.items,
																							...entries.map(
																								(entry) => entry.id,
																							),
																						],
																					}
																				: entry,
																		),
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
											if (
												action === undefined &&
												selection !== undefined &&
												model?.contextWindow !== undefined &&
												Option.isSome(compaction)
											) {
												const request = {
													selection,
													window: view.state.value.conversation.context,
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
												)
													view = (yield* compact({
														session,
														expected: view.session.head,
														targetTokens: autoCompactTokens,
														selection,
														request,
													})).view
											}
											const window = view.state.value.conversation.context
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
											const chat = yield* Chat.fromPrompt(starting)
											yield* Ref.set(chatRef, chat)
											yield* Ref.set(step, action === undefined ? n : 0)
											const item = Item.Id.make(yield* id()),
												at = Session.position(view.session)
											let text = "",
												finishReason: Response.FinishReason = "unknown",
												followUp = false,
												approval = false
											let received: ReadonlyArray<
												Response.StreamPart<Tools, "opaque">
											> = []
											let usage: Response.Usage | undefined
											const provider = agent.providers?.find(
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
													toolkit: handlers,
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
													Agent.ExecutionError<Tools, E>,
													R | Agent.Requirements<Tools>
												>
											).pipe(
												Stream.onExit((exit) =>
													Effect.gen(function* () {
														if (Exit.isSuccess(exit) || received.length === 0)
															return
														if (
															Option.exists(
																Cause.findErrorOption(exit.cause),
																(failure) =>
																	failure instanceof SessionStoreError,
															)
														)
															return
														const added = Prompt.fromResponseParts(received)
														if (added.content.length === 0) return
														yield* options.store
															.modifyEffect({
																session,
																update: (current) =>
																	Effect.gen(function* () {
																		const currentTurn = yield* requireTurn(
																			current,
																			turn,
																		)
																		if (
																			current.state.value.conversation.history.some(
																				(entry) => entry.id === item,
																			)
																		)
																			return [undefined, Option.none()] as const
																		return [
																			undefined,
																			Option.some({
																				value: {
																					...current.state.value,
																					conversation: {
																						...current.state.value.conversation,
																						history: A.append(
																							current.state.value.conversation
																								.history,
																							{
																								id: item,
																								content: added,
																								origin: {
																									session,
																									turn,
																									step:
																										action === undefined
																											? n
																											: 0,
																								},
																							},
																						),
																						context: ContextWindow.append(
																							current.state.value.conversation
																								.context,
																							added,
																						),
																					},
																				},
																				session: {
																					turns: current.session.turns.map(
																						(entry) =>
																							entry.id === turn
																								? {
																										...currentTurn,
																										steps:
																											action === undefined
																												? n
																												: currentTurn.steps,
																										items: A.append(
																											currentTurn.items,
																											item,
																										),
																									}
																								: entry,
																					),
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
														added = Prompt.fromMessages(
															completed.content.slice(starting.content.length),
														)
													let stop =
														action !== undefined ||
														approval ||
														[
															"length",
															"content-filter",
															"error",
															"pause",
														].includes(finishReason) ||
														!followUp
													const output = { text, finishReason }
													const committed = (yield* options.store.modifyEffect({
														session,
														update: (current) =>
															Effect.gen(function* () {
																const currentTurn = yield* requireTurn(
																	current,
																	turn,
																)
																if (
																	!approval &&
																	![
																		"length",
																		"content-filter",
																		"error",
																		"pause",
																	].includes(finishReason) &&
																	current.session.pending.some(
																		(entry) =>
																			entry.kind === "steer" &&
																			entry.turn === turn,
																	)
																)
																	stop = false
																const moreActions =
																	current.session.pending.some(
																		(entry) =>
																			entry.kind === "action" &&
																			entry.turn === turn,
																	)
																const terminal =
																	stop && !approval && !moreActions
																const now = yield* Clock.currentTimeMillis
																const status: Turn.Status = approval
																	? { _tag: "Waiting", result: output }
																	: terminal
																		? { _tag: "Completed", result: output }
																		: { _tag: "Running" }
																return [
																	undefined,
																	Option.some({
																		value: {
																			...current.state.value,
																			conversation: {
																				...current.state.value.conversation,
																				history: A.append(
																					current.state.value.conversation
																						.history,
																					{
																						id: item,
																						content: added,
																						origin: {
																							session,
																							turn,
																							step:
																								action === undefined ? n : 0,
																						},
																					},
																				),
																				context: ContextWindow.append(
																					current.state.value.conversation
																						.context,
																					added,
																				),
																				closed: terminal,
																			},
																		},
																		session: {
																			turns: current.session.turns.map(
																				(entry) =>
																					entry.id === turn
																						? {
																								...(approval
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
																												...(currentTurn.usage ??
																													[]),
																												usage,
																											],
																								...(terminal
																									? { completedAt: now }
																									: {}),
																							}
																						: entry,
																			),
																		},
																	}),
																] as const
															}),
													})).view
													const ended = Session.currentTurn(committed.session)!
													return stop && ended.status._tag === "Running"
														? Stream.succeed(versionEvent(committed))
														: stop
															? Stream.make(versionEvent(committed), {
																	_tag: approval
																		? "TurnWaiting"
																		: "TurnCompleted",
																	view: committed,
																	turn: ended,
																} as Event)
															: Stream.concat(
																	Stream.succeed(versionEvent(committed)),
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
										(event) => event as Agent.Event<Toolkit.MergedTools<[TK]>>,
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
					return Agent.Context.provide(
						Stream.concat(
							Stream.make(versionEvent(accepted.view), {
								_tag: "TurnStarted",
								at: Session.position(accepted.view.session),
								turn,
							} as Event),
							body,
						),
						context,
					).pipe(
						Stream.tap((event) =>
							Match.value(event).pipe(
								Match.tag("VersionCreated", () => Effect.void),
								Match.orElse(publish),
							),
						),
						Stream.onExit((exit) =>
							Effect.gen(function* () {
								const latest = yield* options.store.read(session)
								const current = Session.currentTurn(latest.session)
								if (current?.id === turn && !Turn.isTerminal(current.status)) {
									const shouldClose =
										Exit.isFailure(exit) ||
										(current.status._tag === "Running" &&
											!latest.session.pending.some(
												(entry) =>
													entry.kind === "action" && entry.turn === turn,
											))
									if (shouldClose)
										yield* close(
											session,
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
								// Best effort: resume closes the Turn later if this cleanup cannot.
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
		const phases = (accepted: {
			readonly view: Session.View<P>
			readonly turn: Turn.Id
			readonly item: Item.Id
			readonly prompt: Prompt.Prompt
		}): Stream.Stream<
			Event,
			Session.RuntimeError | Agent.ExecutionError<Tools, E>,
			Agent.RuntimeServices<Tools, R>
		> => {
			const next = (
				phase: typeof accepted,
			): Stream.Stream<
				Event,
				Session.RuntimeError | Agent.ExecutionError<Tools, E>,
				Agent.RuntimeServices<Tools, R>
			> =>
				Stream.concat(
					run(phase),
					Stream.unwrap(
						Effect.gen(function* () {
							const current = yield* options.store.read(phase.view.session.id)
							const turn = yield* requireTurn(current, phase.turn)
							if (turn.status._tag !== "Running") return Stream.empty
							const changed = yield* options.store.modifyEffect({
								session: current.session.id,
								update: (view) =>
									Effect.gen(function* () {
										const turn = yield* requireTurn(view, phase.turn)
										const selected = A.findFirst(
											view.session.pending,
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
												value: {
													...view.state.value,
													conversation: {
														...view.state.value.conversation,
														history: A.append(
															view.state.value.conversation.history,
															{
																id: pending.id,
																content: pending.content,
																origin: {
																	session: view.session.id,
																	turn: phase.turn,
																	step: turn.steps,
																},
															},
														),
														context: ContextWindow.append(
															view.state.value.conversation.context,
															pending.content,
														),
														closed: false,
													},
												},
												session: {
													pending: view.session.pending.filter(
														(entry) => entry.id !== pending.id,
													),
													turns: view.session.turns.map((record) =>
														record.id === phase.turn
															? {
																	...record,
																	activeAction: {
																		item: pending.id,
																		action,
																	},
																	items: A.append(record.items, pending.id),
																}
															: record,
													),
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
					runner(accepted.view.session.id, accepted.turn).pipe(
						Effect.as(next(accepted)),
					),
				),
			)
		}
		const launch = (accepted: {
			readonly view: Session.View<P>
			readonly turn: Turn.Id
			readonly item: Item.Id
			readonly prompt: Prompt.Prompt
		}): Effect.Effect<void, never, Agent.RuntimeServices<Tools, R>> =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				yield* Effect.forkIn(
					phases(accepted).pipe(
						Stream.tap((event) =>
							Match.value(event).pipe(
								Match.tag("TurnStarted", () =>
									Deferred.succeed(started, undefined),
								),
								Match.orElse(() => Effect.void),
							),
						),
						Stream.runDrain,
						Effect.ensuring(Deferred.succeed(started, undefined)),
						Effect.onExit((exit) =>
							Exit.isSuccess(exit)
								? drain(accepted.view.session.id)
								: Effect.void,
						),
					),
					scope,
				)
				yield* Deferred.await(started)
			})
		const runQueued: Session.Runtime<P, Tools, E, R, HostTools>["runQueued"] = (
			session,
		) =>
			Effect.gen(function* () {
				const view = yield* options.store.read(session),
					current = Session.currentTurn(view.session)
				const queued = view.session.pending.find(
					(entry) => entry.kind === "message",
				)
				if (
					queued === undefined ||
					current === undefined ||
					current.status._tag !== "Completed"
				)
					return Option.none()
				const accepted = yield* accept(
					{
						base: { session, revision: view.session.revision },
						input: queued.content,
						...(queued.author === undefined ? {} : { author: queued.author }),
					},
					queued,
				)
				yield* launch(accepted)
				return Option.some(receipt(accepted.view, accepted.turn, accepted.item))
			})
		const drain = (session: Session.Id) =>
			runQueued(session).pipe(
				Effect.catch((error) =>
					Effect.logDebug("The queued Turn could not start", error),
				),
				Effect.asVoid,
			)

		const stream: Session.Runtime<P, Tools, E, R, HostTools>["stream"] = (
			input,
		) => Stream.unwrap(accept(input).pipe(Effect.map(phases)))
		const start: Session.Runtime<P, Tools, E, R, HostTools>["start"] = (
			input,
		) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const accepted = yield* restore(accept(input))
					yield* launch(accepted)
					return receipt(accepted.view, accepted.turn, accepted.item)
				}),
			)
		const steer: Session.Runtime<P, Tools, E, R, HostTools>["steer"] = (
			input,
		) =>
			Effect.gen(function* () {
				const item = Item.Id.make(yield* id())
				const { view } = yield* options.store.modifyEffect({
					session: input.session,
					update: (view) =>
						Effect.gen(function* () {
							const turn = yield* requireTurn(view, input.turn)
							if (turn.status._tag !== "Running")
								return yield* new Turn.Conflict({
									session: input.session,
									turn: input.turn,
									message: "Steering needs a running Turn",
								})
							if (turn.author !== input.author)
								return yield* new Turn.Conflict({
									session: input.session,
									turn: input.turn,
									message: "Only the author of a Turn can steer it",
								})
							return [
								undefined,
								Option.some({
									session: {
										pending: A.append(view.session.pending, {
											id: item,
											kind: "steer" as const,
											turn: input.turn,
											content: Prompt.make(input.input),
										}),
									},
								}),
							] as const
						}),
				})
				return receipt(view, input.turn, item)
			})
		const enqueue: Session.Runtime<P, Tools, E, R, HostTools>["enqueue"] = (
			input,
		) =>
			Effect.gen(function* () {
				const item = Item.Id.make(yield* id())
				const { view } = yield* options.store.modifyEffect({
					session: input.session,
					...(input.expectedRevision === undefined
						? {}
						: { expectedRevision: input.expectedRevision }),
					update: (view) =>
						Effect.succeed([
							undefined,
							Option.some({
								session: {
									pending: A.append(view.session.pending, {
										id: item,
										kind: "message" as const,
										content: Prompt.make(input.message),
										...(input.author === undefined
											? {}
											: { author: input.author }),
									}),
								},
							}),
						] as const),
				})
				return { session: input.session, item, revision: view.session.revision }
			})
		const interrupt: Session.Runtime<P, Tools, E, R, HostTools>["interrupt"] = (
			input,
		) =>
			Effect.gen(function* () {
				const view = yield* options.store.read(input.session),
					turn = yield* requireTurn(view, input.turn)
				if (Turn.isTerminal(turn.status))
					return yield* new Turn.Conflict({
						session: input.session,
						turn: input.turn,
						message: "The Turn has already ended",
					})
				yield* Option.match(
					HashMap.get(yield* SynchronizedRef.get(active), input.session).pipe(
						Option.filter((running) => running.turn === input.turn),
					),
					{
						onNone: () => Effect.void,
						onSome: (running) => Fiber.interrupt(running.fiber),
					},
				)
				return yield* close(input.session, input.turn, { _tag: "Interrupted" })
			})
		const resolve: Session.Runtime<P, Tools, E, R, HostTools>["resolve"] = (
			input,
		) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const item = Item.Id.make(yield* id())
					const { view, result: ready } = yield* restore(
						options.store.modifyEffect({
							session: input.session,
							expectedRevision: input.expectedRevision,
							update: (view) =>
								Effect.gen(function* () {
									if (
										HashMap.has(
											yield* SynchronizedRef.get(active),
											input.session,
										)
									)
										return yield* new Turn.Conflict({
											session: input.session,
											turn: input.turn,
											message:
												"The Turn is still releasing its execution scope",
										})
									const turn = yield* requireTurn(view, input.turn)
									if (turn.status._tag !== "Waiting")
										return yield* new Turn.Conflict({
											session: input.session,
											turn: input.turn,
											message: "The Turn is not waiting",
										})
									const wait = Session.waits(view).find(
										(entry) => entry.approvalId === input.approval,
									)
									if (wait === undefined)
										return yield* new Turn.Conflict({
											session: input.session,
											turn: input.turn,
											message: "The approval request is no longer pending",
										})
									const answer = Prompt.toolApprovalResponsePart({
										approvalId: input.approval,
										approved: input.outcome._tag !== "Denied",
										...(input.outcome._tag === "Denied" &&
										input.outcome.reason !== undefined
											? { reason: input.outcome.reason }
											: {}),
									})
									// A tool result next to the approval tells Effect AI that the
									// call is done, so it never runs the tool handler.
									const content = Prompt.make([
										{
											role: "tool",
											content:
												input.outcome._tag === "Result"
													? [
															answer,
															Prompt.toolResultPart({
																id: wait.toolCallId,
																name: wait.toolCall.name,
																isFailure: input.outcome.isFailure,
																result: input.outcome.result,
																providerExecuted: false,
															}),
														]
													: [answer],
										},
									])
									const value = {
										...view.state.value,
										conversation: {
											...view.state.value.conversation,
											closed: false,
											history: A.append(view.state.value.conversation.history, {
												id: item,
												content,
												origin: {
													session: input.session,
													turn: input.turn,
													step: turn.steps,
												},
											}),
											context: ContextWindow.append(
												view.state.value.conversation.context,
												content,
											),
										},
									}
									const ready = TimelineState.waits(value).length === 0
									return [
										ready,
										Option.some({
											value,
											session: {
												turns: view.session.turns.map((entry) =>
													entry.id === input.turn
														? {
																...entry,
																items: A.append(entry.items, item),
																...(ready
																	? { status: { _tag: "Running" as const } }
																	: {}),
															}
														: entry,
												),
											},
										}),
									] as const
								}),
						}),
					)
					if (ready)
						yield* launch({
							view,
							turn: input.turn,
							item,
							prompt: Prompt.empty,
						})
					return receipt(view, input.turn, item)
				}),
			)
		const resume: Session.Runtime<P, Tools, E, R, HostTools>["resume"] = (
			session,
		) =>
			Effect.gen(function* () {
				const view = yield* options.store.read(session),
					current = Session.currentTurn(view.session)

				if (
					current === undefined ||
					Turn.isTerminal(current.status) ||
					current.status._tag === "Waiting" ||
					HashMap.has(yield* SynchronizedRef.get(active), session)
				)
					return view
				return yield* close(session, current.id, { _tag: "Interrupted" })
			})
		/** An event with a view takes its position from it. Other events carry `at`. */
		const positionOf = (event: Event) =>
			"view" in event ? Session.position(event.view.session) : event.at
		const belongs = (event: Event, session: Session.Id) =>
			positionOf(event).session === session
		const revision = (event: Event) => positionOf(event).revision
		const events: Session.Runtime<P, Tools, E, R, HostTools>["events"] = (
			input,
		) =>
			Stream.unwrap(
				Effect.gen(function* () {
					yield* options.store.read(input.session)
					const subscription = yield* PubSub.subscribe(bus)
					const snapshot = (yield* Ref.get(retained)).filter(
						(event) =>
							belongs(event, input.session) &&
							input.after !== undefined &&
							revision(event) > input.after,
					)
					return Stream.concat(
						Stream.fromArray(snapshot),
						Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(
							Stream.filter((event) => belongs(event, input.session)),
						),
					)
				}),
			)
		const wait: Session.Runtime<P, Tools, E, R, HostTools>["wait"] = (input) =>
			Effect.scoped(
				Effect.gen(function* () {
					const observed = yield* Effect.forkChild(
						Effect.raceFirst(
							options.store
								.changes({ session: input.session })
								.pipe(Stream.take(1), Stream.runDrain),
							Stream.fromPubSub(activity).pipe(
								Stream.filter((session) => session === input.session),
								Stream.take(1),
								Stream.runDrain,
							),
						),
						{ startImmediately: true },
					)
					const view = yield* options.store.read(input.session)
					if (view.session.revision !== input.after) return view
					if (
						input.afterActive !== undefined &&
						HashMap.has(yield* SynchronizedRef.get(active), input.session) !==
							input.afterActive
					)
						return view
					yield* Fiber.join(observed).pipe(Effect.timeoutOption(input.timeout))
					return yield* options.store.read(input.session)
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
		const startAction: Session.Runtime<
			P,
			Tools,
			E,
			R,
			HostTools
		>["startAction"] = (input) =>
			Effect.gen(function* () {
				if (input.turn === undefined) {
					const accepted = yield* withActionDriver(
						input.action,
						start({
							...input,
							input:
								input.input ??
								Prompt.make("Host-selected action: " + input.action.name),
						}),
					)
					return { ...accepted, callId: "host-action-" + accepted.turn }
				}
				const turn = input.turn
				const item = Item.Id.make(yield* id())
				const content = Prompt.make(
					input.input ?? "Host-selected action: " + input.action.name,
				)
				const changed = yield* options.store.modifyEffect({
					session: input.base.session,
					expectedRevision: input.base.revision,
					update: (view) =>
						Effect.gen(function* () {
							const record = yield* requireTurn(view, turn)
							const running = HashMap.get(
								yield* SynchronizedRef.get(active),
								view.session.id,
							)
							const resident =
								Option.exists(running, (entry) => entry.turn === turn) ||
								record.status._tag === "Waiting"
							if (!resident || Turn.isTerminal(record.status))
								return yield* new Turn.Conflict({
									session: view.session.id,
									turn,
									message:
										"Related host actions need the current Turn to be active in this runtime",
								})
							return [
								undefined,
								Option.some({
									session: {
										pending: A.append(view.session.pending, {
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
				return {
					...receipt(changed.view, turn, item),
					callId: "host-action-" + item,
				}
			})

		const resolveAction: Session.Runtime<
			P,
			Tools,
			E,
			R,
			HostTools
		>["resolveAction"] = (input) =>
			Effect.gen(function* () {
				const view = yield* options.store.read(input.session)
				const turn = yield* requireTurn(view, input.turn)
				const action = turn.activeAction?.action ?? turn.action
				if (action === undefined)
					return yield* new Turn.Conflict({
						session: input.session,
						turn: input.turn,
						message: "This Turn is not a host-selected action",
					})
				return yield* withActionDriver(action, resolve(input))
			})
		return {
			startAction,
			resolveAction,
			isActive: (session) =>
				SynchronizedRef.get(active).pipe(
					Effect.map((entries) => HashMap.has(entries, session)),
				),
			execute: (input) =>
				stream(input).pipe(
					Stream.runDrain,
					Effect.andThen(options.store.read(input.base.session)),
				),
			stream,
			start,
			runQueued,
			steer,
			enqueue,
			interrupt,
			resolve,
			resume,
			status: options.store.read,
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
		options: Session.RuntimeOptions<P, Tools, E, R, BuildE, BuildR, HostTools>,
	): <I>(
		tag: Context.Service<I, Session.Runtime<P, Tools, E, R, HostTools>>,
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
		tag: Context.Service<I, Session.Runtime<P, Tools, E, R, HostTools>>,
		options: Session.RuntimeOptions<P, Tools, E, R, BuildE, BuildR, HostTools>,
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
		tag: Context.Service<I, Session.Runtime<P, Tools, E, R, HostTools>>,
		options: Session.RuntimeOptions<P, Tools, E, R, BuildE, BuildR, HostTools>,
	) => Layer.effect(tag, make(options)),
)
