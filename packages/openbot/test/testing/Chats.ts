import { Chat, ChatStoreRepository, Item, Store } from "@openbot-build/core"
import { BotId, Execution, type Caller } from "@openbot-build/domain"
import { Array as Arr, Effect, Option } from "effect"
import { Prompt } from "effect/ai"
import * as Db from "../../src/database/Database.ts"
import * as StoredChats from "../../src/chats/StoredChats.ts"
import * as ChatHost from "../../src/chats/ChatHost.ts"
import * as Todos from "../../src/plugins/work/Todos.ts"
import * as ChatCommands from "../../src/chats/ChatCommands.ts"
import * as ChatQueries from "../../src/chats/ChatQueries.ts"
import { InputCommands } from "../../src/chats/InputCommands.ts"
import { ownerKey } from "../../src/apps/StoredConnections.ts"

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
