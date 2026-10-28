import {
	Chat,
	ChatStoreRepository,
	Config,
	Store,
	type Turn,
} from "@openbot-build/core"
import {
	Authorization,
	Bots as BotDomain,
	ChatModelInvalid,
	type Caller,
	type BotId,
	type ChatSettingsChange,
	type ChatTodoChange,
} from "@openbot-build/domain"
import { Crypto, Effect, Option, String as Str } from "effect"
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
			readonly kind: "direct" | "live" | "channel"
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
			const id = Chat.Id.make(
				"chat_" +
					Str.replaceAll(
						"-",
						"",
					)(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
			)
			yield* check(caller, id, "write")
			yield* check(caller, id, "run")
			const model = yield* ChatModels.select(
				{
					...input,
					bot,
					...(Option.isSome(models.defaultModel)
						? { defaultModel: models.defaultModel.value }
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
			return yield* store.create({
				id,
				settings: { model },
				business: {
					[ChatHost.chatHostId]: {
						bot: bot.id,
						kind: input.kind,
						...(input.channel === undefined ? {} : { channel: input.channel }),
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
					return Effect.succeed([
						undefined,
						Option.some({
							chat: {
								settings,
								...(input.planApproval === undefined
									? {}
									: {
											business: {
												...current.chat.business,
												[ChatHost.chatHostId]:
													input.planApproval === null
														? kept
														: { ...kept, planApproval: input.planApproval },
											},
										}),
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
