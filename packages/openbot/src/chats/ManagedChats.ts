import {
	Bot,
	Chat,
	ChatRuntime,
	ChatStore,
	ChatStoreRepository,
	Config,
	ConfigurationOperations,
	Item,
	Operations,
	Plugin,
	Store,
	Turn,
} from "@openbot-build/core"
import * as Todos from "../plugins/work/Todos.ts"
import {
	Array as Arr,
	Context,
	Crypto,
	Duration,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Schedule,
	Scope,
	Stream,
	String as Str,
} from "effect"
import { AiError, LanguageModel, type Tool } from "effect/ai"
import {
	ChatConflict,
	ChatExecutionUnavailable,
	ChatModelInvalid,
	type ChatInfo,
	type ChatResponse,
	type ChatSummary,
	type ChatView,
	type MessageReceipt,
} from "@openbot-build/api"
import { PgClient } from "@effect/sql-pg"
import * as StoredChats from "./StoredChats.ts"
import * as StoredOperations from "../operations/StoredOperations.ts"
import { withAttribution } from "../billing/MeteredModel.ts"
import { LiveSessions } from "./live/LiveSessions.ts"
import {
	Chats,
	type Options as ChatsOptions,
	type Instance,
	type ServiceError,
	type CreateInput,
} from "./Chats.ts"
import * as ChatFeatures from "./ChatFeatures.ts"
import { HostTools } from "./HostTools.ts"
import { toPublic, inputPrompt, response } from "./ResponseMapping.ts"
import * as ChatEvents from "./ChatEvents.ts"
import * as ChatHost from "./ChatHost.ts"
import * as Compaction from "./Compaction.ts"
import { chatHostId } from "./ChatHost.ts"
import { OpenWork, none } from "./OpenWork.ts"
import * as Background from "../app/Background.ts"
import * as ErrorReporting from "../app/ErrorReporting.ts"
import * as Failures from "../app/Failures.ts"
import { Signal, Signals } from "../bots/Signals.ts"
import * as Db from "../database/Database.ts"
import { type Methods, methodsOf, withMethods } from "../models/ModelMethods.ts"

/** How often a server says that its running Turns still run. */
const heartbeatEvery = Duration.seconds(30)

/**
 * A model that finds the real model at the time of each call. A Turn that starts by
 * itself, after another Turn ends, then uses the model of its own settings.
 */
const route = (
	template: LanguageModel.LanguageModel,
	select: Effect.Effect<LanguageModel.LanguageModel, ChatExecutionUnavailable>,
): LanguageModel.LanguageModel => {
	const plain = (method: string) =>
		select.pipe(
			// The reason was logged where the model was missing.
			Effect.mapError((error) =>
				AiError.make({
					module: "OpenBot",
					method,
					reason: AiError.UnknownError.make({
						description:
							error.chat === ""
								? "No model is available for this Chat."
								: `No model is available for the Chat ${error.chat}.`,
					}),
				}),
			),
			Effect.map(methodsOf),
		)
	const methods: Methods = {
		generateText: (options) =>
			Effect.flatMap(plain("generateText"), (model) =>
				model.generateText(options),
			),
		generateObject: (options) =>
			Effect.flatMap(plain("generateObject"), (model) =>
				model.generateObject(options),
			),
		streamText: (options) =>
			Stream.unwrap(
				Effect.map(plain("streamText"), (model) => model.streamText(options)),
			),
	}
	return withMethods(template, methods)
}

/**
 * What one Chat runtime is made from. `keepOpen` keeps the runtime open while
 * it is held: a running Turn and a background tool call hold it, so `Backend`
 * does not close a runtime that works.
 */
export interface Options extends ChatsOptions {
	readonly keepOpen?: Effect.Effect<void, never, Scope.Scope>
	/**
	 * The Chats of the same member, as `Backend` gives them. Work that ends after
	 * this runtime may have closed, such as the end of a command session, gives
	 * its input through them. Then the input reaches the runtime that is open at
	 * that time.
	 */
	readonly current?: typeof Chats.Service
}

/**
 * Builds the Chat runtime of one member. It takes the services of OpenBot
 * once, when it is made, so a runtime uses the same services whoever opens
 * it.
 */
export const factory: Effect.Effect<
	(options: Options) => Effect.Effect<Instance, never, Scope.Scope>,
	never,
	| PgClient.PgClient
	| Crypto.Crypto
	| HostTools
	| ChatFeatures.ChatFeatures
	| LiveSessions
	| OpenWork
	| Signals
	| StoredOperations.Channel
> = Effect.gen(function* () {
	const db = yield* Db.make
	const client = yield* PgClient.PgClient
	const listener = yield* StoredOperations.Channel
	const crypto = yield* Crypto.Crypto
	const hostTools = yield* HostTools
	const features = yield* ChatFeatures.ChatFeatures
	const liveSessions = yield* LiveSessions
	const openWork = yield* OpenWork
	const signals = yield* Signals
	return (options) =>
		Effect.gen(function* () {
			const namespace = options.namespace ?? "local"
			const keepOpen = options.keepOpen ?? Effect.void
			/** Runs `effect` while it holds the runtime open. */
			const held = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
				Effect.scopedWith((lease) =>
					keepOpen.pipe(Scope.provide(lease), Effect.andThen(effect)),
				)
			/**
			 * Who a model call of a Chat works for. It reads the running Turn at the time
			 * of the call, because a Turn can have its own author.
			 */
			const attribution = (chat: Chat.Id) =>
				Effect.gen(function* () {
					// A model call outside of a Turn, such as a summary, has no Turn to name.
					const context = yield* Effect.serviceOption(Bot.Context)
					const turnId = Option.isSome(context)
						? yield* context.value.turn
						: undefined
					// The bill still counts the call when the Chat cannot be read. It only
					// does not name the member and the Bot.
					const ref = yield* store
						.get(chat)
						.pipe(
							Effect.catch((error) =>
								Effect.logWarning(
									"OpenBot could not read the Chat of a model call.",
									error,
								).pipe(Effect.as(Option.none())),
							),
						)
					const state = Option.getOrUndefined(
						Option.map(
							ref,
							(ref) =>
								ref.business[chatHostId] as ChatHost.ChatHostState | undefined,
						),
					)
					const turn = Option.getOrUndefined(
						Option.flatMap(ref, (ref) => Option.fromUndefinedOr(ref.turn)),
					)
					const chain =
						state === undefined || Option.isNone(ref)
							? undefined
							: ChatHost.turnChain(
									ref.value,
									turn?.id === turnId ? turn?.author : undefined,
								)
					return {
						source: "turn" as const,
						chatId: chat,
						...(turnId === undefined ? {} : { turnId }),
						...(state === undefined ? {} : { botId: state.bot }),
						...(chain === undefined ? {} : { userId: chain.userId }),
						...(chain?.tokenId === undefined ? {} : { tokenId: chain.tokenId }),
					}
				})
			const isLive = (chat: Chat.Ref) =>
				ChatHost.hostState(chat).kind === "live"
			/**
			 * The model of a Chat. A live Chat uses the Live session of this process, and
			 * nothing else. Other Chats use the model of their Turn, or of the Chat.
			 */
			const modelFor = (chat: Chat.Ref, turn?: Turn.Record) =>
				isLive(chat)
					? Effect.gen(function* () {
							const found = yield* liveSessions.find(chat.id)
							if (Option.isNone(found))
								return yield* ChatExecutionUnavailable.make({ chat: chat.id })
							return withAttribution(found.value, attribution(chat.id))
						})
					: chatModelFor(chat, turn)
			const chatModelFor = (chat: Chat.Ref, turn?: Turn.Record) =>
				Effect.gen(function* () {
					const selection = turn?.settings.model ?? chat.settings.model
					if (selection === undefined)
						return yield* ChatExecutionUnavailable.make({ chat: chat.id })
					const model = yield* options.resolveModel(selection).pipe(
						// The public error has no details, so the log keeps them.
						Effect.catchTag("ModelConfigurationError", (error) =>
							Effect.logWarning(
								"The model of a Chat is not available.",
								error,
							).pipe(
								Effect.andThen(
									Effect.fail(ChatExecutionUnavailable.make({ chat: chat.id })),
								),
							),
						),
					)
					return withAttribution(model, attribution(chat.id))
				})
			const template = yield* LanguageModel.make({
				generateText: () => Effect.die("The router passes every call on"),
				streamText: () => Stream.die("The router passes every call on"),
			})
			const router = route(
				template,
				Effect.gen(function* () {
					// Only a Turn calls the model of a Chat, and a Turn has its Bot context.
					const context = yield* Effect.serviceOption(Bot.Context)
					if (Option.isNone(context))
						return yield* ChatExecutionUnavailable.make({
							chat: Chat.Id.make(""),
						})
					const at = yield* context.value.at.pipe(
						Failures.replace("OpenBot could not find the Chat of a Turn.", () =>
							ChatExecutionUnavailable.make({ chat: Chat.Id.make("") }),
						),
					)
					const view = yield* store
						.read(at.chat)
						.pipe(
							Failures.replace(
								"OpenBot could not read the Chat of a model call.",
								() => ChatExecutionUnavailable.make({ chat: at.chat }),
							),
						)
					return yield* modelFor(view.chat, Chat.currentTurn(view.chat))
				}),
			)
			const routed = Context.make(
				LanguageModel.LanguageModel,
				features.withFiles(router),
			)
			// The plugin of the Chat host keeps the OpenBot data of each Chat. It runs the tools of the host program.
			const host = Plugin.make({
				id: chatHostId,
				store: ChatHost.chatHostStore,
			})<{}>(() => hostTools.plugin.middleware)
			const definition = yield* Store.define({
				stores: { ...host.stores, ...Todos.stores },
				schemaVersion: "chat/1",
			})
			const store: ChatStore.Store<ChatHost.Values> =
				yield* ChatStoreRepository.make({
					definition,
					persistence: StoredChats.persistence(db, namespace),
					onCommit: ({ delta, previous, view }) =>
						StoredChats.save(db, namespace, delta).pipe(
							Effect.tap(() => {
								const turn = Chat.currentTurn(view.chat)
								const before =
									previous?.turn?.id === turn?.id ? previous?.turn : undefined
								// Each change of the status of a Turn counts once. Code that writes
								// the store directly may make a Chat without OpenBot data.
								if (
									turn === undefined ||
									before?.status._tag === turn.status._tag ||
									view.chat.business[chatHostId] === undefined
								)
									return Effect.void
								const state = ChatHost.hostState(view.chat)
								return Effect.andThen(
									turn.status._tag === "Failed"
										? ErrorReporting.failedTurn(turn)
										: Effect.void,
									// Delegation, reviews and memory react to changes of the Turn status.
									signals.publish(
										Signal.TurnChanged({
											organizationId: state.chain.organizationId,
											// The member whose Chats hold this Chat.
											userId: ChatHost.ownerOf(state.chain),
											chat: view.chat.id,
											turn: turn.id,
											status: turn.status._tag,
										}),
									),
								)
							}),
						),
					onRemove: (ref) => StoredChats.remove(db, namespace, ref.id),
				})
			const owner = options.owner
			const operations = yield* Operations.make({
				store: yield* StoredOperations.make(namespace).pipe(
					Effect.provideService(PgClient.PgClient, client),
					Effect.provideService(StoredOperations.Channel, listener),
				),
				settings: () =>
					owner === undefined
						? Effect.succeed(Operations.defaultSettings)
						: features.operationSettings(owner.organizationId),
			}).pipe(Effect.provideService(Crypto.Crypto, crypto))
			// A background tool call holds the runtime open until its notice reaches the Chat.
			const backgroundCalls: typeof Operations.Operations.Service = {
				...operations,
				run: (input, work, status) =>
					operations.run(
						{ ...input, notify: (record) => held(input.notify(record)) },
						held(work),
						status,
					),
			}
			// Without an owner, as in a test of the Chats alone, a Turn has only the tools of the host.
			const hostPlugin =
				owner === undefined
					? Plugin.make({ id: ChatFeatures.pluginId })<ChatFeatures.Tools>(() =>
							Effect.succeed((next, input) => next(input)),
						)
					: features.plugins({
							owner,
							namespace,
							store,
							operations: backgroundCalls,
							// The plugins are made before `deliver`, so they call it later.
							deliver:
								options.current?.deliver ??
								((chat, input) => Effect.suspend(() => deliver(chat, input))),
						})
			/** A running Turn says often that it still runs, so another server does not end it. */
			const heartbeat = (chat: Chat.Id) =>
				Background.repeat(
					StoredChats.heartbeat(db, namespace, chat).pipe(
						Effect.delay(heartbeatEvery),
					),
					{
						schedule: Schedule.forever,
						message: "OpenBot could not mark a running Turn",
					},
				)
			const catalog = options.modelCatalog
			const runtime = yield* ChatRuntime.make({
				store,
				// Only the process with the Live session of a live Chat runs its Turns.
				// Input from other places waits in the inbox until that process takes it.
				canStart: (view) =>
					isLive(view.chat)
						? liveSessions.has(view.chat.id)
						: Effect.succeed(true),
				whileRunning: (chat) => Effect.andThen(keepOpen, heartbeat(chat)),
				bot: {
					plugin: host,
					hostPlugin,
					// Each Chat gets a summary of its context when it gets near the window of its model.
					modelCatalog: catalog.pipe(
						Effect.map((current) =>
							Arr.map(current.models, Compaction.withSummary),
						),
					),
					compaction: Compaction.service,
					approvals: features.approvals,
				},
			}).pipe(Effect.provideService(Operations.Operations, backgroundCalls))
			const read = (id: Chat.Id) => store.read(id).pipe(toPublic)
			const info = (ref: Chat.Ref): ChatInfo => {
				const state = ChatHost.hostState(ref)
				return {
					id: ref.id,
					revision: ref.revision,
					kind: state.kind,
					bot: state.bot,
					parent: state.parent ?? null,
					...(state.title === undefined ? {} : { title: state.title }),
					settings: ref.settings,
					...(state.planApproval === undefined
						? {}
						: { planApproval: state.planApproval }),
					createdAt: ref.createdAt,
				}
			}
			const activityOf = (ref: Chat.Ref, active: boolean) =>
				active
					? ("active" as const)
					: ref.turn?.status._tag === "Running"
						? ("historical" as const)
						: ("inactive" as const)
			const responseOf = (ref: Chat.Ref, turn: Turn.Record) =>
				store.items(ref.id, { turn: turn.id }).pipe(
					Effect.map((items) => response(ref.id, turn, items)),
					toPublic,
				)
			/** A Turn of a Chat: the current one from the view, or an older one from the store. */
			const findTurn = (
				view: Chat.View<ChatHost.Values>,
				turn: Turn.Id,
			): Effect.Effect<Option.Option<Turn.Record>, ServiceError> =>
				view.chat.turn?.id === turn
					? Effect.succeedSome(view.chat.turn)
					: store.turn(view.chat.id, turn).pipe(toPublic)
			const project = (
				view: Chat.View<ChatHost.Values>,
			): Effect.Effect<ChatView, ServiceError> =>
				Effect.gen(function* () {
					const turn = Chat.currentTurn(view.chat)
					const active = yield* runtime.isActive(view.chat.id)
					// BotRecords already logs a storage failure. The view then shows no open work.
					const open = yield* openWork
						.count(
							ChatHost.hostState(view.chat).chain.organizationId,
							view.chat.id,
						)
						.pipe(
							Effect.catchTag("BotStorageUnavailable", () =>
								Effect.succeed(none),
							),
						)
					return {
						chat: info(view.chat),
						status: Chat.status(view.chat)._tag,
						turn: turn ?? null,
						response:
							turn === undefined ? null : yield* responseOf(view.chat, turn),
						activity: activityOf(view.chat, active),
						inbox: view.chat.inbox.length,
						open,
					}
				})
			const summary = (ref: Chat.Ref): Effect.Effect<ChatSummary> =>
				Effect.map(runtime.isActive(ref.id), (active) => {
					const turn = ref.turn
					const latest =
						turn === undefined ? undefined : response(ref.id, turn, [])
					return {
						chat: info(ref),
						status: Chat.status(ref)._tag,
						turn: turn?.id ?? null,
						response:
							latest === undefined
								? null
								: {
										id: latest.id,
										created_at: latest.created_at,
										status: latest.status,
									},
						activity: activityOf(ref, active),
					}
				})
			const get = (id: Chat.Id) => read(id).pipe(Effect.flatMap(project))
			const liveCatalog =
				options.liveCatalog ?? Effect.succeed({ providers: [], models: [] })
			const validateIn =
				(models: typeof catalog) => (selection: Config.Selection) =>
					Effect.gen(function* () {
						const problem = ConfigurationOperations.selectionProblem(
							yield* models,
							selection,
						)
						if (Option.isSome(problem))
							return yield* ChatModelInvalid.make(problem.value)
						return selection
					})
			const validateSelection = validateIn(catalog)
			/** A live Chat can use only a Live model, and other Chats never can. */
			const validateLive = validateIn(liveCatalog)
			/** The model of a new live Chat: the one asked for, or the first Live model. */
			const liveModel = (selection: Config.Selection | undefined) =>
				Effect.gen(function* () {
					if (selection !== undefined) return yield* validateLive(selection)
					const first = (yield* liveCatalog).models[0]
					if (first === undefined)
						return yield* ChatModelInvalid.make({
							reason: "missing",
							message: "The organization has no Live model.",
						})
					return Config.Selection.make({
						provider: first.provider,
						model: first.id,
					})
				})
			const stateOf = (input: CreateInput): ChatHost.ChatHostState => ({
				bot: input.bot.id,
				kind: input.kind,
				chain: input.chain,
				...(input.parent === undefined ? {} : { parent: input.parent }),
				...(input.review === undefined ? {} : { review: input.review }),
				...(input.planApproval === undefined
					? {}
					: { planApproval: input.planApproval }),
				...(input.trigger === undefined ? {} : { trigger: input.trigger }),
				...(input.channel === undefined ? {} : { channel: input.channel }),
				...(input.title === undefined ? {} : { title: input.title }),
			})
			const newChatId = crypto.randomUUIDv4().pipe(
				Effect.orDie,
				Effect.map((uuid) =>
					Chat.Id.make("chat_" + Str.replaceAll("-", "")(uuid)),
				),
			)
			const create: typeof Chats.Service.create = (input) =>
				Effect.gen(function* () {
					if (input.kind === "live")
						return yield* store
							.create({
								id: input.id ?? (yield* newChatId),
								settings: { model: yield* liveModel(input.model) },
								business: { [chatHostId]: stateOf(input) },
							})
							.pipe(toPublic, Effect.flatMap(project))
					// A linked Bot comes from another organization. This organization may not
					// have its model, and then the Chat uses the default model of the host.
					const botModel =
						input.bot.model === undefined
							? undefined
							: input.bot.source === undefined
								? input.bot.model
								: Option.getOrUndefined(
										yield* Effect.option(validateSelection(input.bot.model)),
									)
					// The model of the Bot comes before the default model of the host.
					const selected = botModel ?? options.defaultModel
					if (selected === undefined)
						return yield* ChatModelInvalid.make({
							reason: "missing",
							message: "Set the model of the Bot.",
						})
					const model = yield* validateSelection(selected)
					const state = stateOf(input)
					return yield* store
						.create({
							id: input.id ?? (yield* newChatId),
							settings: { model },
							business: { [chatHostId]: state },
						})
						.pipe(toPublic, Effect.flatMap(project))
				})
			const direct: typeof Chats.Service.direct = (bot, chain) =>
				Effect.gen(function* () {
					const found = yield* StoredChats.direct(db, namespace, bot.id).pipe(
						toPublic,
					)
					if (Option.isSome(found)) return found.value
					return yield* create({ bot, kind: "direct", chain }).pipe(
						Effect.map((view) => view.chat.id),
						// Another request made the Chat at the same time. Use that one.
						Effect.catchTag("ChatConflict", (error) =>
							StoredChats.direct(db, namespace, bot.id).pipe(
								toPublic,
								Effect.flatMap(
									Option.match({
										onNone: () => Effect.fail(error),
										onSome: Effect.succeed,
									}),
								),
							),
						),
					)
				})
			const list: typeof Chats.Service.list = (input) =>
				StoredChats.list(db, namespace, {
					...(input?.bot === undefined ? {} : { bot: input.bot }),
					kinds:
						input?.kind !== undefined
							? [input.kind]
							: (input?.kinds ?? ["direct", "channel", "live"]),
				}).pipe(
					toPublic,
					Effect.flatMap((refs) => Effect.forEach(refs, summary)),
				)
			const update: typeof Chats.Service.update = (id, input) =>
				Effect.gen(function* () {
					const live = isLive((yield* read(id)).chat)
					// A live Chat always has a Live model. It cannot follow its Bot.
					if (live && input.model === null)
						return yield* ChatModelInvalid.make({
							reason: "missing",
							message: "A live Chat needs a Live model.",
						})
					const model =
						input.model === undefined || input.model === null
							? input.model
							: live
								? yield* validateLive(input.model)
								: yield* validateSelection(input.model)
					const { view } = yield* store
						.modifyEffect({
							chat: id,
							expectedRevision: input.expected,
							update: (current) => {
								const { model: _model, ...rest } = current.chat.settings
								const settings: Turn.Settings = {
									...(model === null ? rest : current.chat.settings),
									...(input.mode === undefined ? {} : { mode: input.mode }),
									...(model === undefined || model === null ? {} : { model }),
								}
								const state = ChatHost.hostState(current.chat)
								// A `null` makes the Chat follow its Bot and the member again.
								const { planApproval: _approval, ...kept } = state
								const business =
									input.planApproval === undefined
										? {}
										: {
												business: {
													...current.chat.business,
													[chatHostId]:
														input.planApproval === null
															? kept
															: { ...kept, planApproval: input.planApproval },
												},
											}
								return Effect.succeed([
									undefined,
									Option.some({ chat: { settings, ...business } }),
								] as const)
							},
						})
						.pipe(toPublic)
					return yield* project(view)
				})
			const change: typeof Chats.Service.change = (id, f) =>
				store
					.modifyEffect({
						chat: id,
						update: (current) =>
							Effect.succeed([
								undefined,
								Option.some({
									chat: {
										business: {
											...current.chat.business,
											[chatHostId]: f(ChatHost.hostState(current.chat)),
										},
									},
								}),
							] as const),
					})
					.pipe(Effect.asVoid, toPublic)
			const interrupt: typeof Chats.Service.interrupt = (id) =>
				Effect.gen(function* () {
					const view = yield* read(id)
					const turn = Chat.currentTurn(view.chat)
					if (turn === undefined || Turn.isTerminal(turn.status))
						return yield* project(view)
					return yield* runtime.interrupt({ chat: id, turn: turn.id }).pipe(
						Effect.catchTag("TurnConflict", () => store.read(id)),
						toPublic,
						Effect.flatMap(project),
					)
				})
			const receipt = (
				delivery: Chat.Delivery,
			): Effect.Effect<MessageReceipt, ServiceError> =>
				Effect.gen(function* () {
					const view = yield* read(delivery.chat)
					const turn =
						delivery.turn === undefined
							? Option.none()
							: yield* findTurn(view, delivery.turn)
					return {
						delivery: delivery.delivery,
						chat: delivery.chat,
						item: delivery.item,
						turn: delivery.turn ?? null,
						response: yield* Option.match(turn, {
							onNone: () => Effect.succeed(null),
							onSome: (record) => responseOf(view.chat, record),
						}),
					}
				})
			const deliver: typeof Chats.Service.deliver = (id, input) =>
				Effect.gen(function* () {
					const view = yield* read(id)
					// A person learns at once when no model can run the work of this Chat.
					// A message from OpenBot waits in the Chat all the same. Input to a live
					// Chat waits for its Live session, so it needs no model now.
					if (input.notice === undefined && !isLive(view.chat))
						yield* modelFor(view.chat)
					const delivery = yield* runtime
						.deliver({
							chat: id,
							input: inputPrompt(input.input),
							author: input.author,
							...(input.notice === undefined ? {} : { notice: input.notice }),
							...(input.approved === undefined
								? {}
								: { approved: input.approved }),
							...(input.queue === undefined ? {} : { queue: input.queue }),
						})
						.pipe(Effect.provideContext(routed), toPublic)
					return yield* receipt(delivery)
				})
			/** Turns the core events of one Turn into Responses events. */
			const follow = <E>(
				chat: Chat.Id,
				turn: Turn.Id,
				events: Stream.Stream<
					Bot.Event<Record<string, Tool.Any>, ChatHost.Values>,
					E
				>,
				sink: ChatEvents.Sink,
			) =>
				Effect.gen(function* () {
					const outputs = yield* Ref.make(
						HashMap.empty<
							Item.Id,
							{ readonly index: number; readonly text: string }
						>(),
					)
					const step = yield* Ref.make<number | undefined>(undefined)
					const emit = (event: ChatEvents.Payload) =>
						Effect.flatMap(Ref.get(step), (current) =>
							sink.emit({
								...event,
								chat,
								turn,
								...(current === undefined ? {} : { step: current }),
							}),
						).pipe(Effect.asVoid)
					const finish = (result: ChatResponse) =>
						Effect.flatMap(Ref.get(step), (current) =>
							sink.finish([
								{
									chat,
									turn: result.id,
									...(current === undefined ? {} : { step: current }),
									// The final event names the final status. A response that
									// still runs here did not finish, so it is incomplete.
									type:
										result.status === "in_progress"
											? "response.incomplete"
											: (`response.${result.status}` as const),
									response: result,
								},
							]),
						).pipe(Effect.asVoid)
					const latest = Effect.gen(function* () {
						const view = yield* read(chat)
						return yield* Effect.transposeOption(
							Option.map(yield* findTurn(view, turn), (record) =>
								responseOf(view.chat, record),
							),
						)
					})
					const started = yield* latest
					if (Option.isSome(started)) {
						yield* emit({ type: "response.created", response: started.value })
						yield* emit({
							type: "response.in_progress",
							response: started.value,
						})
					}
					/** Starts a new output message in the Response. */
					const added = (item: Item.Id) =>
						Effect.gen(function* () {
							const entry = {
								index: HashMap.size(yield* Ref.get(outputs)),
								text: "",
							}
							yield* Ref.update(outputs, HashMap.set(item, entry))
							yield* emit({
								type: "response.output_item.added",
								output_index: entry.index,
								item: {
									id: item,
									type: "message",
									role: "assistant",
									status: "in_progress",
									content: [],
								},
							})
							yield* emit({
								type: "response.content_part.added",
								item_id: item,
								output_index: entry.index,
								content_index: 0,
								part: {
									type: "output_text",
									text: "",
									annotations: [] as const,
								},
							})
							return entry
						})
					yield* events.pipe(
						Stream.filter(
							(event) =>
								("turn" in event && event.turn === turn) ||
								(event._tag === "TurnCompleted" && event.turn.id === turn),
						),
						Stream.takeUntil((event) => event._tag === "TurnCompleted"),
						Stream.runForEach((event) =>
							Effect.gen(function* () {
								if (event._tag === "TurnCompleted") {
									const result = yield* latest
									if (Option.isSome(result)) yield* finish(result.value)
									return
								}
								if (event._tag !== "ResponsePart") return
								yield* Ref.set(step, event.step)
								const known = HashMap.get(yield* Ref.get(outputs), event.item)
								const output = Option.isSome(known)
									? known.value
									: yield* added(event.item)
								const indices = {
									item_id: event.item,
									output_index: output.index,
									content_index: 0,
								}
								const part = event.part
								if (part.type === "text-delta") {
									yield* Ref.update(
										outputs,
										HashMap.set(event.item, {
											...output,
											text: output.text + part.delta,
										}),
									)
									yield* emit({
										type: "response.output_text.delta",
										...indices,
										delta: part.delta,
										logprobs: [],
									})
								}
								if (part.type === "finish") {
									const text = Option.match(
										HashMap.get(yield* Ref.get(outputs), event.item),
										{
											onNone: () => output.text,
											onSome: (entry) => entry.text,
										},
									)
									const content = {
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
											status: ["stop", "tool-calls"].includes(part.reason)
												? "completed"
												: "incomplete",
											content: [content],
										},
									})
								}
							}),
						),
					)
				}).pipe(
					Effect.ensuring(sink.finish([])),
					Background.logFailure("The live events of a Turn stopped"),
				)
			const deliverStream: typeof Chats.Service.deliverStream = (id, input) =>
				Effect.gen(function* () {
					const before = yield* read(id)
					const result = yield* deliver(id, input)
					if (result.delivery !== "started" || result.turn === null)
						return { receipt: result, events: Option.none() }
					const sink = yield* ChatEvents.make
					const events = runtime.events({
						chat: id,
						after: before.chat.revision,
					})
					yield* Effect.forkScoped(follow(id, result.turn, events, sink))
					return { receipt: result, events: Option.some(sink.stream) }
				})
			const drain: typeof Chats.Service.drain = (id) =>
				runtime
					.drain(id)
					.pipe(Effect.provideContext(routed), Effect.asVoid, toPublic)
			const closeStale: typeof Chats.Service.closeStale = (id, turn) =>
				Effect.gen(function* () {
					if (yield* runtime.isActive(id)) return
					yield* runtime.interrupt({ chat: id, turn }).pipe(
						// The Turn ended already.
						Effect.catchTag("TurnConflict", () => Effect.void),
						toPublic,
					)
					yield* drain(id).pipe(
						Effect.catchTag("ChatExecutionUnavailable", () => Effect.void),
					)
				})
			const startAction: typeof Chats.Service.startAction = (id, input) =>
				read(id).pipe(
					Effect.andThen(
						runtime.startAction({
							chat: id,
							action: input.action,
							...(input.turn === undefined ? {} : { turn: input.turn }),
							...(input.author === undefined ? {} : { author: input.author }),
						}),
					),
					Effect.provideContext(routed),
					toPublic,
				)
			const pageSize = (limit: number | undefined) =>
				Math.max(1, Math.min(100, Math.floor(limit ?? 50)))
			/** The first `limit` rows, and the key of the last one when more rows follow. */
			const pageOf = <A, K>(
				rows: ReadonlyArray<A>,
				limit: number,
				key: (row: A) => K,
			) => {
				const items = Arr.take(rows, limit)
				return {
					items,
					next:
						rows.length > limit
							? Option.getOrNull(Option.map(Arr.last(items), key))
							: null,
				}
			}
			const turns: typeof Chats.Service.turns = (id, input) =>
				Effect.gen(function* () {
					yield* read(id)
					const limit = pageSize(input.limit)
					if (input.after !== undefined) {
						const cursor = yield* store.turn(id, input.after).pipe(toPublic)
						if (Option.isNone(cursor))
							return yield* ChatConflict.make({
								message: "The Turn cursor does not belong to this Chat",
							})
					}
					const rows = yield* store
						.turns(id, {
							...(input.after === undefined ? {} : { after: input.after }),
							limit: limit + 1,
						})
						.pipe(toPublic)
					return pageOf(rows, limit, (turn) => turn.id)
				})
			const turnRecord = (id: Chat.Id, turn: Turn.Id) =>
				Effect.gen(function* () {
					const view = yield* read(id)
					const record = yield* findTurn(view, turn)
					if (Option.isNone(record))
						return yield* ChatConflict.make({
							message: "The Turn does not belong to this Chat",
						})
					return { view, record: record.value }
				})
			const turn: typeof Chats.Service.turn = (id, turnId) =>
				Effect.gen(function* () {
					const { view, record } = yield* turnRecord(id, turnId)
					return {
						turn: record,
						response: yield* responseOf(view.chat, record),
					}
				})
			const turnItems: typeof Chats.Service.turnItems = (id, turnId, input) =>
				Effect.gen(function* () {
					yield* turnRecord(id, turnId)
					const all = yield* store.items(id, { turn: turnId }).pipe(toPublic)
					const after = input.after
					const start =
						after === undefined
							? Option.some(0)
							: Option.map(
									Arr.findFirstIndex(all, (entry) => entry.id === after),
									(index) => index + 1,
								)
					if (Option.isNone(start))
						return yield* ChatConflict.make({
							message: "The Item cursor does not belong to this Turn",
						})
					return pageOf(
						Arr.drop(all, start.value),
						pageSize(input.limit),
						(item) => item.id,
					)
				})
			const items: typeof Chats.Service.items = (id, input) =>
				Effect.gen(function* () {
					yield* read(id)
					const limit = pageSize(input.limit)
					const rows = yield* store
						.items(id, {
							...(input.before === undefined ? {} : { before: input.before }),
							limit: limit + 1,
							order: "desc",
						})
						.pipe(toPublic)
					return pageOf(rows, limit, (item) => item.seq)
				})
			const itemsAfter: typeof Chats.Service.itemsAfter = (id, after) =>
				Effect.gen(function* () {
					const items = yield* store.items(id, { after }).pipe(toPublic)
					const turns = Arr.dedupe(
						Arr.flatMap(items, (item) =>
							item.origin === undefined ? [] : [item.origin.turn],
						),
					)
					const records = yield* Effect.forEach(turns, (turn) =>
						store.turn(id, turn).pipe(toPublic),
					)
					return {
						items,
						authors: new Map(
							Arr.flatMap(records, (record) =>
								Option.isSome(record) && record.value.author !== undefined
									? [[record.value.id, record.value.author] as const]
									: [],
							),
						),
					}
				})
			return {
				...Chats.of({
					create,
					direct,
					get,
					read,
					list,
					update,
					change,
					remove: (id) =>
						Effect.gen(function* () {
							yield* interrupt(id)
							yield* backgroundCalls.cancelChat(id)
							const view = yield* read(id)
							yield* store.remove(view.chat).pipe(toPublic)
						}),
					models: (id) =>
						Effect.gen(function* () {
							const view = yield* read(id),
								available = yield* isLive(view.chat) ? liveCatalog : catalog
							return {
								...available,
								...(view.chat.settings.model === undefined
									? {}
									: { selected: view.chat.settings.model }),
							}
						}),
					todos: (id) => read(id).pipe(Effect.map(Todos.of)),
					updateTodos: (id, input) =>
						Todos.replace({
							store,
							chat: id,
							items: input.items,
							revision: input.revision,
						}).pipe(toPublic, Effect.flatMap(project)),
					wait: (id, after, timeoutMs, afterActivity) =>
						runtime
							.wait({
								chat: id,
								after,
								...(afterActivity === undefined
									? {}
									: { afterActive: afterActivity === "active" }),
								timeout: Math.min(timeoutMs ?? 30000, 30000),
							})
							.pipe(toPublic, Effect.flatMap(project)),
					interrupt,
					deliver,
					deliverStream,
					drain,
					closeStale,
					operations: backgroundCalls,
					startAction,
					turns,
					turn,
					turnItems,
					turnLog: (id, turn) => store.items(id, { turn }).pipe(toPublic),
					itemsAfter,
					items,
				}),
				runtime,
				store,
			}
		})
})

/** One Chat runtime, with the services of OpenBot from the context. */
export const make = (options: Options) =>
	Effect.flatMap(factory, (build) => build(options))

export const layer = (options: Options) => Layer.effect(Chats, make(options))
