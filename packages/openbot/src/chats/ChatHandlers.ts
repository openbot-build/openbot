import {
	Authorization,
	ChatConflict,
	ChatModelInvalid,
	ChatStorageUnavailable,
	ChatsApi,
	FilesApi,
	Identity,
	OpenBotApi,
	type Caller,
	BotsApi,
	type SendMessageRequest,
} from "@openbot-build/api"
import { type Chat, Config } from "@openbot-build/core"
import { Array as Arr, Clock, Effect, Option } from "effect"
import { HttpApiBuilder, type HttpApiEndpoint } from "effect/http-api"
import { Backend } from "../app/Backend.ts"
import * as Failures from "../app/Failures.ts"
import { Bots } from "../bots/Bots.ts"
import { Coordinator } from "../bots/Coordinator.ts"
import { Delegations, view } from "../bots/Delegations.ts"
import { MemoryBot } from "../bots/MemoryBot.ts"
import { Files } from "../files/Files.ts"
import * as Check from "../authorization/Check.ts"
import type * as Chats from "./Chats.ts"
import * as ChatHost from "./ChatHost.ts"
import * as Execution from "./Execution.ts"
import { ModelRegistry } from "../models/ModelRegistry.ts"

type Request<K extends keyof typeof ChatsApi.endpoints> = Omit<
	HttpApiEndpoint.Request<(typeof ChatsApi.endpoints)[K]>,
	"endpoint" | "group" | "request"
>
/** The Chats of the calling member. */
const currentChats = Effect.map(Backend, (backend) =>
	Effect.flatMap(Identity, (caller) =>
		backend
			.forCaller(caller)
			.pipe(
				Failures.replace("OpenBot could not open the Chats of a member.", () =>
					ChatStorageUnavailable.make({}),
				),
			),
	),
)
/** The work of a caller with one Bot: the caller, and the token when a token calls. */
export const chainFor = (caller: Caller, bot: BotsApi.Bot): ChatHost.Chain => ({
	organizationId: caller.organizationId,
	userId: caller.userId,
	bots: [bot.id],
	chats: [],
})
const send = (
	files: Files["Service"],
	chats: typeof Chats.Chats.Service,
	chat: Chat.Id,
	payload: SendMessageRequest,
	caller: Caller,
) =>
	Effect.gen(function* () {
		const input = {
			input: yield* files.prompt(caller, payload.input).pipe(
				Effect.catchTags({
					FilesUnavailable: () => Effect.fail(ChatStorageUnavailable.make({})),
					FileNotFound: (error) =>
						Effect.fail(
							FilesApi.FileInvalid.make({
								message: `The file ${error.id} is not one of your ready files.`,
							}),
						),
					FilesDisabled: (error) =>
						Effect.fail(FilesApi.FileInvalid.make({ message: error.message })),
				}),
			),
			author: ChatHost.authorOf(caller.userId, caller.tokenId),
		}
		if (payload.stream !== true) return yield* chats.deliver(chat, input)
		const result = yield* chats.deliverStream(chat, input)
		return Option.match(result.events, {
			onNone: () => result.receipt,
			onSome: (events) => events,
		})
	})
const implementations = Effect.gen(function* () {
	const current = yield* currentChats
	const bots = yield* Bots
	const registry = yield* ModelRegistry
	const coordinator = yield* Coordinator
	const delegations = yield* Delegations
	const memoryBot = yield* MemoryBot
	const files = yield* Files
	const { check } = yield* Check.make
	return {
		sendBotMessage: ({ params, payload }: Request<"sendBotMessage">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				// Work for a Bot needs the delegate permission on it.
				const bot = yield* bots.access(caller, params.botId, "delegate")
				if (bot.archived)
					return yield* BotsApi.BotInvalid.make({
						message: "An archived Bot does no new work.",
					})
				const chats = yield* current
				const chat = yield* chats.direct(bot, chainFor(caller, bot))
				// The request owns the scope, so a live stream stays open while the client reads it.
				return yield* send(files, chats, chat, payload, caller)
			}),
		sendMessage: ({ params, payload }: Request<"sendMessage">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				const chats = yield* current
				const view = yield* chats.read(params.chatId)
				const kind = ChatHost.hostState(view.chat).kind
				// A person talks in a direct Chat or a live Chat, or adds to the work of a
				// task Chat. In a live Chat, the message waits for its Live session.
				if (kind !== "direct" && kind !== "task" && kind !== "live")
					return yield* ChatConflict.make({
						message:
							"Only direct Chats, task Chats and live Chats take messages.",
					})
				return yield* send(files, chats, params.chatId, payload, caller)
			}),
		listChats: ({ query }: Request<"listChats">) =>
			Effect.flatMap(current, (chats) =>
				chats.list({
					...(query.bot === undefined ? {} : { bot: query.bot }),
					...(query.kind === undefined ? {} : { kind: query.kind }),
				}),
			),
		getChat: ({ params }: Request<"getChat">) =>
			Effect.flatMap(current, (chats) => chats.get(params.chatId)),
		updateChat: ({ params, payload }: Request<"updateChat">) =>
			Effect.gen(function* () {
				// A new model also needs the permission to use models.
				if (payload.model !== undefined && payload.model !== null) {
					const caller = yield* Identity
					yield* check(caller, {
						action: "use",
						resource: Authorization.Model.make({
							organizationId: caller.organizationId,
							provider: payload.model.provider,
							id: payload.model.model,
						}),
					})
				}
				return yield* (yield* current).update(params.chatId, payload)
			}),
		switchChatExecution: ({
			params,
			payload,
		}: Request<"switchChatExecution">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				const chats = yield* current
				const view = yield* chats.read(params.chatId)
				const execution = Execution.of(view.chat)
				const bot = yield* bots.access(
					caller,
					ChatHost.hostState(view.chat).bot,
					"delegate",
				)
				if (bot.archived)
					return yield* BotsApi.BotInvalid.make({
						message: "An archived Bot does no new work.",
					})
				const saved =
					payload.mode === "live" ? execution.liveModel : execution.chatModel
				let model =
					payload.model ??
					saved ??
					(payload.mode === "chat" ? bot.model : undefined)
				if (model === undefined && payload.mode === "live") {
					const first = (yield* registry
						.liveCatalog(caller.organizationId)
						.pipe(
							Failures.replace(
								"OpenBot could not read the Live models for a change of execution.",
								() =>
									ChatModelInvalid.make({
										reason: "missing",
										message: "The organization has no Live model.",
									}),
							),
						)).models[0]
					if (first !== undefined)
						model = Config.Selection.make({
							provider: first.provider,
							model: first.id,
						})
				}
				if (model === undefined)
					return yield* ChatModelInvalid.make({
						reason: "missing",
						message: "Choose a model for this kind of execution.",
					})
				yield* check(caller, {
					action: "use",
					resource: Authorization.Model.make({
						organizationId: caller.organizationId,
						provider: model.provider,
						id: model.model,
					}),
				})
				return yield* chats.switchExecution(params.chatId, {
					...payload,
					model,
				})
			}),
		deleteChat: ({ params }: Request<"deleteChat">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				const chats = yield* current
				const view = yield* chats.read(params.chatId)
				const kind = ChatHost.hostState(view.chat).kind
				if (kind !== "direct" && kind !== "channel" && kind !== "live")
					return yield* ChatConflict.make({
						message:
							"Only direct Chats, channel Chats and live Chats can be deleted.",
					})
				// The work that the Chat gave away ends first.
				yield* coordinator
					.cancelAll(
						caller.organizationId,
						params.chatId,
						"The Chat was deleted.",
					)
					.pipe(
						Failures.replace(
							"OpenBot could not stop the work that a Chat gave away.",
							() => ChatStorageUnavailable.make({}),
						),
					)
				yield* chats.remove(params.chatId)
			}),
		chatModels: ({ params }: Request<"chatModels">) =>
			Effect.flatMap(current, (chats) => chats.models(params.chatId)),
		waitChat: ({ params, query }: Request<"waitChat">) =>
			Effect.flatMap(current, (chats) =>
				chats.wait(
					params.chatId,
					query.after,
					query.timeoutMs,
					query.afterActivity,
				),
			),
		chatItems: ({ params, query }: Request<"chatItems">) =>
			Effect.flatMap(current, (chats) => chats.items(params.chatId, query)),
		chatTurns: ({ params, query }: Request<"chatTurns">) =>
			Effect.flatMap(current, (chats) => chats.turns(params.chatId, query)),
		getTurn: ({ params }: Request<"getTurn">) =>
			Effect.flatMap(current, (chats) =>
				chats.turn(params.chatId, params.turnId),
			),
		turnItems: ({ params, query }: Request<"turnItems">) =>
			Effect.flatMap(current, (chats) =>
				chats.turnItems(params.chatId, params.turnId, query),
			),
		interruptChat: ({ params, payload }: Request<"interruptChat">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				const chats = yield* current
				if (payload.delegations === true)
					yield* coordinator
						.cancelAll(
							caller.organizationId,
							params.chatId,
							"The person stopped the work.",
						)
						.pipe(
							Failures.replace(
								"OpenBot could not stop the work that a Chat gave away.",
								() => ChatStorageUnavailable.make({}),
							),
						)
				return yield* chats.interrupt(params.chatId)
			}),
		chatTodos: ({ params }: Request<"chatTodos">) =>
			Effect.flatMap(current, (chats) => chats.todos(params.chatId)),
		updateChatTodos: ({ params, payload }: Request<"updateChatTodos">) =>
			Effect.flatMap(current, (chats) =>
				chats.updateTodos(params.chatId, payload),
			),
		chatDelegations: ({ params }: Request<"chatDelegations">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				yield* (yield* current).get(params.chatId)
				const list = yield* delegations
					.forChat(caller.organizationId, params.chatId)
					.pipe(
						Failures.replace(
							"OpenBot could not read the delegations of a Chat.",
							() => ChatStorageUnavailable.make({}),
						),
					)
				const now = yield* Clock.currentTimeMillis
				return Arr.map(list, (stored) => view(stored, now))
			}),
		// Reading the Chat first checks that the caller may see it.
		chatConfessions: ({ params }: Request<"chatConfessions">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				yield* (yield* current).get(params.chatId)
				return yield* memoryBot
					.confessions(caller.organizationId, params.chatId)
					.pipe(
						Failures.replace(
							"OpenBot could not read the confessions of a Chat.",
							() => ChatStorageUnavailable.make({}),
						),
					)
			}),
		chatEnrichments: ({ params }: Request<"chatEnrichments">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				yield* (yield* current).get(params.chatId)
				return yield* memoryBot
					.enrichments(caller.organizationId, params.chatId)
					.pipe(
						Failures.replace(
							"OpenBot could not read the enrichments of a Chat.",
							() => ChatStorageUnavailable.make({}),
						),
					)
			}),
	}
})
export const layerPlatform = HttpApiBuilder.group(
	OpenBotApi,
	"chats",
	(handlers) =>
		Effect.map(implementations, (routes) => handlers.handleAll(routes)),
)
