import type { Caller } from "@openbot-build/domain/Identity"
import { BotId } from "@openbot-build/domain/BotId"
import { Chat, ChatStoreRepository, Item, Store } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { Array as Arr, Effect, Option } from "effect"
import { Prompt } from "effect/ai"
import * as Db from "@openbot-build/server-database/Database"
import * as StoredChats from "@openbot-build/conversation-contract/chats/StoredChats"
import * as ChatHost from "@openbot-build/conversation-contract/chats/ChatHost"
import * as Todos from "@openbot-build/conversation-contract/work/Todos"
import * as ChatCommands from "@openbot-build/conversation-contract/chats/ChatCommands"
import * as ChatQueries from "@openbot-build/conversation-contract/chats/ChatQueries"
import { InputCommands } from "@openbot-build/conversation-contract/chats/InputCommands"
import { ownerKey } from "@openbot-build/apps-contract/apps/StoredConnections"

/** Makes an empty Chat without starting a model or tool. */
export const direct = (identity: Caller, bot: string) =>
	Effect.flatMap(ChatCommands.make, (commands) =>
		commands.direct(identity, BotId.make(bot)),
	)

/** Reads the private context to check that compaction changed saved input. */
export const contextPrompt = (identity: Caller, chat: Chat.Id) =>
	Effect.flatMap(ChatQueries.make, (queries) =>
		queries.get(identity, chat),
	).pipe(Effect.map(({ view }) => view.state.conversation.context.prompt))

/** Saves orphan Chat records to prove that reads need no Bot or model runtime. */
export const seedReadChats = (identity: Caller) =>
	Effect.gen(function* () {
		const db = yield* Db.make
		const definition = yield* Store.define({
			stores: {
				[ChatHost.chatHostId]: ChatHost.chatHostStore,
				...Todos.stores,
			},
			schemaVersion: "chat/1",
		})
		const store = yield* ChatStoreRepository.make({
			definition,
			persistence: StoredChats.persistence(db, ownerKey(identity)),
		})
		return yield* Effect.forEach(["first", "second"], (name) =>
			Effect.gen(function* () {
				const bot = BotId.make(name)
				const initial = yield* store.create({
					id: Chat.Id.make(name),
					business: {
						[ChatHost.chatHostId]: {
							bot,
							kind: "direct",
							chain: {
								organizationId: identity.organizationId,
								userId: identity.userId,
								bots: [bot],
								chats: [],
							},
						},
					},
				})
				yield* store.modifyEffect({
					chat: initial.chat.id,
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({
								append: Arr.map([1, 2, 3], (number) => ({
									id: Item.Id.make(`${name}-${number}`),
									content: Prompt.make(`Note ${number}`),
								})),
							}),
						] as const),
				})
				return initial.chat.id
			}),
		)
	}).pipe(Effect.scoped)

/** Sends a delayed computer result after the host has restarted. */
export const submitComputerNotice = (
	identity: Caller,
	bot: string,
	chat: Chat.Id,
) =>
	Effect.flatMap(InputCommands, (commands) =>
		commands.submit(
			ownerKey(identity),
			Execution.CommandKey.make("computer:session-1"),
			{
				chat,
				content: Prompt.make("The command ended."),
				queue: true,
				identity: {
					owner: {
						organizationId: identity.organizationId,
						userId: identity.userId,
					},
					actor: identity,
					botId: BotId.make(bot),
				},
				notice: { kind: "computer_session", ref: "session-1" },
			},
		),
	)
