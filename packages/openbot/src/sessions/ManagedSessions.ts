import {
	Agent,
	Config,
	ConfigurationOperations,
	Item,
	Plugin,
	PluginComposition,
	PluginState,
	Session,
	SessionRuntime,
	SessionStore,
	SessionStoreRepository,
	Store,
	Timeline,
	Turn,
} from "@openbot-build/core"
import * as Memory from "../plugins/memory/Memory.ts"
import * as MemoryRules from "../plugins/memory/MemoryRules.ts"
import * as LanguageModelMemory from "../plugins/memory/LanguageModelMemory.ts"
import * as MemoryOperations from "../plugins/memory/MemoryOperations.ts"
import * as MemoryPlugin from "../plugins/memory/MemoryPlugin.ts"
import * as Todos from "../plugins/work/Todos.ts"
import { WorkPlugin } from "../plugins/work/WorkPlugin.ts"
import { ChannelPlugin } from "../plugins/channels/ChannelPlugin.ts"
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
	Stream,
} from "effect"
import { LanguageModel, Toolkit, type Response, type Tool } from "effect/ai"
import {
	SessionBusy,
	SessionConflict,
	SessionExecutionUnavailable,
	SessionInvalidRecord,
	SessionModelInvalid,
	type SessionResponse,
	type SessionView,
} from "@openbot-build/api"
import type { PgClient } from "@effect/sql-pg"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import * as StoredSessions from "./StoredSessions.ts"
import {
	Sessions,
	type Options,
	type Instance,
	type ExecutionServices,
	type SendInput,
	type ServiceError,
} from "./Sessions.ts"
import { publicError, inputPrompt, response } from "./ResponseMapping.ts"
import * as SessionEvents from "./SessionEvents.ts"
import * as SessionHost from "./SessionHost.ts"
import { sessionHostId } from "./SessionHost.ts"
import * as ErrorReporting from "../app/ErrorReporting.ts"
import {
	AppPlugin,
	empty as emptyAppPlugin,
} from "../plugins/apps/AppPlugin.ts"
import { AgentPlugin } from "../plugins/agents/AgentPlugin.ts"
import { Signal, publish } from "../agents/Signals.ts"

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
	BuildR | PgClient.PgClient | Scope.Scope | ExecutionServices<Tools, R>
> =>
	Effect.gen(function* () {
		const db = yield* makeWithDefaults(),
			scope = yield* Scope.Scope
		const namespace = options.namespace ?? "local"
		const environment = yield* Effect.context<ExecutionServices<Tools, R>>()
		const fallback = yield* Effect.serviceOption(LanguageModel.LanguageModel)
		const appPlugin = yield* Effect.serviceOption(AppPlugin)
		const agentPlugin = yield* Effect.serviceOption(AgentPlugin)
		const workPlugin = yield* Effect.serviceOption(WorkPlugin)
		const channelPlugin = yield* Effect.serviceOption(ChannelPlugin)
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
		const memoryPolicy = options.memory?.policy ?? MemoryRules.policy,
			memoryModel = options.memory?.model ?? LanguageModelMemory.model,
			memoryDefaults: Memory.Settings = {
				use: true,
				generate: true,
				...options.memory?.defaults,
			}
		const memoryPlugin = MemoryPlugin.make({
			policy: memoryPolicy,
			model: memoryModel,
			settings: Effect.gen(function* (): Effect.fn.Return<
				Memory.Settings,
				Session.SessionNotFound | SessionStore.SessionStoreError,
				Agent.Context
			> {
				const context = yield* Agent.Context,
					at = yield* context.at,
					view = yield* store.read(at.session)
				const organizationDefaults =
					options.memoryDefaults === undefined
						? {}
						: yield* options.memoryDefaults
				return SessionHost.settings({
					defaults: { ...memoryDefaults, ...organizationDefaults },
					session: view.session,
				})
			}),
			languageModel: Effect.gen(function* (): Effect.fn.Return<
				LanguageModel.LanguageModel,
				| Session.SessionNotFound
				| SessionStore.SessionStoreError
				| SessionExecutionUnavailable,
				Agent.Context
			> {
				const context = yield* Agent.Context,
					at = yield* context.at,
					view = yield* store.read(at.session)
				return yield* modelFor(view, Session.currentTurn(view.session))
			}),
		})
		const host = Plugin.make({
			id: sessionHostId,
			store: SessionHost.sessionHostStore,
		})<
			Tools,
			E | Session.SessionNotFound | SessionStore.SessionStoreError,
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
							const configured = options.runtime?.toolkit
							const supplied = {
								...input,
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
		// Memory runs outside the host plugin, so the user plugin sees the memory instructions.
		const composed = yield* PluginComposition.mergeState(
			sessionHostId,
			memoryPlugin,
			host,
		).pipe(
			// The two plugins have different IDs, so their stores cannot conflict.
			Effect.orDie,
		)
		const definition = yield* Store.define({
			stores: { ...composed.stores, ...Todos.stores },
			schemaVersion: "timeline/1",
		})
		const store: SessionStore.Store<SessionHost.Values> =
			yield* SessionStoreRepository.make({
				definition,
				persistence: StoredSessions.persistence(db, namespace),
				onCommit: ({ delta, view }) =>
					StoredSessions.save(db, namespace, {
						delta,
						response: Option.flatMap(
							Option.fromNullishOr(view),
							currentResponse,
						),
					}).pipe(
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
						Effect.tap(() => {
							if (view === undefined) return Effect.void
							const turn = Session.currentTurn(view.session)
							const previous = delta.expected?.turns.find(
								(entry) => entry.id === turn?.id,
							)
							// Code that writes the store directly may make a Session without OpenBot data.
							if (
								turn === undefined ||
								previous?.status._tag === turn.status._tag ||
								view.session.business[sessionHostId] === undefined
							)
								return Effect.void
							const state = SessionHost.hostState(view.session)
							// Delegation, reviews and memory react to changes of the Turn status.
							return publish(
								Signal.TurnChanged({
									organizationId: state.chain.organizationId,
									// The member whose Sessions hold this Session.
									userId: SessionHost.ownerOf(state.chain),
									session: view.session.id,
									turn: turn.id,
									status: turn.status._tag,
								}),
							)
						}),
					),
				onRemove: (ref) => StoredSessions.remove(db, namespace, ref),
			})
		const memories = MemoryOperations.make({
			store,
			policy: memoryPolicy,
			model: memoryModel,
		})
		const memoryStore = yield* PluginState.make({ store, plugin: memoryPlugin })
		// The root plugin gives the memory plugin its store for each Turn.
		const plugin = Plugin.make({ id: sessionHostId })<
			Tools,
			| E
			| Timeline.VersionError
			| Session.SessionNotFound
			| Session.SessionError
			| SessionStore.SessionStoreError,
			R,
			BuildE,
			BuildR
		>(() =>
			Effect.map(
				composed.middleware,
				(middleware) => (next, input) =>
					middleware(next, input).pipe(
						Stream.provideService(memoryPlugin.store, memoryStore),
						// The memory plugin adds no tools, so the merged tools are Tools.
						// TypeScript cannot reduce MergedTools<[{}, Tools]> to Tools for a generic Tools.
						Stream.map((event) => event as Agent.Event<Tools>),
					),
			),
		)
		const apps =
			options.owner === undefined || Option.isNone(appPlugin)
				? emptyAppPlugin
				: appPlugin.value.forOwner(options.owner)
		const agentPluginFor = (
			agent: typeof AgentPlugin.Service,
			owner: NonNullable<typeof options.owner>,
		) =>
			agent.forOwner({
				owner,
				namespace,
				read: (id) => store.read(id),
				delegatedMemory: (agent) =>
					list({ agent, kind: "delegated" }).pipe(
						Effect.flatMap((rows) =>
							Effect.forEach(rows, (row) =>
								store.read(row.session.id).pipe(
									Effect.map((view) => ({
										session: row.session.id,
										memory: view.state.value[Memory.storeKey] ?? Memory.empty(),
									})),
								),
							),
						),
					),
			})
		// The Agent plugin runs inside the App plugin, so it sees every tool of the Turn.
		// The work and Channel plugins run inside the Agent plugin, so they see the current Agent.
		// The plugins add tools at run time with JSON Schema parameters. TypeScript cannot see
		// that their merged tool types fit the type of the plugin they join.
		const withInner = (agent: ReturnType<typeof agentPluginFor>) => {
			let inner = agent
			if (Option.isSome(workPlugin))
				inner = PluginComposition.merge(
					inner,
					workPlugin.value.forOwner({ read: (id) => store.read(id), store }),
				) as unknown as typeof inner
			if (Option.isSome(channelPlugin))
				inner = PluginComposition.merge(
					inner,
					channelPlugin.value.forOwner({ read: (id) => store.read(id) }),
				) as unknown as typeof inner
			return inner
		}
		const hostPlugin =
			options.owner === undefined || Option.isNone(agentPlugin)
				? apps
				: (PluginComposition.merge(
						apps,
						withInner(agentPluginFor(agentPlugin.value, options.owner)),
					) as unknown as typeof apps)
		const runtime = yield* SessionRuntime.make({
			store,
			agent: {
				...options.runtime,
				plugin,
				hostPlugin,
			},
		})
		const read = (id: Session.Id) =>
			store.read(id).pipe(Effect.mapError(publicError))
		const project = (
			view: Session.View<SessionHost.Values>,
		): Effect.Effect<SessionView> =>
			Effect.gen(function* () {
				const active = yield* runtime.isActive(view.session.id)
				const planApproval = SessionHost.hostState(view.session)?.planApproval
				return {
					...view,
					...SessionHost.agentFields(view.session),
					...(planApproval === undefined ? {} : { planApproval }),
					response: Option.getOrNull(currentResponse(view)),
					activity: active
						? ("active" as const)
						: Match.value(Session.status(view.session)).pipe(
								Match.tag("Running", () => "historical" as const),
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
				const problem = ConfigurationOperations.selectionProblem(
					yield* catalog,
					selection,
				)
				if (Option.isSome(problem))
					return yield* SessionModelInvalid.make(problem.value)
				return options.modelDefaults === undefined
					? selection
					: yield* options.modelDefaults(selection)
			})
		const create: typeof Sessions.Service.create = (input) =>
			Effect.gen(function* () {
				const defaults = yield* options.defaults ?? Effect.succeed({})
				// The model of the Agent comes after the defaults of the host.
				const settings = {
					...defaults,
					...(input.agent.model === undefined
						? {}
						: { model: input.agent.model }),
					...input.settings,
				}
				// A host that resolves models by selection needs a model for each Session.
				if (settings.model === undefined && options.resolveModel !== undefined)
					return yield* SessionModelInvalid.make({
						reason: "missing",
						message:
							"Choose a model for the Session, or set the model of the Agent.",
					})
				const model =
					settings.model === undefined
						? undefined
						: yield* validateSelection(settings.model)
				const state: SessionHost.SessionHostState = {
					agent: input.agent.id,
					kind: input.kind,
					chain: input.chain,
					...(input.parent === undefined ? {} : { parent: input.parent }),
					...(input.review === undefined ? {} : { review: input.review }),
					...(input.planApproval === undefined
						? {}
						: { planApproval: input.planApproval }),
					...(input.trigger === undefined ? {} : { trigger: input.trigger }),
					...(input.channel === undefined ? {} : { channel: input.channel }),
				}
				return yield* store
					.create({
						metadata: {
							...(input.title === undefined ? {} : { title: input.title }),
						},
						settings: {
							...settings,
							...(model === undefined ? {} : { model }),
						},
						business: { [sessionHostId]: state },
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
					update: (view) => {
						const state = SessionHost.hostState(view.session)
						// A `null` makes the Session follow its Agent and the member again.
						const { planApproval: _approval, ...kept } = state
						const business =
							input.planApproval === undefined
								? {}
								: {
										business: {
											...view.session.business,
											[sessionHostId]:
												input.planApproval === null
													? kept
													: { ...kept, planApproval: input.planApproval },
										},
									}
						// A `null` title removes the title.
						const title =
							input.title === undefined
								? view.session.metadata.title
								: (input.title ?? undefined)
						return Effect.succeed([
							undefined,
							Option.some({
								session: {
									metadata: {
										...(title === undefined ? {} : { title }),
										archived: input.archived ?? view.session.metadata.archived,
									},
									...business,
								},
							}),
						] as const)
					},
				})
				.pipe(
					Effect.mapError(publicError),
					Effect.flatMap(({ view }) => project(view)),
				)
		const list: typeof Sessions.Service.list = (input) =>
			StoredSessions.list(db, namespace, input).pipe(
				Effect.mapError(publicError),
				// Review Sessions are hidden unless the caller asks for them.
				Effect.map((rows) =>
					rows.filter(
						(row) =>
							(input?.agent === undefined || row.agent === input.agent) &&
							(input?.kind === undefined
								? row.kind !== "review"
								: row.kind === input.kind),
					),
				),
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
		const forked = ({
			parent: _parent,
			review: _review,
			trigger: _trigger,
			channel: _channel,
			...kept
		}: SessionHost.SessionHostState): SessionHost.SessionHostState => ({
			...kept,
			kind: "direct",
		})
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
				const title = input.title ?? source.session.metadata.title
				return yield* store
					.fork({
						source: id,
						...(input.version === undefined ? {} : { version: input.version }),
						metadata: title === undefined ? {} : { title },
						...(settings === undefined ? {} : { settings }),
						// The Fork keeps the OpenBot data of its source, such as the Agent and the
						// memory switches. It is new direct work, so it has no parent tool call.
						business: {
							[sessionHostId]: forked(SessionHost.hostState(source.session)),
						},
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
		const waits: typeof Sessions.Service.waits = (id) =>
			read(id).pipe(
				Effect.map((view) =>
					Option.match(
						Option.fromNullishOr(Session.currentTurn(view.session)),
						{
							onNone: () => [],
							onSome: (turn) =>
								turn.status._tag === "Waiting" ? Session.waits(view) : [],
						},
					),
				),
			)
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
					view.state.value.conversation.history.filter(
						(entry) => entry.origin?.turn === turnId,
					),
					input,
					"The Item cursor does not belong to this Turn",
				)
			})
		const start = (
			id: Session.Id,
			input: SendInput,
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
										// The final event names the final status. A response that
										// still runs here did not finish, so it is incomplete.
										type:
											result.status === "in_progress"
												? "response.incomplete"
												: (`response.${result.status}` as const),
										response: result,
									},
								])
								.pipe(Effect.asVoid)
				const execution = runtime
					.stream({
						base: { session: id, revision: input.expected },
						input: inputPrompt(input.input),
						...(overrides === undefined ? {} : { overrides }),
						...(input.author === undefined ? {} : { author: input.author }),
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
								Match.tag("TurnCompleted", "TurnWaiting", (event) =>
									Effect.gen(function* () {
										terminal = true
										reportedFailure = event.turn.status._tag === "Failed"
										yield* finish(response(event.view, event.turn))
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
		const resolveCall: typeof Sessions.Service.resolveCall = (
			id,
			toolCallId,
			outcome,
		) =>
			Effect.gen(function* () {
				const view = yield* read(id)
				const turn = Session.currentTurn(view.session)
				const wait = Session.waits(view).find(
					(entry) => entry.toolCallId === toolCallId,
				)
				if (
					turn === undefined ||
					turn.status._tag !== "Waiting" ||
					wait === undefined
				)
					return
				// A Turn of a host-selected action has no model. Its driver runs the action again.
				const model =
					turn.action !== undefined || turn.activeAction !== undefined
						? undefined
						: yield* modelFor(view, turn)
				const input = {
					session: id,
					turn: turn.id,
					approval: wait.approvalId,
					outcome,
					expectedRevision: view.session.revision,
				}
				yield* (
					model === undefined
						? runtime
								.resolveAction(input)
								.pipe(Effect.provideContext(environment))
						: runtime
								.resolve(input)
								.pipe(
									Effect.provideContext(
										Context.add(
											environment,
											LanguageModel.LanguageModel,
											model,
										),
									),
								)
				).pipe(
					// Another answer came first. The call does not wait any more.
					Effect.catchTag("TurnConflict", () => Effect.void),
					Effect.mapError(publicError),
				)
			})
		const updateMemory: typeof Sessions.Service.updateMemory = (id, input) =>
			Effect.gen(function* () {
				const view = yield* read(id)
				const changed = yield* Match.value(input.command).pipe(
					Match.tag("Configure", (command) =>
						store
							.modifyEffect({
								session: id,
								expectedHead: input.expected,
								expectedRevision: input.revision,
								update: (current) =>
									Effect.succeed([
										undefined,
										Option.some({
											session: {
												business: {
													...current.session.business,
													[sessionHostId]: {
														...SessionHost.hostState(current.session),
														memory: SessionHost.configure({
															current: SessionHost.overrides(current.session),
															command,
														}),
													},
												},
											},
										}),
									] as const),
							})
							.pipe(
								Effect.map((changed) => changed.view),
								Effect.mapError(publicError),
							),
					),
					Match.tag("Refresh", () =>
						Effect.gen(function* () {
							if (
								!SessionHost.settings({
									defaults: memoryDefaults,
									session: view.session,
								}).generate
							)
								return view
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
				waits,
				send,
				startAction,
				sendStream,
				resolveCall,
				updateMemory,
				todos: (id) => read(id).pipe(Effect.map(Todos.of)),
				updateTodos: (id, input) =>
					Todos.replace({
						store,
						session: id,
						items: input.items,
						base: input,
					}).pipe(
						Effect.mapError((error) =>
							error._tag === "SessionConflict" ? error : publicError(error),
						),
						Effect.flatMap(project),
					),
				history,
				versions: (id) =>
					read(id).pipe(
						Effect.flatMap((view) =>
							store
								.log({ from: view.session.head })
								.pipe(Effect.mapError(publicError)),
						),
					),
				memory: (id) =>
					read(id).pipe(
						Effect.map((view) => ({
							...(view.state.value[Memory.storeKey] ?? Memory.empty()),
							settings: SessionHost.settings({
								defaults: memoryDefaults,
								session: view.session,
							}),
							overrides: SessionHost.overrides(view.session),
						})),
					),
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
				steer: (id, turn, input, author) =>
					runtime
						.steer({
							session: id,
							turn,
							input: inputPrompt(input),
							...(author === undefined ? {} : { author }),
						})
						.pipe(Effect.mapError(publicError)),
				enqueue: (id, input) =>
					runtime
						.enqueue({
							session: id,
							message: inputPrompt(input.input),
							...(input.expected === undefined
								? {}
								: { expectedRevision: input.expected }),
							...(input.author === undefined ? {} : { author: input.author }),
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
