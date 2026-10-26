import {
	ChatStorageUnavailable,
	Identity,
	OpenBotApi,
	OperationNotFound,
} from "@openbot-build/api"
import type { Chat, Operation } from "@openbot-build/core"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Backend } from "../app/Backend.ts"
import * as Failures from "../app/Failures.ts"

type Chats = Effect.Success<ReturnType<(typeof Backend.Service)["forCaller"]>>

/**
 * Checks that the Chat is one of the caller. A Chat that is not there and a
 * storage failure keep their meaning. The other errors are not in the contract
 * of this group, so they become a storage failure.
 */
const ownChat = (chats: Chats, id: Chat.Id) =>
	chats.get(id).pipe(
		Failures.replaceTag("ChatConflict", "OpenBot could not read the Chat", () =>
			ChatStorageUnavailable.make({}),
		),
		Failures.replaceTag(
			"ChatModelInvalid",
			"OpenBot could not read the Chat",
			() => ChatStorageUnavailable.make({}),
		),
	)
const notFound = (error: { readonly id: Operation.Id }) =>
	Effect.fail(OperationNotFound.make({ id: error.id }))

export const layer = HttpApiBuilder.group(
	OpenBotApi,
	"operations",
	(handlers) =>
		Effect.gen(function* () {
			const backend = yield* Backend
			/** The Chats of the calling member, after a check that the Chat is one of them. */
			const chatsFor = (chat: Chat.Id) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const chats = yield* backend
						.forCaller(caller)
						.pipe(
							Failures.replace("OpenBot could not open the Chats", () =>
								ChatStorageUnavailable.make({}),
							),
						)
					yield* ownChat(chats, chat)
					return chats
				})
			return handlers
				.handle("list", ({ params }) =>
					Effect.flatMap(chatsFor(params.chatId), (chats) =>
						chats.operations.list(params.chatId),
					),
				)
				.handle("get", ({ params }) =>
					Effect.flatMap(chatsFor(params.chatId), (chats) =>
						chats.operations
							.get(params.chatId, params.id)
							.pipe(Effect.catchTag("OperationNotFound", notFound)),
					),
				)
				.handle("cancel", ({ params }) =>
					Effect.flatMap(chatsFor(params.chatId), (chats) =>
						chats.operations
							.cancel(params.chatId, params.id)
							.pipe(Effect.catchTag("OperationNotFound", notFound)),
					),
				)
		}),
)
