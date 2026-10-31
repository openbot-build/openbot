import * as Failures from "../errors/Failures.ts"
import * as ChatCommands from "./ChatCommands.ts"
import * as ChatQueries from "./ChatQueries.ts"
import * as ChatViews from "./ChatViews.ts"
import * as ChatErrors from "./ChatErrors.ts"
import { response } from "./ResponseMapping.ts"
import {
	ChatStorageUnavailable,
	ChatsApi,
	FilesApi,
	OpenBotApi,
	type ChatCommandRequest,
} from "@openbot-build/api"
import { Bots as BotsApi } from "@openbot-build/domain"
import { Identity, type Caller } from "@openbot-build/domain"
import type { Chat } from "@openbot-build/core"
import { Array as Arr, Effect, Option } from "effect"
import { HttpApiBuilder, type HttpApiEndpoint } from "effect/http-api"
import * as ChatControl from "./ChatControl.ts"
import * as DelegationQueries from "../bots/DelegationQueries.ts"
import { Delegations } from "../bots/Delegations.ts"
import { MemoryBot } from "../bots/MemoryBot.ts"
import { Files } from "../files/Files.ts"
import * as TaskMessages from "./TaskMessages.ts"
import { Store } from "../execution/Store.ts"
import * as HttpErrors from "../execution/HttpErrors.ts"
import { ownerKey } from "../apps/StoredConnections.ts"
import { Item, Turn } from "@openbot-build/core"
import * as ChatHost from "./ChatHost.ts"

type Request<K extends keyof typeof ChatsApi.endpoints> = Omit<
	HttpApiEndpoint.Request<(typeof ChatsApi.endpoints)[K]>,
	"endpoint" | "group" | "request"
>
/** The work of a caller with one Bot: the caller, and the token when a token calls. */
export const chainFor = (caller: Caller, bot: BotsApi.Bot): ChatHost.Chain => ({
	organizationId: caller.organizationId,
	userId: caller.userId,
	bots: [bot.id],
	chats: [],
})
const send = (
	files: Files["Service"],
	inputs: Effect.Success<typeof TaskMessages.make>,
	store: Store["Service"],
	chat: Chat.Id,
	payload: ChatCommandRequest,
	caller: Caller,
) =>
	Effect.gen(function* () {
		const content = yield* files.prompt(caller, payload.input).pipe(
			Effect.catchTags({
				FilesUnavailable: (error) =>
					Effect.fail(error).pipe(
						Failures.replace(
							"OpenBot could not read the Chat input files.",
							() => ChatStorageUnavailable.make({}),
						),
					),
				FileNotFound: (error) =>
					Effect.fail(
						FilesApi.FileInvalid.make({
							message: `The file ${error.id} is not one of your ready files.`,
						}),
					),
				FilesDisabled: (error) =>
					Effect.fail(FilesApi.FileInvalid.make({ message: error.message })),
			}),
		)
		const namespace = ownerKey(caller)
		const receipt = yield* inputs
			.message(namespace, payload.commandKey, {
				chat,
				caller,
				content,
				queue: payload.queue ?? false,
			})
			.pipe(ChatErrors.map)
		const key = { namespace, id: receipt.executionId }
		const saved = yield* store.get(key)
		const accepted = Option.getOrUndefined(
			Arr.findFirst(
				yield* store.events(
					key,
					receipt.sequence > 0 ? receipt.sequence - 1 : 0,
				),
				(event) => event.sequence === receipt.sequence,
			),
		)
		const inputId =
			accepted?.body._tag === "Checkpoint" &&
			accepted.body.resource.kind === "Chat" &&
			accepted.body.resource.id === chat
				? accepted.body.inputId
				: undefined
		return {
			...receipt,
			chat,
			turn: Turn.Id.make(saved.resource.id),
			...(inputId === undefined ? {} : { inputId: Item.Id.make(inputId) }),
		}
	})
const implementations = Effect.gen(function* () {
	const control = yield* ChatControl.make
	const queries = yield* ChatQueries.make
	const delegations = yield* Delegations
	const delegationQueries = yield* DelegationQueries.make
	const memoryBot = yield* MemoryBot
	const files = yield* Files
	const commands = yield* ChatCommands.make
	const inputs = yield* TaskMessages.make
	const store = yield* Store
	const safe = yield* HttpErrors.make
	return {
		sendBotMessage: ({ params, payload }: Request<"sendBotMessage">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				const chat = yield* commands
					.direct(caller, params.botId)
					.pipe(ChatErrors.map)
				return yield* send(files, inputs, store, chat, payload, caller).pipe(
					safe,
				)
			}),
		sendMessage: ({ params, payload }: Request<"sendMessage">) =>
			Effect.gen(function* () {
				return yield* send(
					files,
					inputs,
					store,
					params.chatId,
					payload,
					yield* Identity,
				).pipe(safe)
			}),
		listChats: ({ query }: Request<"listChats">) =>
			Effect.gen(function* () {
				const rows = yield* queries.list(yield* Identity, query)
				return Arr.map(rows, ({ ref, executionId }) =>
					ChatViews.summary(ref, executionId),
				)
			}).pipe(ChatErrors.map),
		getChat: ({ params }: Request<"getChat">) =>
			Effect.gen(function* () {
				return ChatViews.project(
					yield* queries.get(yield* Identity, params.chatId),
				)
			}).pipe(ChatErrors.map),
		updateChat: ({ params, payload }: Request<"updateChat">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				const view = yield* commands.update(caller, params.chatId, payload)
				return ChatViews.project(yield* queries.describe(caller, view))
			}).pipe(ChatErrors.map),
		deleteChat: ({ params, payload }: Request<"deleteChat">) =>
			Effect.gen(function* () {
				return yield* control
					.command(yield* Identity, payload.commandKey, params.chatId, "delete")
					.pipe(ChatErrors.map, safe)
			}),
		chatModels: ({ params }: Request<"chatModels">) =>
			Effect.gen(function* () {
				return yield* queries.models(yield* Identity, params.chatId)
			}).pipe(ChatErrors.map),
		chatItems: ({ params, query }: Request<"chatItems">) =>
			Effect.gen(function* () {
				return yield* queries.items(yield* Identity, params.chatId, query)
			}).pipe(ChatErrors.map),
		chatTurns: ({ params, query }: Request<"chatTurns">) =>
			Effect.gen(function* () {
				return yield* queries.turns(yield* Identity, params.chatId, query)
			}).pipe(ChatErrors.map),
		getTurn: ({ params }: Request<"getTurn">) =>
			Effect.gen(function* () {
				const { saved, items } = yield* queries.turn(
					yield* Identity,
					params.chatId,
					params.turnId,
				)
				return {
					turn: saved.record,
					response: response(params.chatId, saved.record, items),
				}
			}).pipe(ChatErrors.map),
		turnItems: ({ params, query }: Request<"turnItems">) =>
			Effect.gen(function* () {
				return yield* queries.turnItems(
					yield* Identity,
					params.chatId,
					params.turnId,
					query,
				)
			}).pipe(ChatErrors.map),
		interruptChat: ({ params, payload }: Request<"interruptChat">) =>
			Effect.gen(function* () {
				return yield* control
					.command(
						yield* Identity,
						payload.commandKey,
						params.chatId,
						"interrupt",
						payload.delegations,
					)
					.pipe(ChatErrors.map, safe)
			}),
		chatTodos: ({ params }: Request<"chatTodos">) =>
			Effect.gen(function* () {
				return yield* queries.todos(yield* Identity, params.chatId)
			}).pipe(ChatErrors.map),
		updateChatTodos: ({ params, payload }: Request<"updateChatTodos">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				const view = yield* commands.todos(caller, params.chatId, payload)
				return ChatViews.project(yield* queries.describe(caller, view))
			}).pipe(ChatErrors.map),
		chatDelegations: ({ params }: Request<"chatDelegations">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				yield* queries.read(caller, params.chatId).pipe(ChatErrors.map)
				const list = yield* delegations
					.forChat(caller.organizationId, params.chatId)
					.pipe(
						Failures.replace(
							"OpenBot could not read the delegations of a Chat.",
							() => ChatStorageUnavailable.make({}),
						),
					)
				return yield* Effect.forEach(list, (stored) =>
					delegationQueries.read(caller, stored.delegation.id),
				)
			}).pipe(safe),
		// Reading the Chat first checks that the caller may see it.
		chatConfessions: ({ params }: Request<"chatConfessions">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				yield* queries.read(caller, params.chatId).pipe(ChatErrors.map)
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
				yield* queries.read(caller, params.chatId).pipe(ChatErrors.map)
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
