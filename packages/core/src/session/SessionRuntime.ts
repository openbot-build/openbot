import {
	Array as A,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	HashSet,
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
import * as Memory from "../memory/Memory.ts"
import * as Item from "../memory/Item.ts"
import { fullHistory } from "../memory/MemoryState.ts"
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
	BuildR | import("effect").Scope.Scope
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
		const continuations = yield* SynchronizedRef.make(
			HashMap.empty<Session.Id, Turn.Id>(),
		)
		const canApprove = (input: {
			readonly session: Session.Id
			readonly turn: Turn.Id
		}) =>
			SynchronizedRef.get(continuations).pipe(
				Effect.map(
					(entries) =>
						Option.getOrUndefined(HashMap.get(entries, input.session)) ===
						input.turn,
				),
			)
		const clearContinuation = (session: Session.Id, turn: Turn.Id) =>
			SynchronizedRef.update(continuations, (entries) =>
				Option.getOrUndefined(HashMap.get(entries, session)) === turn
					? HashMap.remove(entries, session)
					: entries,
			)
		const activity = yield* PubSub.unbounded<Session.Id>()
		yield* Effect.addFinalizer(() => PubSub.shutdown(bus))
		yield* Effect.addFinalizer(() => PubSub.shutdown(activity))
		let retained: ReadonlyArray<Event> = []
		const publish = (event: Event) =>
			Effect.sync(() => {
				retained = A.takeRight(A.append(retained, event), 64)
				PubSub.publishUnsafe(bus, event)
			})
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
		const check = (ref: Session.Ref, expected?: Memory.VersionId) =>
			expected !== undefined && ref.head !== expected
				? Effect.fail(
						new Memory.VersionError({
							reason: "head-conflict",
							version: expected,
							message: "The Memory head is out of date",
						}),
					)
				: Effect.void
		const commit = (input: {
			readonly session: Session.Id
			readonly expected?: Memory.VersionId
			readonly update: (value: Memory.Value<P>) => Memory.Value<P>
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
							const window = Match.value(view.state.value.memory.context).pipe(
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
								id: turn,
								session: view.session.id,
								settings,
								status: Turn.StatusSchema.make({ _tag: "Running" }),
								steps: 0,
								input: [item],
								items: [item],
								start: view.session.head,
								startedAt: Date.now(),
							}
							return [
								undefined,
								Option.some({
									value: {
										...view.state.value,
										memory: {
											...view.state.value.memory,
											closed: false,
											history: A.append(view.state.value.memory.history, {
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
							let calls = HashMap.empty<string, Prompt.ToolCallPart>()
							for (const entry of view.state.value.memory.history)
								for (const message of entry.content.content)
									Match.value(message).pipe(
										Match.when({ role: "assistant" }, (message) => {
											for (const part of message.content)
												Match.value(part).pipe(
													Match.when({ type: "tool-call" }, (part) => {
														if (part.providerExecuted !== true)
															calls = HashMap.set(calls, part.id, part)
													}),
													Match.orElse(() => {}),
												)
										}),
										Match.when({ role: "tool" }, (message) => {
											for (const part of message.content)
												Match.value(part).pipe(
													Match.when({ type: "tool-result" }, (part) => {
														calls = HashMap.remove(calls, part.id)
													}),
													Match.orElse(() => {}),
												)
										}),
										Match.orElse(() => {}),
									)
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
									? view.state.value.memory.history
									: A.append(view.state.value.memory.history, {
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
										memory: {
											...view.state.value.memory,
											history,
											context: ContextWindow.append(
												view.state.value.memory.context,
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
												completedAt: Date.now(),
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
					Effect.tap(({ result }) =>
						result ? clearContinuation(session, turn) : Effect.void,
					),
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
			expected?: Memory.VersionId
			selection?: import("../models/Config.ts").Selection
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
				const compaction =
					agent.compaction ??
					Option.getOrUndefined(
						yield* Effect.serviceOption(ContextCompaction.ContextCompaction),
					)
				if (selection === undefined || compaction === undefined)
					return yield* new ContextCompaction.ContextCompactionError({
						reason: "unsupported",
						message: "The current model has no compaction service or selection",
					})
				const model = (yield* agent.modelCatalog ?? Effect.succeed([])).find(
					(m) => m.provider === selection.provider && m.id === selection.model,
				)
				const request = {
						...input.request,
						window: Match.value(view.state.value.memory.context).pipe(
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
						memory: {
							...value.memory,
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
					const turnRecord = accepted.view.session.turns.find(
						(entry) => entry.id === turn,
					)
					const action = turnRecord?.activeAction?.action ?? turnRecord?.action
					const actionModel =
						action === undefined
							? undefined
							: yield* HostActionDriver.make({
									action,
									callId:
										"host-action-" + (turnRecord?.activeAction?.item ?? turn),
								})

					const step = yield* Ref.make(0),
						chatRef = yield* Ref.make(
							yield* Chat.fromPrompt(
								accepted.view.state.value.memory.context.prompt,
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
						at: options.store.read(session).pipe(
							Effect.map((view) => Session.position(view.session)),
							Effect.orDie,
						),
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
																...current.state.value.memory.history,
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
																		memory: {
																			...current.state.value.memory,
																			history,
																			context: entries.reduce(
																				(window, entry) =>
																					ContextWindow.append(
																						window,
																						entry.content,
																					),
																				current.state.value.memory.context,
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
											const model = (
												action === undefined
													? yield* agent.modelCatalog ?? Effect.succeed([])
													: []
											).find(
												(model) =>
													model.provider === selection?.provider &&
													model.id === selection?.model,
											)
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
											const compaction =
												agent.compaction ??
												Option.getOrUndefined(
													yield* Effect.serviceOption(
														ContextCompaction.ContextCompaction,
													),
												)
											if (
												action === undefined &&
												selection !== undefined &&
												model?.contextWindow !== undefined &&
												compaction !== undefined
											) {
												const request = {
													selection,
													window: view.state.value.memory.context,
													toolkit,
													instructions,
													...R.filter(
														{ toolChoice: inner.toolChoice },
														Predicate.isNotUndefined,
													),
												}
												const tokens = yield* compaction.count(request),
													limits = ConfigurationOperations.contextLimits(model)
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
													tokens >= (limits.autoCompactTokens ?? Infinity)
												)
													view = (yield* compact({
														session,
														expected: view.session.head,
														targetTokens: limits.autoCompactTokens!,
														selection,
														request,
													})).view
											}
											const window = view.state.value.memory.context,
												starting = Prompt.concat(instructions, window.prompt)
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
														const failure = Cause.findErrorOption(exit.cause)
														if (
															Option.isSome(failure) &&
															failure.value instanceof SessionStoreError
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
																			current.state.value.memory.history.some(
																				(entry) => entry.id === item,
																			)
																		)
																			return [undefined, Option.none()] as const
																		return [
																			undefined,
																			Option.some({
																				value: {
																					...current.state.value,
																					memory: {
																						...current.state.value.memory,
																						history: A.append(
																							current.state.value.memory
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
																							current.state.value.memory
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
															.pipe(Effect.exit)
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
																const status: Turn.Status = approval
																	? { _tag: "WaitingApproval", result: output }
																	: terminal
																		? { _tag: "Completed", result: output }
																		: { _tag: "Running" }
																return [
																	undefined,
																	Option.some({
																		value: {
																			...current.state.value,
																			memory: {
																				...current.state.value.memory,
																				history: A.append(
																					current.state.value.memory.history,
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
																					current.state.value.memory.context,
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
																									? { completedAt: Date.now() }
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
													if (approval)
														yield* SynchronizedRef.update(
															continuations,
															(entries) => HashMap.set(entries, session, turn),
														)
													else if (stop) yield* clearContinuation(session, turn)
													return stop && ended.status._tag === "Running"
														? Stream.succeed(versionEvent(committed))
														: stop
															? Stream.make(versionEvent(committed), {
																	_tag: approval
																		? "TurnWaitingApproval"
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
								return loop(
									(Session.currentTurn(accepted.view.session)?.steps ?? 0) + 1,
								).pipe(
									Stream.map(
										(event) => event as Agent.Event<Toolkit.MergedTools<[TK]>>,
									),
								)
							}),
						)
					const body = Stream.suspend(() =>
						middleware === undefined
							? next<Toolkit.Any, E, R>({
									...context.options,
									toolkit:
										agent.toolkit === undefined
											? Effect.succeed(Toolkit.empty)
											: Predicate.hasProperty(agent.toolkit, "toHandlers")
												? Effect.succeed(agent.toolkit)
												: agent.toolkit,
									instructions: Prompt.empty,
								}).pipe(Stream.map((event) => event as Event))
							: middleware(next, {
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
								const latest = yield* Effect.exit(options.store.read(session))
								if (Exit.isFailure(latest)) return
								const current = Session.currentTurn(latest.value.session)
								if (current?.id === turn && !Turn.isTerminal(current.status)) {
									const shouldClose =
										Exit.isFailure(exit) ||
										Match.value(current.status).pipe(
											Match.tag(
												"Running",
												() =>
													!latest.value.session.pending.some(
														(entry) =>
															entry.kind === "action" && entry.turn === turn,
													),
											),
											Match.orElse(() => false),
										)
									if (shouldClose)
										yield* Effect.exit(
											close(
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
											),
										)
								}
							}),
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
										const pending = view.session.pending.find(
											(entry) =>
												entry.kind === "action" &&
												entry.turn === phase.turn &&
												entry.action !== undefined,
										)
										if (
											pending === undefined ||
											pending.action === undefined ||
											turn.status._tag !== "Running"
										)
											return [undefined, Option.none()] as const
										const action = pending.action
										return [
											pending,
											Option.some({
												value: {
													...view.state.value,
													memory: {
														...view.state.value.memory,
														history: A.append(view.state.value.memory.history, {
															id: pending.id,
															content: pending.content,
															origin: {
																session: view.session.id,
																turn: phase.turn,
																step: turn.steps,
															},
														}),
														context: ContextWindow.append(
															view.state.value.memory.context,
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
							return changed.result === undefined
								? Stream.empty
								: next({
										view: changed.view,
										turn: phase.turn,
										item: changed.result.id,
										prompt: changed.result.content,
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
					!Match.value(current.status).pipe(
						Match.tag("Completed", () => true),
						Match.orElse(() => false),
					)
				)
					return undefined
				const accepted = yield* accept(
					{
						base: { session, revision: view.session.revision },
						input: queued.content,
					},
					queued,
				)
				yield* launch(accepted)
				return receipt(accepted.view, accepted.turn, accepted.item)
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
							if (
								!Match.value(turn.status).pipe(
									Match.tag("Running", () => true),
									Match.orElse(() => false),
								)
							)
								return yield* new Turn.Conflict({
									session: input.session,
									turn: input.turn,
									message: "Steering needs a running Turn",
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
				const running = Option.getOrUndefined(
					HashMap.get(yield* SynchronizedRef.get(active), input.session),
				)
				if (running?.turn === input.turn) yield* Fiber.interrupt(running.fiber)
				return yield* close(input.session, input.turn, { _tag: "Interrupted" })
			})
		const approve: Session.Runtime<P, Tools, E, R, HostTools>["approve"] = (
			input,
		) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const item = Item.Id.make(yield* id())
					const { view } = yield* restore(
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
									if (!(yield* canApprove(input)))
										return yield* new Turn.Conflict({
											session: input.session,
											turn: input.turn,
											message: "The approval continuation is no longer loaded",
										})
									if (
										!Match.value(turn.status).pipe(
											Match.tag("WaitingApproval", () => true),
											Match.orElse(() => false),
										)
									)
										return yield* new Turn.Conflict({
											session: input.session,
											turn: input.turn,
											message: "The Turn is not waiting for approval",
										})
									const prompt = fullHistory(view.state.value)
									let requests = HashSet.empty<string>(),
										responses = HashSet.empty<string>()
									for (const message of prompt.content)
										Match.value(message).pipe(
											Match.when({ role: "assistant" }, (message) => {
												for (const part of message.content)
													Match.value(part).pipe(
														Match.when(
															{ type: "tool-approval-request" },
															(part) => {
																requests = HashSet.add(
																	requests,
																	part.approvalId,
																)
															},
														),
														Match.orElse(() => {}),
													)
											}),
											Match.when({ role: "tool" }, (message) => {
												for (const part of message.content)
													Match.value(part).pipe(
														Match.when(
															{ type: "tool-approval-response" },
															(part) => {
																responses = HashSet.add(
																	responses,
																	part.approvalId,
																)
															},
														),
														Match.orElse(() => {}),
													)
											}),
											Match.orElse(() => {}),
										)
									if (
										!HashSet.has(requests, input.approval) ||
										HashSet.has(responses, input.approval)
									)
										return yield* new Turn.Conflict({
											session: input.session,
											turn: input.turn,
											message: "The approval request is no longer pending",
										})
									const content = Prompt.make([
										{
											role: "tool",
											content: [
												Prompt.toolApprovalResponsePart({
													approvalId: input.approval,
													approved: input.approved,
												}),
											],
										},
									])
									return [
										undefined,
										Option.some({
											value: {
												...view.state.value,
												memory: {
													...view.state.value.memory,
													closed: false,
													history: A.append(view.state.value.memory.history, {
														id: item,
														content,
														origin: {
															session: input.session,
															turn: input.turn,
															step: turn.steps,
														},
													}),
													context: ContextWindow.append(
														view.state.value.memory.context,
														content,
													),
												},
											},
											session: {
												turns: view.session.turns.map((entry) =>
													entry.id === input.turn
														? {
																...entry,
																items: A.append(entry.items, item),
																status: { _tag: "Running" as const },
															}
														: entry,
												),
											},
										}),
									] as const
								}),
						}),
					)
					yield* clearContinuation(input.session, input.turn)
					yield* launch({ view, turn: input.turn, item, prompt: Prompt.empty })
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
					HashMap.has(yield* SynchronizedRef.get(active), session) ||
					(yield* canApprove({ session, turn: current.id }))
				)
					return view
				return yield* close(session, current.id, { _tag: "Interrupted" })
			})
		const belongs = (event: Event, session: Session.Id) =>
			Match.value(event).pipe(
				Match.tag(
					"VersionCreated",
					"TurnWaitingApproval",
					"TurnCompleted",
					({ view }) => view.session.id === session,
				),
				Match.orElse((event) => event.at.session === session),
			)
		const revision = (event: Event) =>
			Match.value(event).pipe(
				Match.tag(
					"VersionCreated",
					"TurnWaitingApproval",
					"TurnCompleted",
					({ view }) => view.session.revision,
				),
				Match.orElse((event) => event.at.revision),
			)
		const events: Session.Runtime<P, Tools, E, R, HostTools>["events"] = (
			input,
		) =>
			Stream.unwrap(
				Effect.gen(function* () {
					yield* options.store.read(input.session)
					const subscription = yield* PubSub.subscribe(bus)
					const snapshot = retained.filter(
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
				const driver = Option.isSome(existing)
					? existing.value
					: yield* HostActionDriver.make({ action, callId: "host-action" })
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
								(yield* canApprove({ session: view.session.id, turn }))
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

		const approveAction: Session.Runtime<
			P,
			Tools,
			E,
			R,
			HostTools
		>["approveAction"] = (input) =>
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
				return yield* withActionDriver(action, approve(input))
			})
		return {
			startAction,
			approveAction,
			canApprove,
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
			approve,
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
	) => Layer.Layer<I, BuildE, Exclude<BuildR, import("effect").Scope.Scope>>
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
	): Layer.Layer<I, BuildE, Exclude<BuildR, import("effect").Scope.Scope>>
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
