import {
	Agent,
	Config,
	Item,
	Plugin,
	Session,
	SessionRuntime,
	SessionStore,
	SessionStoreRepository,
	Store,
	Turn,
} from "@openbot-build/core"
import {
	Memory,
	MemoryRules,
	LanguageModelMemory,
	MemoryOperations,
} from "@openbot-build/plugin-memory"
import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	HashMap,
	Layer,
	Match,
	Option,
	Predicate,
	Scope,
	Schema,
	Stream,
} from "effect"
import {
	LanguageModel,
	Prompt,
	Toolkit,
	type Response,
	type Tool,
} from "effect/ai"
import {
	SessionBusy,
	SessionConflict,
	SessionExecutionUnavailable,
	SessionInvalidRecord,
	SessionModelInvalid,
	type SessionResponse,
	type SessionView,
	type StartTurnRequest,
} from "@openbot-build/platform-api"
import { Repository } from "./Repository.ts"
import {
	Sessions,
	type Options,
	type Instance,
	type ExecutionServices,
	type ServiceError,
} from "./Sessions.ts"
import { publicError, inputPrompt, response } from "./ResponseMapping.ts"
import * as SessionEvents from "./SessionEvents.ts"
import * as Approvals from "../approvals/Approvals.ts"
import * as ErrorReporting from "../app/ErrorReporting.ts"
import { Invocations } from "../apps/Invocations.ts"
import { ownerKey } from "../apps/Repository.ts"
import { AppPlugin, empty as emptyAppPlugin } from "../apps/AppPlugin.ts"

/** The response of the current Turn, when the Session has one. */
const currentResponse = (view: Session.View) =>
	Option.map(Option.fromNullishOr(Session.currentTurn(view.session)), (turn) =>
		response(view, turn),
	)

/** One page of records after an optional cursor. The cursor must be a known record. */
const page = <A extends { readonly id: unknown }>(
	all: ReadonlyArray<A>,
	input: { readonly after?: A["id"]; readonly limit?: number },
	unknownCursor: string,
): Effect.Effect<
	{ readonly items: ReadonlyArray<A>; readonly next: A["id"] | null },
	SessionConflict
> => {
	const offset =
		input.after === undefined
			? 0
			: all.findIndex((entry) => entry.id === input.after) + 1
	if (input.after !== undefined && offset === 0)
		return Effect.fail(SessionConflict.make({ message: unknownCursor }))
	const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)))
	const items = all.slice(offset, offset + limit)
	return Effect.succeed({
		items,
		next:
			offset + limit < all.length
				? Option.getOrNull(Option.map(Array.last(items), (entry) => entry.id))
				: null,
	})
}

export const make = <
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
>(
	options: Options<Tools, E, R, BuildE, BuildR> = {},
): Effect.Effect<
	Instance<Tools, E, R>,
	Session.SessionError | SessionStore.SessionStoreError | BuildE,
	| BuildR
	| Approvals.Approvals
	| Repository
	| Scope.Scope
	| ExecutionServices<Tools, R>
> =>
	Effect.gen(function* () {
		const repository = yield* Repository,
			approvals = yield* Approvals.Approvals,
			scope = yield* Scope.Scope
		const namespace = options.namespace ?? "local"
		const environment = yield* Effect.context<ExecutionServices<Tools, R>>()
		const fallback = yield* Effect.serviceOption(LanguageModel.LanguageModel)
		const appPlugin = yield* Effect.serviceOption(AppPlugin)
		const appInvocations = yield* Effect.serviceOption(Invocations)
		const modelFor = (view: Session.View, turn?: Turn.Record) =>
			options.resolveModel === undefined
				? Effect.serviceOption(LanguageModel.LanguageModel).pipe(
						Effect.flatMap((current) =>
							Effect.fromOption(Option.orElse(current, () => fallback)).pipe(
								Effect.mapError(() =>
									SessionExecutionUnavailable.make({
										session: view.session.id,
									}),
								),
							),
						),
					)
				: options
						.resolveModel(turn?.settings.model ?? view.session.settings.model)
						.pipe(
							Effect.mapError(() =>
								SessionExecutionUnavailable.make({ session: view.session.id }),
							),
						)
		const definition = yield* Store.define({
			stores: Memory.stores,
			schemaVersion: "memory/1",
		})
		const store = yield* SessionStoreRepository.make({
			definition,
			persistence: repository.store(namespace),
			onCommit: ({ delta, view }) =>
				repository
					.save(namespace, {
						delta,
						response: Option.flatMap(
							Option.fromNullishOr(view),
							currentResponse,
						),
					})
					.pipe(
						Effect.tap(() => {
							if (view === undefined) return Effect.void
							const turn = Session.currentTurn(view.session)
							const previous = delta.expected?.turns.find(
								(entry) => entry.id === turn?.id,
							)
							return turn === undefined ||
								previous === undefined ||
								previous.status._tag === "Failed"
								? Effect.void
								: ErrorReporting.failedTurn(turn)
						}),
					),
			onRemove: (ref) => repository.remove(namespace, ref),
		})
		const memoryPolicy = options.memory?.policy ?? MemoryRules.policy
		const memories = MemoryOperations.make({
			store,
			policy: memoryPolicy,
			model: options.memory?.model ?? LanguageModelMemory.model,
		})
		const plugin = Plugin.make({ id: Memory.pluginId })<
			Tools,
			| E
			| Session.SessionNotFound
			| Session.SessionError
			| SessionStore.SessionStoreError,
			R,
			BuildE,
			BuildR
		>(() =>
			Effect.gen(function* () {
				const middleware =
					options.runtime?.plugin === undefined
						? undefined
						: yield* options.runtime.plugin.middleware
				return (next, input) =>
					Stream.unwrap(
						Effect.gen(function* () {
							const context = yield* Agent.Context,
								at = yield* context.at,
								view = yield* store.read(at.session)
							const memory =
								view.state.value["@openbot-build/plugin-memory"] ??
								Memory.empty()
							const text = (
								Session.currentTurn(view.session)?.settings ??
								view.session.settings
							).memoryEnabled
								? memoryPolicy.project(memory)
								: ""
							const configured = options.runtime?.toolkit
							const supplied = {
								...input,
								instructions:
									text === ""
										? input.instructions
										: Prompt.concat(
												input.instructions,
												Prompt.make([
													{
														role: "system",
														content:
															"Historical memory is evidence with a limited scope. Follow the current instructions.\n" +
															text,
													},
												]),
											),
								toolkit:
									configured === undefined
										? input.toolkit
										: Effect.gen(function* () {
												const incoming = yield* input.toolkit,
													selected = Predicate.hasProperty(
														configured,
														"toHandlers",
													)
														? configured
														: yield* configured
												return Toolkit.merge(incoming, selected)
											}),
							}
							const stream =
								middleware === undefined
									? next(supplied)
									: middleware(next, supplied)
							if (options.layerExecution === undefined) return stream
							const currentEnvironment = yield* Effect.context<R>()
							const execution = yield* Layer.build(
								options.layerExecution(view.session, namespace),
							)
							// Each Turn owns the host resources built for its Session.
							return stream.pipe(
								Stream.provideContext(
									Context.merge(
										Context.merge(environment, currentEnvironment),
										execution,
									),
								),
							)
						}),
					)
			}),
		)
		const runtime = yield* SessionRuntime.make({
			store,
			agent: {
				...options.runtime,
				plugin,
				hostPlugin:
					options.owner === undefined || Option.isNone(appPlugin)
						? emptyAppPlugin
						: appPlugin.value.forOwner(options.owner),
			},
		})
		const read = (id: Session.Id) =>
			store.read(id).pipe(Effect.mapError(publicError))
		const project = (
			view: Session.View<Memory.Values>,
		): Effect.Effect<SessionView> =>
			Effect.gen(function* () {
				const active = yield* runtime.isActive(view.session.id)
				const current = Session.currentTurn(view.session)
				const approvalLoaded =
					current === undefined
						? false
						: yield* runtime.canApprove({
								session: view.session.id,
								turn: current.id,
							})
				return {
					...view,
					response: Option.getOrNull(currentResponse(view)),
					activity: active
						? ("active" as const)
						: Match.value(Session.status(view.session)).pipe(
								Match.tag("Running", () => "historical" as const),
								Match.tag("WaitingApproval", () =>
									approvalLoaded
										? ("inactive" as const)
										: ("historical" as const),
								),
								Match.orElse(() => "inactive" as const),
							),
				}
			})
		const get = (id: Session.Id) => read(id).pipe(Effect.flatMap(project))
		const idle = (id: Session.Id) =>
			runtime
				.isActive(id)
				.pipe(
					Effect.flatMap((active) =>
						active
							? Effect.fail(SessionBusy.make({ session: id }))
							: Effect.void,
					),
				)
		const catalog =
			options.modelCatalog ?? Effect.succeed({ providers: [], models: [] })
		const validateSelection = (selection: Config.Selection) =>
			Effect.gen(function* () {
				const available = yield* catalog
				if (
					!available.providers.some(
						(provider) => provider.id === selection.provider,
					)
				)
					return yield* SessionModelInvalid.make({
						reason: "provider-not-found",
						message: "The provider does not exist",
					})
				const model = available.models.find(
					(model) =>
						model.provider === selection.provider &&
						model.id === selection.model,
				)
				if (model === undefined)
					return yield* SessionModelInvalid.make({
						reason: "model-not-found",
						message: "The model does not exist",
					})
				if (
					(selection.reasoningEffort !== undefined &&
						!model.reasoningEfforts.includes(selection.reasoningEffort)) ||
					(selection.serviceTier !== undefined &&
						!model.serviceTiers.includes(selection.serviceTier))
				)
					return yield* SessionModelInvalid.make({
						reason: "unsupported-option",
						message: "The selected model options are not supported",
					})
				return options.modelDefaults === undefined
					? selection
					: yield* options.modelDefaults(selection)
			})
		const create: typeof Sessions.Service.create = (input) =>
			Effect.gen(function* () {
				const defaults = yield* options.defaults ?? Effect.succeed({})
				const settings = { ...defaults, ...input.settings }
				const model =
					settings.model === undefined
						? undefined
						: yield* validateSelection(settings.model)
				return yield* store
					.create({
						metadata: {
							...(input.title === undefined ? {} : { title: input.title }),
						},
						settings: {
							...settings,
							...(model === undefined ? {} : { model }),
						},
					})
					.pipe(Effect.mapError(publicError), Effect.flatMap(project))
			})
		const models: typeof Sessions.Service.models = (id) =>
			Effect.gen(function* () {
				const view = yield* read(id),
					available = yield* catalog
				return {
					...available,
					...(view.session.settings.model === undefined
						? {}
						: { selected: view.session.settings.model }),
				}
			})
		const settings: typeof Sessions.Service.settings = (id, input) =>
			Effect.gen(function* () {
				const selection =
					input.settings.model === undefined
						? undefined
						: yield* validateSelection(input.settings.model)
				const { view } = yield* store
					.modifyEffect({
						session: id,
						expectedRevision: input.expected,
						update: () =>
							Effect.succeed([
								undefined,
								Option.some({
									session: {
										settings: {
											...input.settings,
											...(selection === undefined ? {} : { model: selection }),
										},
									},
								}),
							] as const),
					})
					.pipe(Effect.mapError(publicError))
				return yield* project(view)
			})
		const selectModel: typeof Sessions.Service.selectModel = (id, input) =>
			Effect.gen(function* () {
				const view = yield* read(id)
				return yield* settings(id, {
					expected: input.expected,
					settings: { ...view.session.settings, model: input.selection },
				})
			})
		const selectMode: typeof Sessions.Service.selectMode = (id, input) =>
			store
				.modifyEffect({
					session: id,
					expectedRevision: input.expected,
					update: (view) =>
						Effect.succeed([
							undefined,
							Option.some({
								session: {
									settings: { ...view.session.settings, mode: input.mode },
								},
							}),
						] as const),
				})
				.pipe(
					Effect.mapError(publicError),
					Effect.flatMap(({ view }) => project(view)),
				)
		const update: typeof Sessions.Service.update = (id, input) =>
			store
				.modifyEffect({
					session: id,
					expectedRevision: input.expected,
					update: (view) =>
						Effect.succeed([
							undefined,
							Option.some({
								session: {
									metadata: {
										...view.session.metadata,
										...(input.title === undefined
											? {}
											: { title: input.title }),
										...(input.archived === undefined
											? {}
											: { archived: input.archived }),
									},
								},
							}),
						] as const),
				})
				.pipe(
					Effect.mapError(publicError),
					Effect.flatMap(({ view }) => project(view)),
				)
		const list: typeof Sessions.Service.list = (input) =>
			repository.list(namespace, input).pipe(
				Effect.mapError(publicError),
				Effect.flatMap((rows) =>
					Effect.forEach(rows, (row) =>
						runtime.isActive(row.session.id).pipe(
							Effect.map((active) => ({
								...row,
								activity: active ? ("active" as const) : row.activity,
							})),
						),
					),
				),
			)
		const history: typeof Sessions.Service.history = (id, version) =>
			version === undefined
				? read(id).pipe(Effect.map((view) => view.state))
				: store.read(id, version).pipe(Effect.mapError(publicError))
		const fork: typeof Sessions.Service.fork = (id, input) =>
			Effect.gen(function* () {
				const source = yield* read(id)
				const settings =
					input.settings?.model === undefined
						? input.settings
						: {
								...input.settings,
								model: yield* validateSelection(input.settings.model),
							}
				return yield* store
					.fork({
						source: id,
						...(input.version === undefined ? {} : { version: input.version }),
						metadata: {
							title: input.title ?? source.session.metadata.title,
						},
						...(settings === undefined ? {} : { settings }),
					})
					.pipe(Effect.mapError(publicError), Effect.flatMap(project))
			})
		const restore: typeof Sessions.Service.restore = (id, input) =>
			Effect.gen(function* () {
				yield* idle(id)
				if (input.expected !== null) yield* read(id)
				if (
					input.record.session.id !== id ||
					(input.expected !== null && input.expected.id !== id)
				)
					return yield* SessionInvalidRecord.make({
						message: "The record identity does not match the target Session",
					})
				return yield* store
					.import(input)
					.pipe(Effect.mapError(publicError), Effect.flatMap(project))
			})
		const pendingApprovals: typeof Sessions.Service.pendingApprovals = (id) =>
			Effect.gen(function* () {
				const view = yield* read(id),
					current = Session.currentTurn(view.session)
				if (
					current === undefined ||
					!(yield* runtime.canApprove({ session: id, turn: current.id })) ||
					!Match.value(current.status).pipe(
						Match.tag("WaitingApproval", () => true),
						Match.orElse(() => false),
					)
				)
					return []
				return yield* Effect.forEach(approvals.pending(view), (entry) =>
					Effect.gen(function* () {
						const arguments_ = yield* Schema.decodeUnknownEffect(
							Schema.JsonObject,
						)(entry.toolCall.params).pipe(Effect.mapError(publicError))
						const app =
							options.owner === undefined || Option.isNone(appInvocations)
								? Option.none()
								: yield* appInvocations.value
										.pending(
											{
												owner: ownerKey(options.owner),
												session: id,
												turn: current.id,
											},
											entry.toolCallId,
										)
										.pipe(
											Effect.mapError(() =>
												SessionConflict.make({
													message: "The App approval could not be read.",
												}),
											),
										)
						return {
							turn: current.id,
							approvalId: entry.approvalId,
							toolCallId: entry.toolCallId,
							toolName: entry.toolCall.name,
							arguments: arguments_,
							...Option.match(app, {
								onNone: () => ({}),
								onSome: (app) => ({ app }),
							}),
						}
					}),
				)
			})
		const turns: typeof Sessions.Service.turns = (id, input) =>
			Effect.flatMap(read(id), (view) =>
				page(
					[...view.session.inheritedTurns, ...view.session.turns],
					input,
					"The Turn cursor does not belong to this Session",
				),
			)
		const turn: typeof Sessions.Service.turn = (id, turn) =>
			Effect.gen(function* () {
				const view = yield* read(id),
					selected = [
						...view.session.inheritedTurns,
						...view.session.turns,
					].find((entry) => entry.id === turn)
				if (selected === undefined)
					return yield* SessionConflict.make({
						message: "The Turn does not belong to this Session",
					})
				return { turn: selected, response: response(view, selected) }
			})
		const items: typeof Sessions.Service.items = (id, turnId, input) =>
			Effect.gen(function* () {
				const view = yield* read(id)
				yield* turn(id, turnId)
				return yield* page(
					view.state.value.memory.history.filter(
						(entry) => entry.origin?.turn === turnId,
					),
					input,
					"The Item cursor does not belong to this Turn",
				)
			})
		const start = (
			id: Session.Id,
			input: StartTurnRequest,
			sink?: SessionEvents.Sink,
		): Effect.Effect<
			SessionResponse,
			ServiceError | SessionExecutionUnavailable
		> =>
			Effect.gen(function* () {
				const view = yield* read(id)
				const overrides =
					input.overrides?.model === undefined
						? input.overrides
						: {
								...input.overrides,
								model: yield* validateSelection(input.overrides.model),
							}
				const model = yield* modelFor({
					...view,
					session: {
						...view.session,
						settings: { ...view.session.settings, ...overrides },
					},
				})
				const current = Session.currentTurn(view.session)
				if (current !== undefined && !Turn.isTerminal(current.status))
					return yield* SessionBusy.make({ session: id })
				const accepted = yield* Deferred.make<SessionResponse, ServiceError>()
				let acknowledged = false,
					terminal = false,
					reportedFailure = false,
					selectedTurn: Turn.Id | undefined,
					step: number | undefined
				let outputs = HashMap.empty<
					Item.Id,
					{ readonly index: number; readonly text: string }
				>()
				const emit = (event: SessionEvents.Payload) =>
					sink === undefined || selectedTurn === undefined
						? Effect.void
						: sink
								.emit({
									...event,
									session: id,
									turn: selectedTurn,
									...(step === undefined ? {} : { step }),
								})
								.pipe(Effect.asVoid)
				const finish = (result: SessionResponse) =>
					sink === undefined
						? Effect.void
						: sink
								.finish([
									{
										session: id,
										turn: result.id,
										...(step === undefined ? {} : { step }),
										type: Match.value(result).pipe(
											Match.when(
												{ status: "completed" },
												() => "response.completed" as const,
											),
											Match.when(
												{ status: "failed" },
												() => "response.failed" as const,
											),
											Match.when(
												{ status: "cancelled" },
												() => "response.cancelled" as const,
											),
											Match.orElse(() => "response.incomplete" as const),
										),
										response: result,
									},
								])
								.pipe(Effect.asVoid)
				const execution = runtime
					.stream({
						base: { session: id, revision: input.expected },
						input: inputPrompt(input.input),
						...(overrides === undefined ? {} : { overrides }),
					})
					.pipe(
						Stream.provideContext(
							Context.add(environment, LanguageModel.LanguageModel, model),
						),
						Stream.runForEach((event) =>
							Match.value(event).pipe(
								Match.tag("TurnStarted", (event) =>
									Effect.gen(function* () {
										selectedTurn = event.turn
										const current = yield* read(id),
											record = Session.currentTurn(current.session)!
										const result = response(current, record)
										acknowledged = true
										yield* Deferred.succeed(accepted, result)
										yield* emit({ type: "response.created", response: result })
										yield* emit({
											type: "response.in_progress",
											response: result,
										})
									}),
								),
								Match.tag("ResponsePart", (event) =>
									Effect.gen(function* () {
										step = event.step
										if (sink === undefined) return
										const output = yield* Option.match(
											HashMap.get(outputs, event.item),
											{
												onSome: (entry) => Effect.succeed(entry),
												onNone: () =>
													Effect.gen(function* () {
														const entry = {
															index: HashMap.size(outputs),
															text: "",
														}
														outputs = HashMap.set(outputs, event.item, entry)
														yield* emit({
															type: "response.output_item.added",
															output_index: entry.index,
															item: {
																id: event.item,
																type: "message",
																role: "assistant",
																status: "in_progress",
																content: [],
															},
														})
														yield* emit({
															type: "response.content_part.added",
															item_id: event.item,
															output_index: entry.index,
															content_index: 0,
															part: {
																type: "output_text",
																text: "",
																annotations: [] as const,
															},
														})
														return entry
													}),
											},
										)
										const indices = {
											item_id: event.item,
											output_index: output.index,
											content_index: 0,
										}
										yield* Match.value<
											Response.StreamPart<Record<string, Tool.Any>>
										>(event.part).pipe(
											Match.discriminator("type")("text-delta", (part) =>
												Effect.gen(function* () {
													outputs = HashMap.set(outputs, event.item, {
														...output,
														text: output.text + part.delta,
													})
													yield* emit({
														type: "response.output_text.delta",
														...indices,
														delta: part.delta,
														logprobs: [],
													})
												}),
											),
											Match.discriminator("type")("finish", (part) =>
												Effect.gen(function* () {
													const text = Option.match(
															HashMap.get(outputs, event.item),
															{
																onNone: () => output.text,
																onSome: (entry) => entry.text,
															},
														),
														content = {
															type: "output_text" as const,
															text,
															annotations: [] as const,
														}
													yield* emit({
														type: "response.output_text.done",
														...indices,
														text,
														logprobs: [],
													})
													yield* emit({
														type: "response.content_part.done",
														...indices,
														part: content,
													})
													yield* emit({
														type: "response.output_item.done",
														output_index: output.index,
														item: {
															id: event.item,
															type: "message",
															role: "assistant",
															status: ["stop", "tool-calls"].includes(
																part.reason,
															)
																? "completed"
																: "incomplete",
															content: [content],
														},
													})
												}),
											),
											Match.orElse(() => Effect.void),
										)
									}),
								),
								Match.tag("TurnCompleted", "TurnWaitingApproval", (event) =>
									Effect.gen(function* () {
										terminal = true
										reportedFailure = event.turn.status._tag === "Failed"
										yield* finish(response(event.view, event.turn))
										if (
											Match.value(event.turn.status).pipe(
												Match.tag("Completed", () => true),
												Match.orElse(() => false),
											)
										)
											yield* memories
												.consolidate(id, {
													enabled:
														event.turn.settings.memoryGenerationEnabled ?? true,
												})
												.pipe(
													Effect.provideService(
														LanguageModel.LanguageModel,
														model,
													),
													Effect.catchTag("MemoryError", (error) =>
														ErrorReporting.record({
															source: "turn",
															operation: "memory.consolidate",
															sessionId: id,
															turnId: event.turn.id,
															cause: Cause.fail(error),
														}).pipe(Effect.andThen(store.read(id))),
													),
													Effect.asVoid,
												)
									}),
								),
								Match.orElse(() => Effect.void),
							),
						),
						Effect.onExit((exit) =>
							Effect.gen(function* () {
								if (!acknowledged) {
									const failed = Exit.isFailure(exit)
										? Cause.findErrorOption(exit.cause)
										: Option.none()
									if (
										Exit.isFailure(exit) &&
										Option.isNone(failed) &&
										!Cause.hasInterruptsOnly(exit.cause)
									)
										yield* ErrorReporting.record({
											source: "turn",
											operation: "turn.accept",
											sessionId: id,
											cause: exit.cause,
										})
									yield* Deferred.fail(
										accepted,
										Option.match(
											Option.filter(
												failed,
												(error) =>
													error instanceof SessionStore.SessionStoreError,
											),
											{
												onSome: publicError,
												onNone: () =>
													SessionConflict.make({
														message: "The Turn could not be accepted",
													}),
											},
										),
									)
									if (sink !== undefined) yield* sink.finish([])
									return
								}
								if (
									Exit.isFailure(exit) &&
									!reportedFailure &&
									!Cause.hasInterruptsOnly(exit.cause)
								) {
									const saved = yield* Effect.exit(store.read(id))
									const persistedFailure =
										Exit.isSuccess(saved) &&
										saved.value.session.turns.some(
											(turn) =>
												turn.id === selectedTurn &&
												turn.status._tag === "Failed",
										)
									if (!persistedFailure)
										yield* ErrorReporting.record({
											source: "turn",
											operation: terminal ? "turn.postprocess" : "turn.execute",
											sessionId: id,
											...(selectedTurn === undefined
												? {}
												: { turnId: selectedTurn }),
											cause: exit.cause,
										})
								}
								if (
									terminal &&
									selectedTurn !== undefined &&
									Exit.isSuccess(exit)
								) {
									const current = yield* store.read(id).pipe(Effect.exit)
									if (
										Exit.isSuccess(current) &&
										Session.currentTurn(current.value.session)?.id ===
											selectedTurn
									)
										yield* runtime.runQueued(id).pipe(
											Effect.provideContext(
												Context.add(
													environment,
													LanguageModel.LanguageModel,
													model,
												),
											),
											Effect.catch((error) =>
												(error instanceof SessionStore.SessionStoreError &&
													error.reason === "storage-failed") ||
												(error instanceof Session.SessionError &&
													error.reason === "unavailable")
													? ErrorReporting.record({
															source: "turn",
															operation: "turn.runQueued",
															sessionId: id,
															cause: Cause.fail(error),
														})
													: Effect.logDebug(
															"The queued Turn could not start",
															error,
														),
											),
											Effect.tapCause((cause) =>
												Cause.hasInterruptsOnly(cause)
													? Effect.void
													: ErrorReporting.record({
															source: "turn",
															operation: "turn.runQueued",
															sessionId: id,
															cause,
														}),
											),
										)
									return
								}
								if (terminal || selectedTurn === undefined) return
								const latest = yield* Effect.exit(store.read(id))
								if (Exit.isSuccess(latest)) {
									const record = latest.value.session.turns.find(
										(entry) => entry.id === selectedTurn,
									)
									if (record !== undefined && Turn.isTerminal(record.status)) {
										yield* finish(response(latest.value, record))
										return
									}
								}
								if (sink !== undefined) yield* sink.finish([])
							}),
						),
					)
				yield* Effect.forkIn(execution, scope)
				return yield* Deferred.await(accepted)
			})
		const send: typeof Sessions.Service.send = (id, input) => start(id, input)
		const sendStream: typeof Sessions.Service.sendStream = (id, input) =>
			Effect.gen(function* () {
				const sink = yield* SessionEvents.make
				yield* start(id, input, sink)
				return sink.stream
			})
		const startAction: typeof Sessions.Service.startAction = (id, input) =>
			Effect.gen(function* () {
				yield* read(id)
				return yield* runtime
					.startAction({
						base: { session: id, revision: input.expected },
						action: input.action,
						...(input.turn === undefined ? {} : { turn: input.turn }),
					})
					.pipe(
						Effect.provideContext(environment),
						Effect.mapError(publicError),
					)
			})
		const approve: typeof Sessions.Service.approve = (id, input) =>
			Effect.gen(function* () {
				const view = yield* read(id)
				const turn = Session.currentTurn(view.session)
				const model =
					turn?.action !== undefined || turn?.activeAction !== undefined
						? undefined
						: yield* modelFor(view, turn)
				if (
					view.session.revision !== input.expected ||
					Session.currentTurn(view.session)?.id !== input.turn
				)
					return yield* SessionConflict.make({
						message:
							"The approval belongs to an earlier Session revision or Turn.",
					})
				const pending = yield* pendingApprovals(id)
				const selected = pending.find(
					(entry) => entry.approvalId === input.approvalId,
				)
				if (selected === undefined)
					return yield* SessionConflict.make({
						message: "This approval is no longer active.",
					})
				if (
					selected.app !== undefined &&
					options.owner !== undefined &&
					Option.isSome(appInvocations)
				)
					yield* appInvocations.value
						.approve(
							{ owner: ownerKey(options.owner), session: id, turn: input.turn },
							selected.toolCallId,
							input.approved,
							input.grantReads ?? false,
						)
						.pipe(
							Effect.mapError(() =>
								SessionConflict.make({
									message:
										"The App or its approval changed. Review the current operation.",
								}),
							),
						)
				const approval = {
					session: id,
					turn: input.turn,
					approval: input.approvalId,
					approved: input.approved,
					expectedRevision: input.expected,
				}
				yield* (
					model === undefined
						? runtime
								.approveAction(approval)
								.pipe(Effect.provideContext(environment))
						: runtime
								.approve(approval)
								.pipe(
									Effect.provideContext(
										Context.add(
											environment,
											LanguageModel.LanguageModel,
											model,
										),
									),
								)
				).pipe(Effect.mapError(publicError))

				const latest = yield* read(id)
				return response(latest, Session.currentTurn(latest.session)!)
			})
		const updateMemory: typeof Sessions.Service.updateMemory = (id, input) =>
			Effect.gen(function* () {
				const view = yield* read(id)
				const changed = yield* Match.value(input.command).pipe(
					Match.tag("Refresh", () =>
						Effect.gen(function* () {
							const model = yield* modelFor(view).pipe(
								Effect.mapError(() =>
									SessionConflict.make({
										message: "Memory extraction needs an available model",
									}),
								),
							)
							return yield* memories
								.consolidate(id)
								.pipe(
									Effect.provideService(LanguageModel.LanguageModel, model),
									Effect.mapError(publicError),
								)
						}),
					),
					Match.orElse((command) =>
						memories
							.update(
								{
									session: id,
									version: input.expected,
									revision: input.revision,
								},
								command,
							)
							.pipe(Effect.mapError(publicError)),
					),
				)
				return yield* project(changed)
			})
		return {
			...Sessions.of({
				create,
				get,
				list,
				update,
				fork,
				restore,
				models,
				selectModel,
				selectMode,
				settings,
				turns,
				turn,
				items,
				pendingApprovals,
				send,
				startAction,
				sendStream,
				approve,
				updateMemory,
				history,
				versions: (id) =>
					read(id).pipe(
						Effect.flatMap((view) =>
							store
								.log({ from: view.session.head })
								.pipe(Effect.mapError(publicError)),
						),
					),
				memory: (id) => memories.read(id).pipe(Effect.mapError(publicError)),
				exportRecord: (id) =>
					store.export(id).pipe(Effect.mapError(publicError)),
				remove: (id) =>
					idle(id).pipe(
						Effect.andThen(read(id)),
						Effect.flatMap((view) =>
							store.remove(view.session).pipe(Effect.mapError(publicError)),
						),
					),
				resume: (id) =>
					runtime
						.resume(id)
						.pipe(Effect.mapError(publicError), Effect.flatMap(project)),
				wait: (id, after, timeoutMs, afterActivity) =>
					runtime
						.wait({
							session: id,
							after,
							...(afterActivity === undefined
								? {}
								: { afterActive: afterActivity === "active" }),
							timeout: Math.min(timeoutMs ?? 30000, 30000),
						})
						.pipe(Effect.mapError(publicError), Effect.flatMap(project)),
				interrupt: (id, turn) =>
					runtime
						.interrupt({ session: id, turn })
						.pipe(Effect.mapError(publicError), Effect.flatMap(project)),
				steer: (id, turn, input) =>
					runtime
						.steer({ session: id, turn, input: inputPrompt(input) })
						.pipe(Effect.mapError(publicError)),
				enqueue: (id, input) =>
					runtime
						.enqueue({
							session: id,
							message: inputPrompt(input.input),
							...(input.expected === undefined
								? {}
								: { expectedRevision: input.expected }),
						})
						.pipe(Effect.mapError(publicError)),
			}),
			runtime,
			store,
			consolidate: (id) =>
				memories.consolidate(id).pipe(Effect.mapError(publicError)),
		}
	})
export const layer = <
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
>(
	options: Options<Tools, E, R, BuildE, BuildR> = {},
) => Layer.effect(Sessions, make(options))
