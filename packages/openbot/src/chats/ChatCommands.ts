import {
	Chat,
	ChatStoreRepository,
	Config,
	Store,
	Turn,
	Item,
	ChatState,
} from "@openbot-build/core"
import {
	Authorization,
	Bots as BotDomain,
	ChatModelInvalid,
	ChatConflict,
	type Caller,
	type BotId,
	type ChatSettingsChange,
	type ChatTodoChange,
} from "@openbot-build/domain"
import type {
	CreateConversationRequest,
	ForkChatRequest,
} from "@openbot-build/domain/Chats"
import { ChatMemory, defaultChatMemory } from "@openbot-build/domain/Chats"
import {
	Crypto,
	Effect,
	Option,
	Schema,
	Array as Arr,
	String as Str,
} from "effect"
import { ownerKey } from "../apps/StoredConnections.ts"
import * as Check from "../authorization/Check.ts"
import { Bots } from "../bots/Bots.ts"
import * as Db from "../database/Database.ts"
import { ModelRegistry } from "../models/ModelRegistry.ts"
import * as Todos from "../plugins/work/Todos.ts"
import * as ChatHost from "./ChatHost.ts"
import * as ChatModels from "./ChatModels.ts"
import * as StoredChats from "./StoredChats.ts"

/** Chat records have no runtime. Only a submitted Turn opens models and tools. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const crypto = yield* Crypto.Crypto
	const bots = yield* Bots
	const models = yield* ModelRegistry
	const checks = yield* Check.make
	const definition = yield* Store.define({
		stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore, ...Todos.stores },
		schemaVersion: "chat/1",
	})
	const records = (caller: Caller) =>
		ChatStoreRepository.make({
			definition,
			persistence: StoredChats.persistence(db, ownerKey(caller)),
		})
	const check = (
		caller: Caller,
		id: Chat.Id,
		action: "read" | "write" | "run",
	) =>
		checks.check(caller, {
			action,
			resource: Authorization.Chat.make({
				organizationId: caller.organizationId,
				ownerUserId: caller.userId,
				id,
			}),
		})
	const newChat = (
		caller: Caller,
		input: {
			readonly bot: BotId
			readonly kind: "direct" | "live" | "channel" | "conversation"
			readonly requestId?: string
			readonly memory?: ChatMemory
			readonly channel?: NonNullable<ChatHost.ChatHostState["channel"]>
			readonly title?: string
			readonly model?: Config.Selection
		},
	) =>
		Effect.gen(function* () {
			const bot = yield* bots.access(caller, input.bot, "delegate")
			if (bot.archived)
				return yield* BotDomain.BotInvalid.make({
					message: "An archived Bot does no new work.",
				})
			const id =
				input.requestId === undefined
					? Chat.Id.make(
							"chat_" +
								Str.replaceAll(
									"-",
									"",
								)(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
						)
					: Chat.Id.make("chat_request_" + input.requestId)
			yield* check(caller, id, "write")
			yield* check(caller, id, "run")
			const defaultModel = yield* models.chatSelection(caller.organizationId)
			const model = yield* ChatModels.select(
				{
					...input,
					bot,
					...(Option.isSome(defaultModel)
						? { defaultModel: defaultModel.value }
						: {}),
				},
				yield* input.kind === "live"
					? models.liveCatalog(caller.organizationId)
					: models.catalog(caller.organizationId),
			)
			yield* checks.check(caller, {
				action: "use",
				resource: Authorization.Model.make({
					organizationId: caller.organizationId,
					provider: model.provider,
					id: model.model,
				}),
			})
			const store = yield* records(caller)
			const signature = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.JsonObject),
			)({
				bot: input.bot,
				kind: input.kind,
				memory: input.memory ?? defaultChatMemory,
			}).pipe(Effect.orDie)
			const existing = yield* store.get(id)
			if (Option.isSome(existing)) {
				const creation = ChatHost.hostState(existing.value).creation
				if (
					input.requestId === undefined ||
					creation?.requestId !== input.requestId ||
					creation.signature !== signature
				)
					return yield* ChatConflict.make({
						message: "This request ID already names a different Chat request",
					})
				return yield* store.read(id)
			}
			return yield* store
				.create({
					id,
					settings:
						input.kind === "live" || input.model !== undefined ? { model } : {},
					business: {
						[ChatHost.chatHostId]: {
							bot: bot.id,
							kind: input.kind,
							...(input.memory === undefined ? {} : { memory: input.memory }),
							...(input.requestId === undefined
								? {}
								: { creation: { requestId: input.requestId, signature } }),
							...(input.channel === undefined
								? {}
								: { channel: input.channel }),
							...(input.title === undefined ? {} : { title: input.title }),
							chain: {
								organizationId: caller.organizationId,
								userId: caller.userId,
								bots: [bot.id],
								chats: [],
							},
						},
					},
				})
				.pipe(
					Effect.catchTag("ChatStoreError", (error) =>
						Effect.gen(function* () {
							if (
								input.requestId === undefined ||
								error.reason !== "reference-conflict"
							)
								return yield* error
							const saved = yield* store.get(id)
							if (Option.isNone(saved)) return yield* error
							const creation = ChatHost.hostState(saved.value).creation
							if (
								creation?.requestId !== input.requestId ||
								creation.signature !== signature
							)
								return yield* ChatConflict.make({
									message:
										"This request ID already names a different Chat request",
								})
							return yield* store.read(id)
						}),
					),
				)
		}).pipe(Effect.scoped)
	const direct = (caller: Caller, bot: BotId) =>
		Effect.gen(function* () {
			// Check even when the Chat exists: a new message needs the current Bot grant.
			const current = yield* bots.access(caller, bot, "delegate")
			if (current.archived)
				return yield* BotDomain.BotInvalid.make({
					message: "An archived Bot does no new work.",
				})
			const found = yield* StoredChats.direct(db, ownerKey(caller), bot)
			if (Option.isSome(found)) {
				yield* check(caller, found.value, "run")
				return found.value
			}
			return yield* newChat(caller, { bot, kind: "direct" }).pipe(
				Effect.map((view) => view.chat.id),
				Effect.catchTag("ChatStoreError", (error) =>
					error.reason !== "reference-conflict"
						? Effect.fail(error)
						: StoredChats.direct(db, ownerKey(caller), bot).pipe(
								Effect.flatMap((found) =>
									Effect.gen(function* () {
										if (Option.isNone(found)) return yield* error
										yield* check(caller, found.value, "run")
										return found.value
									}),
								),
							),
				),
			)
		})
	const fork = (caller: Caller, id: Chat.Id, input: ForkChatRequest) =>
		Effect.gen(function* () {
			yield* check(caller, id, "read")
			const destination = Chat.Id.make("chat_request_" + input.requestId)
			yield* check(caller, destination, "write")
			yield* check(caller, destination, "run")
			const store = yield* records(caller)
			const sourceView = yield* store.read(id)
			const bot = yield* bots.access(
				caller,
				ChatHost.hostState(sourceView.chat).bot,
				"delegate",
			)
			if (bot.archived)
				return yield* BotDomain.BotInvalid.make({
					message: "An archived Bot does no new work.",
				})
			const signature = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.JsonObject),
			)({
				source: id,
				expected: input.expected,
				through: input.through ?? null,
				reason: input.reason,
			}).pipe(Effect.orDie)
			// Destination is scoped to this owner and request.
			const existing = yield* store.get(destination)
			if (Option.isSome(existing)) {
				if (
					ChatHost.hostState(existing.value).creation?.requestId !==
						input.requestId ||
					ChatHost.hostState(existing.value).creation?.signature !== signature
				)
					return yield* ChatConflict.make({
						message: "This request ID already names a different Chat request",
					}).pipe(Effect.scoped)
				return yield* store.read(destination)
			}
			if (
				input.reason === "regenerate" &&
				(input.through === undefined || input.through.edge !== "before")
			)
				return yield* ChatConflict.make({
					message: "Regeneration needs the start of a recorded Turn",
				}).pipe(Effect.scoped)
			const copied = yield* store
				.modifyEffect({
					chat: id,
					expectedRevision: input.expected,
					update: (source) =>
						Effect.gen(function* () {
							const state = ChatHost.hostState(source.chat)
							if (state.kind !== "conversation")
								return yield* ChatConflict.make({
									message: "Only a conversation can be forked",
								}).pipe(Effect.scoped)
							if (
								source.chat.turn?.status._tag === "Running" ||
								source.chat.inbox.length > 0 ||
								state.control !== undefined
							)
								return yield* ChatConflict.make({
									message: "The Chat still has work to settle",
								})
							const all = yield* store.items(id)
							const turns = yield* store.turns(id)
							let throughSeq = source.chat.seq
							if (input.through !== undefined) {
								const chosen = Option.getOrUndefined(
									Arr.findFirst(
										turns,
										(turn) => turn.id === input.through?.turnId,
									),
								)
								if (chosen === undefined || !Turn.isTerminal(chosen.status))
									return yield* ChatConflict.make({
										message: "The source Turn has not ended",
									}).pipe(Effect.scoped)
								const own = Arr.filter(
									all,
									(item) => item.origin?.turn === chosen.id,
								)
								if (own.length === 0)
									return yield* ChatConflict.make({
										message: "The source Turn has no saved Items",
									}).pipe(Effect.scoped)
								throughSeq = Item.Seq.make(
									input.through.edge === "before"
										? Math.min(...Arr.map(own, (item) => item.seq)) - 1
										: Math.max(...Arr.map(own, (item) => item.seq)),
								)
							}
							const items = Arr.filter(all, (item) => item.seq <= throughSeq)
							const retained = Arr.filter(turns, (turn) =>
								Arr.some(items, (item) => item.origin?.turn === turn.id),
							)
							if (
								Arr.some(
									retained,
									(turn) =>
										!Turn.isTerminal(turn.status) ||
										Arr.some(
											[...turn.input, ...turn.items],
											(item) => !Arr.some(items, (entry) => entry.id === item),
										),
								)
							)
								return yield* ChatConflict.make({
									message: "The boundary cuts through a Turn",
								}).pipe(Effect.scoped)
							const branchOf = {
								chat: id,
								revision: input.expected,
								throughSeq,
								root: state.branchOf?.root ?? id,
								reason: input.reason,
							}
							const view = yield* store
								.create({
									id: destination,
									settings: source.chat.settings,
									business: {
										[ChatHost.chatHostId]: {
											bot: state.bot,
											kind: "conversation",
											chain: state.chain,
											memory: state.memory ?? defaultChatMemory,
											branchOf,
											creation: { requestId: input.requestId, signature },
											learnAfterSeq: throughSeq,
											...(state.planApproval === undefined
												? {}
												: { planApproval: state.planApproval }),
										},
									},
									value: {
										conversation: {
											context: {
												_tag: "Prompt",
												prompt: ChatState.promptOf(items),
											},
											closed: true,
										},
									},
									seed: {
										items,
										turns: retained,
										source: { chat: id, revision: input.expected },
									},
								})
								.pipe(Effect.scoped)
							return [view, Option.none()] as const
						}),
				})
				.pipe(
					Effect.scoped,
					Effect.catchTag("ChatStoreError", (error) =>
						Effect.gen(function* () {
							if (error.reason !== "reference-conflict") return yield* error
							const saved = yield* store.get(destination)
							if (Option.isNone(saved)) return yield* error
							const creation = ChatHost.hostState(saved.value).creation
							if (
								creation?.requestId !== input.requestId ||
								creation.signature !== signature
							)
								return yield* ChatConflict.make({
									message:
										"This request ID already names a different Chat request",
								})
							return { result: yield* store.read(destination) }
						}),
					),
				)

			return copied.result
		}).pipe(Effect.scoped)

	const update = (caller: Caller, chat: Chat.Id, input: ChatSettingsChange) =>
		Effect.gen(function* () {
			yield* check(caller, chat, "write")
			const store = yield* records(caller)
			const live =
				ChatHost.hostState((yield* store.read(chat)).chat).kind === "live"
			if (live && input.model === null)
				return yield* ChatModelInvalid.make({
					reason: "missing",
					message: "A live Chat needs a Live model.",
				})
			if (input.model !== undefined && input.model !== null) {
				yield* ChatModels.validate(
					yield* live
						? models.liveCatalog(caller.organizationId)
						: models.catalog(caller.organizationId),
					input.model,
				)
				yield* checks.check(caller, {
					action: "use",
					resource: Authorization.Model.make({
						organizationId: caller.organizationId,
						provider: input.model.provider,
						id: input.model.model,
					}),
				})
			}
			return (yield* store.modifyEffect({
				chat,
				expectedRevision: input.expected,
				update: (current) => {
					const { model: _, ...rest } = current.chat.settings
					const settings: Turn.Settings = {
						...(input.model === null ? rest : current.chat.settings),
						...(input.mode === undefined ? {} : { mode: input.mode }),
						...(input.model === undefined || input.model === null
							? {}
							: { model: input.model }),
					}
					const state = ChatHost.hostState(current.chat)
					const { planApproval: _approval, ...kept } = state
					const nextState = {
						...(input.planApproval === undefined
							? state
							: input.planApproval === null
								? kept
								: { ...kept, planApproval: input.planApproval }),
						...(input.memory === undefined
							? {}
							: {
									memory: input.memory,
									memoryEpoch: (state.memoryEpoch ?? 0) + 1,
								}),
					}
					return Effect.succeed([
						undefined,
						Option.some({
							chat: {
								settings,
								business: {
									...current.chat.business,
									[ChatHost.chatHostId]: nextState,
								},
							},
						}),
					] as const)
				},
			})).view
		}).pipe(Effect.scoped)
	const todos = (caller: Caller, chat: Chat.Id, input: ChatTodoChange) =>
		Effect.gen(function* () {
			yield* check(caller, chat, "write")
			return yield* Todos.replace({
				store: yield* records(caller),
				chat,
				items: input.items,
				revision: input.revision,
			})
		}).pipe(Effect.scoped)
	return {
		direct,
		fork,
		createConversation: (caller: Caller, input: CreateConversationRequest) =>
			newChat(caller, {
				bot: input.botId,
				kind: "conversation",
				requestId: input.requestId,
				...(input.memory === undefined ? {} : { memory: input.memory }),
			}),
		createChannel: (
			caller: Caller,
			input: {
				readonly bot: BotId
				readonly channel: NonNullable<ChatHost.ChatHostState["channel"]>
				readonly title: string
			},
		) => newChat(caller, { ...input, kind: "channel" }),
		createLive: (caller: Caller, bot: BotId, model?: Config.Selection) =>
			newChat(caller, {
				bot,
				kind: "live",
				...(model === undefined ? {} : { model }),
			}),
		update,
		todos,
	}
})
