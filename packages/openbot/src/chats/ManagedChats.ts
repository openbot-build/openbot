import { randomUUID } from "node:crypto"
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
	PluginComposition,
	Store,
	Turn,
} from "@openbot-build/core"
import * as Todos from "../plugins/work/Todos.ts"
import { WorkPlugin } from "../plugins/work/WorkPlugin.ts"
import { ChannelPlugin } from "../plugins/channels/ChannelPlugin.ts"
import { ComputerPlugin } from "../plugins/computers/ComputerPlugin.ts"
import {
	Array,
	Context,
	Duration,
	Effect,
	HashMap,
	Layer,
	Option,
	Predicate,
	Ref,
	Schedule,
	Scope,
	Stream,
} from "effect"
import {
	AiError,
	LanguageModel,
	Toolkit,
	type Response,
	type Tool,
} from "effect/ai"
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
import type { PgClient } from "@effect/sql-pg"
import * as StoredChats from "./StoredChats.ts"
import * as StoredOperations from "../operations/StoredOperations.ts"
import * as OperationsPlugin from "../plugins/operations/OperationsPlugin.ts"
import { Settings } from "../settings/Settings.ts"
import { operationsOf } from "../settings/Documents.ts"
import { withAttribution } from "../billing/MeteredModel.ts"
import { LiveSessions } from "./live/LiveSessions.ts"
import { Files } from "../files/Files.ts"
import { withFiles } from "../files/ModelFiles.ts"
import {
	Chats,
	type Options,
	type Instance,
	type ExecutionServices,
	type ServiceError,
	type CreateInput,
} from "./Chats.ts"
import { publicError, inputPrompt, response } from "./ResponseMapping.ts"
import * as ChatEvents from "./ChatEvents.ts"
import * as ChatHost from "./ChatHost.ts"
import * as Compaction from "./Compaction.ts"
import { chatHostId } from "./ChatHost.ts"
import { OpenWork, none as noOpenWork } from "./OpenWork.ts"
import * as ErrorReporting from "../app/ErrorReporting.ts"
import {
	AppPlugin,
	empty as emptyAppPlugin,
} from "../plugins/apps/AppPlugin.ts"
import { BotPlugin } from "../plugins/bots/BotPlugin.ts"
import { Signal, publish } from "../bots/Signals.ts"
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
			Effect.mapError(() =>
				AiError.make({
					module: "OpenBot",
					method,
					reason: AiError.UnknownError.make({
						description: "No model is available for this Chat.",
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
	Chat.ChatError | ChatStore.ChatStoreError | BuildE,
	BuildR | PgClient.PgClient | Scope.Scope | ExecutionServices<Tools, R>
> =>
	Effect.gen(function* () {
		const db = yield* Db.make,
			scope = yield* Scope.Scope
		const namespace = options.namespace ?? "local"
		const environment = yield* Effect.context<ExecutionServices<Tools, R>>()
		const fallback = yield* Effect.serviceOption(LanguageModel.LanguageModel)
		const appPlugin = yield* Effect.serviceOption(AppPlugin)
		const botPlugin = yield* Effect.serviceOption(BotPlugin)
		const workPlugin = yield* Effect.serviceOption(WorkPlugin)
		const channelPlugin = yield* Effect.serviceOption(ChannelPlugin)
		const computerPlugin = yield* Effect.serviceOption(ComputerPlugin)
		const liveSessions = yield* Effect.serviceOption(LiveSessions)
		const files = yield* Effect.serviceOption(Files)
		const openWork = Option.getOrUndefined(
			yield* Effect.serviceOption(OpenWork),
		)
		/**
		 * Who a model call of a Chat works for. It reads the running Turn at the time
		 * of the call, because a Turn can have its own author.
		 */
		const attribution = (chat: Chat.Id) =>
			Effect.gen(function* () {
				const context = yield* Effect.serviceOption(Bot.Context)
				const turnId = Option.isSome(context)
					? yield* context.value.turn
					: undefined
				const ref = yield* store
					.get(chat)
					.pipe(Effect.orElseSucceed(Option.none))
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
		const isLive = (chat: Chat.Ref) => ChatHost.hostState(chat).kind === "live"
		/**
		 * The model of a Chat. A live Chat uses the Live session of this process, and
		 * nothing else. Other Chats use the model of their Turn, or of the Chat.
		 */
		const modelFor = (chat: Chat.Ref, turn?: Turn.Record) =>
			isLive(chat)
				? Effect.gen(function* () {
						const found = Option.isNone(liveSessions)
							? Option.none()
							: yield* liveSessions.value.find(chat.id)
						if (Option.isNone(found))
							return yield* ChatExecutionUnavailable.make({ chat: chat.id })
						return withAttribution(found.value, attribution(chat.id))
					})
				: chatModelFor(chat, turn)
		const chatModelFor = (chat: Chat.Ref, turn?: Turn.Record) =>
			options.resolveModel === undefined
				? Effect.fromOption(fallback).pipe(
						Effect.mapError(() =>
							ChatExecutionUnavailable.make({ chat: chat.id }),
						),
					)
				: options
						.resolveModel(turn?.settings.model ?? chat.settings.model)
						.pipe(
							Effect.map((model) =>
								withAttribution(model, attribution(chat.id)),
							),
							Effect.mapError(() =>
								ChatExecutionUnavailable.make({ chat: chat.id }),
							),
						)
		const template = yield* LanguageModel.make({
			generateText: () => Effect.die("The router passes every call on"),
			streamText: () => Stream.die("The router passes every call on"),
		})
		const router = route(
			template,
			Effect.gen(function* () {
				const context = yield* Effect.serviceOption(Bot.Context)
				if (Option.isNone(context))
					return yield* Effect.fromOption(fallback).pipe(
						Effect.mapError(() =>
							ChatExecutionUnavailable.make({ chat: Chat.Id.make("") }),
						),
					)
				const at = yield* context.value.at.pipe(
					Effect.mapError(() =>
						ChatExecutionUnavailable.make({ chat: Chat.Id.make("") }),
					),
				)
				const view = yield* store
					.read(at.chat)
					.pipe(
						Effect.mapError(() =>
							ChatExecutionUnavailable.make({ chat: at.chat }),
						),
					)
				return yield* modelFor(view.chat, Chat.currentTurn(view.chat))
			}),
		)
		const routed = Context.add(
			environment,
			LanguageModel.LanguageModel,
			Option.match(files, {
				onNone: () => router,
				onSome: (files) => withFiles(router, files.load),
			}),
		)
		const host = Plugin.make({
			id: chatHostId,
			store: ChatHost.chatHostStore,
		})<
			Tools,
			E | Chat.ChatNotFound | ChatStore.ChatStoreError,
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
							const context = yield* Bot.Context,
								at = yield* context.at,
								view = yield* store.read(at.chat)
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
								options.layerExecution(view.chat, namespace),
							)
							// Each Turn owns the host resources built for its Chat.
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
								publish(
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
		const apps =
			options.owner === undefined || Option.isNone(appPlugin)
				? emptyAppPlugin
				: appPlugin.value.forOwner(options.owner)
		const botPluginFor = (
			bot: typeof BotPlugin.Service,
			owner: NonNullable<typeof options.owner>,
		) =>
			bot.forOwner({
				owner,
				namespace,
				read: (id) => store.read(id),
				items: (chat, query) => store.items(chat, query),
				// The plugin is made before `deliver`, so it calls it later.
				deliver: (chat, input) => Effect.suspend(() => deliver(chat, input)),
			})
		// The Bot plugin runs inside the App plugin, so it sees every tool of the Turn.
		// The work, Channel and Computer plugins run inside the Bot plugin, so they see the current Bot.
		// The plugins add tools at run time with JSON Schema parameters. TypeScript cannot see
		// that their merged tool types fit the type of the plugin they join.
		const settingsService = yield* Effect.serviceOption(Settings)
		const owner = options.owner
		const operations = yield* Operations.make({
			store: yield* StoredOperations.make(namespace),
			settings: () =>
				owner === undefined || Option.isNone(settingsService)
					? Effect.succeed(Operations.defaultSettings)
					: settingsService.value.organization(owner.organizationId).pipe(
							Effect.map((snapshot) => {
								const limits = operationsOf(snapshot.document)
								return {
									budget: Duration.millis(limits.toolForegroundBudgetMs),
									maxDuration: Duration.millis(limits.toolMaxDurationMs),
									limit: limits.maxBackgroundOperations,
								}
							}),
							Effect.orElseSucceed(() => Operations.defaultSettings),
						),
		})
		const withInner = (bot: ReturnType<typeof botPluginFor>) => {
			let inner = PluginComposition.merge(
				bot,
				OperationsPlugin.make(operations),
			) as unknown as typeof bot
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
			if (Option.isSome(computerPlugin))
				inner = PluginComposition.merge(
					inner,
					computerPlugin.value.forOwner({
						notify: (chat, notice) =>
							Effect.suspend(() =>
								deliver(chat, {
									input: notice.text,
									author: notice.author,
									notice: { kind: "computer_session", ref: notice.ref },
								}),
							).pipe(
								Effect.catchCause((cause) =>
									Effect.logWarning(
										"The end of a command session could not reach its Chat",
										cause,
									),
								),
								Effect.asVoid,
							),
					}),
				) as unknown as typeof inner
			return inner
		}
		const hostPlugin =
			options.owner === undefined || Option.isNone(botPlugin)
				? apps
				: (PluginComposition.merge(
						apps,
						withInner(botPluginFor(botPlugin.value, options.owner)),
					) as unknown as typeof apps)
		const catalog =
			options.modelCatalog ?? Effect.succeed({ providers: [], models: [] })
		const runtime = yield* ChatRuntime.make({
			store,
			// Only the process with the Live session of a live Chat runs its Turns.
			// Input from other places waits in the inbox until that process takes it.
			canStart: (view) =>
				!isLive(view.chat)
					? Effect.succeed(true)
					: Option.isNone(liveSessions)
						? Effect.succeed(false)
						: liveSessions.value.has(view.chat.id),
			bot: {
				...options.runtime,
				plugin: host,
				hostPlugin,
				// Each Chat gets a summary of its context when it gets near the window of its model.
				modelCatalog:
					options.runtime?.modelCatalog ??
					catalog.pipe(
						Effect.map((current) => current.models.map(Compaction.withSummary)),
					),
				compaction: options.runtime?.compaction ?? Compaction.service,
			},
		}).pipe(Effect.provideService(Operations.Operations, operations))
		const read = (id: Chat.Id) =>
			store.read(id).pipe(Effect.mapError(publicError))
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
				Effect.mapError(publicError),
			)
		const project = (
			view: Chat.View<ChatHost.Values>,
		): Effect.Effect<ChatView, ServiceError> =>
			Effect.gen(function* () {
				const turn = Chat.currentTurn(view.chat)
				const active = yield* runtime.isActive(view.chat.id)
				const open =
					openWork === undefined
						? noOpenWork
						: yield* openWork.count(
								ChatHost.hostState(view.chat).chain.organizationId,
								view.chat.id,
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
		const validateSelection = (selection: Config.Selection) =>
			Effect.gen(function* () {
				const problem = ConfigurationOperations.selectionProblem(
					yield* catalog,
					selection,
				)
				if (Option.isSome(problem))
					return yield* ChatModelInvalid.make(problem.value)
				return options.modelDefaults === undefined
					? selection
					: yield* options.modelDefaults(selection)
			})
		const liveCatalog =
			options.liveCatalog ?? Effect.succeed({ providers: [], models: [] })
		/** A live Chat can use only a Live model, and other Chats never can. */
		const validateLive = (selection: Config.Selection) =>
			Effect.gen(function* () {
				const problem = ConfigurationOperations.selectionProblem(
					yield* liveCatalog,
					selection,
				)
				if (Option.isSome(problem))
					return yield* ChatModelInvalid.make(problem.value)
				return selection
			})
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
		const create: typeof Chats.Service.create = (input) =>
			Effect.gen(function* () {
				const defaults = yield* options.defaults ?? Effect.succeed({})
				if (input.kind === "live")
					return yield* store
						.create({
							id:
								input.id ??
								Chat.Id.make("chat_" + randomUUID().replaceAll("-", "")),
							settings: { ...defaults, model: yield* liveModel(input.model) },
							business: { [chatHostId]: stateOf(input) },
						})
						.pipe(Effect.mapError(publicError), Effect.flatMap(project))
				// A linked Bot comes from another organization. This organization may not
				// have its model, and then the Chat uses the defaults of the host.
				const botModel =
					input.bot.model === undefined
						? undefined
						: input.bot.source === undefined
							? input.bot.model
							: Option.getOrUndefined(
									yield* Effect.option(validateSelection(input.bot.model)),
								)
				// The model of the Bot comes after the defaults of the host.
				const settings = {
					...defaults,
					...(botModel === undefined ? {} : { model: botModel }),
				}
				// A host that resolves models by selection needs a model for each Chat.
				if (settings.model === undefined && options.resolveModel !== undefined)
					return yield* ChatModelInvalid.make({
						reason: "missing",
						message: "Set the model of the Bot.",
					})
				const model =
					settings.model === undefined
						? undefined
						: yield* validateSelection(settings.model)
				const state = stateOf(input)
				return yield* store
					.create({
						id:
							input.id ??
							Chat.Id.make("chat_" + randomUUID().replaceAll("-", "")),
						settings: {
							...settings,
							...(model === undefined ? {} : { model }),
						},
						business: { [chatHostId]: state },
					})
					.pipe(Effect.mapError(publicError), Effect.flatMap(project))
			})
		const direct: typeof Chats.Service.direct = (bot, chain) =>
			Effect.gen(function* () {
				const found = yield* StoredChats.direct(db, namespace, bot.id).pipe(
					Effect.mapError(publicError),
				)
				if (Option.isSome(found)) return found.value
				return yield* create({ bot, kind: "direct", chain }).pipe(
					Effect.map((view) => view.chat.id),
					// Another request made the Chat at the same time. Use that one.
					Effect.catchTag("ChatConflict", (error) =>
						StoredChats.direct(db, namespace, bot.id).pipe(
							Effect.mapError(publicError),
							Effect.flatMap((again) =>
								Effect.fromOption(again).pipe(Effect.mapError(() => error)),
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
				Effect.mapError(publicError),
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
					.pipe(Effect.mapError(publicError))
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
				.pipe(Effect.asVoid, Effect.mapError(publicError))
		const interrupt: typeof Chats.Service.interrupt = (id) =>
			Effect.gen(function* () {
				const view = yield* read(id)
				const turn = Chat.currentTurn(view.chat)
				if (turn === undefined || Turn.isTerminal(turn.status))
					return yield* project(view)
				return yield* runtime.interrupt({ chat: id, turn: turn.id }).pipe(
					Effect.catchTag("TurnConflict", () => store.read(id)),
					Effect.mapError(publicError),
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
						? undefined
						: view.chat.turn?.id === delivery.turn
							? view.chat.turn
							: Option.getOrUndefined(
									yield* store
										.turn(delivery.chat, delivery.turn)
										.pipe(Effect.mapError(publicError)),
								)
				return {
					delivery: delivery.delivery,
					chat: delivery.chat,
					item: delivery.item,
					turn: delivery.turn ?? null,
					response:
						turn === undefined ? null : yield* responseOf(view.chat, turn),
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
					.pipe(Effect.provideContext(routed), Effect.mapError(publicError))
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
					const record =
						view.chat.turn?.id === turn
							? view.chat.turn
							: Option.getOrUndefined(
									yield* store
										.turn(chat, turn)
										.pipe(Effect.mapError(publicError)),
								)
					return record === undefined
						? undefined
						: yield* responseOf(view.chat, record)
				})
				const started = yield* latest
				if (started !== undefined) {
					yield* emit({ type: "response.created", response: started })
					yield* emit({ type: "response.in_progress", response: started })
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
								if (result !== undefined) yield* finish(result)
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
							const part = event.part as Response.StreamPart<
								Record<string, Tool.Any>
							>
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
									{ onNone: () => output.text, onSome: (entry) => entry.text },
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
				Effect.catchCause((cause) =>
					Effect.logWarning("The live events of a Turn stopped", cause),
				),
			)
		const deliverStream: typeof Chats.Service.deliverStream = (id, input) =>
			Effect.gen(function* () {
				const before = yield* read(id)
				const result = yield* deliver(id, input)
				if (result.delivery !== "started" || result.turn === null)
					return { receipt: result, events: Option.none() }
				const sink = yield* ChatEvents.make
				const events = runtime.events({ chat: id, after: before.chat.revision })
				yield* Effect.forkIn(follow(id, result.turn, events, sink), scope)
				return { receipt: result, events: Option.some(sink.stream) }
			})
		const drain: typeof Chats.Service.drain = (id) =>
			runtime
				.drain(id)
				.pipe(
					Effect.provideContext(routed),
					Effect.asVoid,
					Effect.mapError(publicError),
				)
		const closeStale: typeof Chats.Service.closeStale = (id, turn) =>
			Effect.gen(function* () {
				if (yield* runtime.isActive(id)) return
				yield* runtime.interrupt({ chat: id, turn }).pipe(
					// The Turn ended already.
					Effect.catchTag("TurnConflict", () => Effect.void),
					Effect.mapError(publicError),
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
				Effect.mapError(publicError),
			)
		const pageSize = (limit: number | undefined) =>
			Math.max(1, Math.min(100, Math.floor(limit ?? 50)))
		const turns: typeof Chats.Service.turns = (id, input) =>
			Effect.gen(function* () {
				yield* read(id)
				const limit = pageSize(input.limit)
				if (input.after !== undefined) {
					const cursor = yield* store
						.turn(id, input.after)
						.pipe(Effect.mapError(publicError))
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
					.pipe(Effect.mapError(publicError))
				const items = rows.slice(0, limit)
				return {
					items,
					next:
						rows.length > limit
							? Option.getOrNull(
									Option.map(Array.last(items), (turn) => turn.id),
								)
							: null,
				}
			})
		const turnRecord = (id: Chat.Id, turn: Turn.Id) =>
			Effect.gen(function* () {
				const view = yield* read(id)
				const record =
					view.chat.turn?.id === turn
						? Option.some(view.chat.turn)
						: yield* store.turn(id, turn).pipe(Effect.mapError(publicError))
				if (Option.isNone(record))
					return yield* ChatConflict.make({
						message: "The Turn does not belong to this Chat",
					})
				return { view, record: record.value }
			})
		const turn: typeof Chats.Service.turn = (id, turnId) =>
			Effect.gen(function* () {
				const { view, record } = yield* turnRecord(id, turnId)
				return { turn: record, response: yield* responseOf(view.chat, record) }
			})
		const turnItems: typeof Chats.Service.turnItems = (id, turnId, input) =>
			Effect.gen(function* () {
				yield* turnRecord(id, turnId)
				const all = yield* store
					.items(id, { turn: turnId })
					.pipe(Effect.mapError(publicError))
				const offset =
					input.after === undefined
						? 0
						: all.findIndex((entry) => entry.id === input.after) + 1
				if (input.after !== undefined && offset === 0)
					return yield* ChatConflict.make({
						message: "The Item cursor does not belong to this Turn",
					})
				const limit = pageSize(input.limit)
				const items = all.slice(offset, offset + limit)
				return {
					items,
					next:
						offset + limit < all.length
							? Option.getOrNull(
									Option.map(Array.last(items), (item) => item.id),
								)
							: null,
				}
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
					.pipe(Effect.mapError(publicError))
				const page = rows.slice(0, limit)
				return {
					items: page,
					next:
						rows.length > limit
							? Option.getOrNull(
									Option.map(Array.last(page), (item) => item.seq),
								)
							: null,
				}
			})
		const itemsAfter: typeof Chats.Service.itemsAfter = (id, after) =>
			Effect.gen(function* () {
				const items = yield* store
					.items(id, { after })
					.pipe(Effect.mapError(publicError))
				const turns = Array.dedupe(
					items.flatMap((item) =>
						item.origin === undefined ? [] : [item.origin.turn],
					),
				)
				const records = yield* Effect.forEach(turns, (turn) =>
					store.turn(id, turn).pipe(Effect.mapError(publicError)),
				)
				return {
					items,
					authors: new Map(
						records.flatMap((record) =>
							Option.isSome(record) && record.value.author !== undefined
								? [[record.value.id, record.value.author] as const]
								: [],
						),
					),
				}
			})
		// A running Turn says often that it still runs, so another server does not end it.
		yield* Effect.forkIn(
			StoredChats.running(db, namespace).pipe(
				Effect.flatMap((ids) =>
					Effect.forEach(ids, (id) =>
						runtime
							.isActive(id)
							.pipe(
								Effect.flatMap((active) =>
									active
										? StoredChats.heartbeat(db, namespace, id)
										: Effect.void,
								),
							),
					),
				),
				Effect.catchCause((cause) =>
					Effect.logWarning("OpenBot could not mark its running Turns", cause),
				),
				Effect.repeat(Schedule.spaced(heartbeatEvery)),
			),
			scope,
		)
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
						yield* operations.cancelChat(id)
						const view = yield* read(id)
						yield* store.remove(view.chat).pipe(Effect.mapError(publicError))
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
					}).pipe(
						Effect.mapError((error) =>
							error._tag === "ChatConflict" && !(error instanceof Chat.Conflict)
								? error
								: publicError(error),
						),
						Effect.flatMap(project),
					),
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
						.pipe(Effect.mapError(publicError), Effect.flatMap(project)),
				interrupt,
				deliver,
				deliverStream,
				drain,
				closeStale,
				operations,
				startAction,
				turns,
				turn,
				turnItems,
				turnLog: (id, turn) =>
					store.items(id, { turn }).pipe(Effect.mapError(publicError)),
				itemsAfter,
				items,
			}),
			runtime,
			store,
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
) => Layer.effect(Chats, make(options))
