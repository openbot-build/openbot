import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import {
	ChatConflict,
	ChatStorageUnavailable,
	ChatsApi,
	Identity,
	OpenBotApi,
	Permissions,
	type Caller,
	BotsApi,
	type SendMessageRequest,
} from "@openbot-build/api"
import type { Chat } from "@openbot-build/core"
import { Effect, Option } from "effect"
import { HttpApiBuilder, type HttpApiEndpoint } from "effect/http-api"
import { Backend } from "../app/Backend.ts"
import { Bots } from "../bots/Bots.ts"
import { Coordinator } from "../bots/Coordinator.ts"
import { Delegations } from "../bots/Delegations.ts"
import { MemoryBot } from "../bots/MemoryBot.ts"
import { can } from "../authorization/Check.ts"
import { resourceKey } from "../authorization/Policy.ts"
import type * as Chats from "./Chats.ts"
import * as ChatHost from "./ChatHost.ts"

type Request<K extends keyof typeof ChatsApi.endpoints> = Omit<
	HttpApiEndpoint.Request<(typeof ChatsApi.endpoints)[K]>,
	"endpoint" | "group" | "request"
>
/** The Chats of the calling member. */
const currentChats = Effect.map(Backend, (backend) =>
	Effect.flatMap(Identity, (caller) =>
		backend
			.forCaller(caller)
			.pipe(Effect.mapError(() => ChatStorageUnavailable.make({}))),
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
	chats: typeof Chats.Chats.Service,
	chat: Chat.Id,
	payload: SendMessageRequest,
	caller: Caller,
) =>
	Effect.gen(function* () {
		const input = {
			input: payload.input,
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
	const coordinator = yield* Coordinator
	const delegations = yield* Delegations
	const memoryBot = yield* MemoryBot
	const services = yield* Effect.context<AuthorizationServices>()
	const unavailable = () => ChatStorageUnavailable.make({})
	return {
		sendBotMessage: ({ params, payload }: Request<"sendBotMessage">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				// Work for a Bot needs the delegate permission on it.
				const bot = yield* bots
					.access(caller, params.botId, "bots.delegate")
					.pipe(Effect.provideContext(services))
				if (bot.archived)
					return yield* BotsApi.BotInvalid.make({
						message: "An archived Bot does no new work.",
					})
				const chats = yield* current
				const chat = yield* chats.direct(bot, chainFor(caller, bot))
				// The request owns the scope, so a live stream stays open while the client reads it.
				return yield* send(chats, chat, payload, caller)
			}),
		sendMessage: ({ params, payload }: Request<"sendMessage">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				const chats = yield* current
				const view = yield* chats.read(params.chatId)
				const kind = ChatHost.hostState(view.chat).kind
				// A person talks in a direct Chat, or adds to the work of a task Chat.
				if (kind !== "direct" && kind !== "task")
					return yield* ChatConflict.make({
						message: "Only direct Chats and task Chats take messages.",
					})
				return yield* send(chats, params.chatId, payload, caller)
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
					const key = resourceKey({
						subject: caller,
						kind: "model",
						id: Option.none(),
					})
					if (
						!(yield* can({ caller, permission: "models.use", key }).pipe(
							Effect.provideContext(services),
						))
					)
						return yield* Permissions.PermissionDenied.make({
							permission: "models.use",
							resource: key,
						})
				}
				return yield* (yield* current).update(params.chatId, payload)
			}),
		deleteChat: ({ params }: Request<"deleteChat">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				const chats = yield* current
				const view = yield* chats.read(params.chatId)
				const kind = ChatHost.hostState(view.chat).kind
				if (kind !== "direct" && kind !== "channel")
					return yield* ChatConflict.make({
						message: "Only direct Chats and channel Chats can be deleted.",
					})
				// The work that the Chat gave away ends first.
				yield* coordinator
					.cancelAll(
						caller.organizationId,
						params.chatId,
						"The Chat was deleted.",
					)
					.pipe(Effect.mapError(unavailable))
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
						.pipe(Effect.mapError(unavailable))
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
					.pipe(Effect.mapError(unavailable))
				return list.map((stored) => stored.delegation)
			}),
		// Reading the Chat first checks that the caller may see it.
		chatConfessions: ({ params }: Request<"chatConfessions">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				yield* (yield* current).get(params.chatId)
				return yield* memoryBot
					.confessions(caller.organizationId, params.chatId)
					.pipe(Effect.mapError(unavailable))
			}),
		chatEnrichments: ({ params }: Request<"chatEnrichments">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				yield* (yield* current).get(params.chatId)
				return yield* memoryBot
					.enrichments(caller.organizationId, params.chatId)
					.pipe(Effect.mapError(unavailable))
			}),
	}
})
export const layerPlatform = HttpApiBuilder.group(
	OpenBotApi,
	"chats",
	(handlers) =>
		Effect.map(implementations, (routes) => handlers.handleAll(routes)),
)
