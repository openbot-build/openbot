import type { BotId } from "@openbot-build/domain/BotId"
import type { Execution } from "@openbot-build/domain"
import { type ChatsApi } from "@openbot-build/api"
import { Effect, type PlatformError } from "effect"
import { SecureRandom } from "effect/crypto"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

type Input = Omit<ChatsApi.ChatCommandRequest, "commandKey"> &
	Partial<Pick<ChatsApi.ChatCommandRequest, "commandKey">>

/** Make a message command. Reuse send after a lost reply. Observe its execution for output. */
export const message = Effect.fn("Chats.message")(function* (
	chatId: ChatsApi.ChatCommandReceipt["chat"],
	input: Input,
): Effect.fn.Return<
	Command<ChatsApi.ChatCommandReceipt, ClientError>,
	PlatformError.PlatformError,
	Client | SecureRandom.SecureRandom
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.chats.sendMessage({
				params: { chatId },
				payload: { ...input, commandKey },
			}),
		input.commandKey,
	)
})

/** Send to the direct Chat with a Bot. All retries keep the same command key. */
export const botMessage = Effect.fn("Chats.botMessage")(function* (
	botId: BotId,
	input: Input,
): Effect.fn.Return<
	Command<ChatsApi.ChatCommandReceipt, ClientError>,
	PlatformError.PlatformError,
	Client | SecureRandom.SecureRandom
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.chats.sendBotMessage({
				params: { botId },
				payload: { ...input, commandKey },
			}),
		input.commandKey,
	)
})

/** Stop work and observe the receipt until its resources have been released. */
export const interrupt = Effect.fn("Chats.interrupt")(function* (
	chatId: ChatsApi.ChatCommandReceipt["chat"],
	input: {
		readonly commandKey?: Execution.CommandKey
		readonly delegations?: boolean
	} = {},
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | SecureRandom.SecureRandom
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.chats.interruptChat({
				params: { chatId },
				payload: { ...input, commandKey },
			}),
		input.commandKey,
	)
})

/** Delete a Chat after its work has ended. A retry returns the same receipt. */
export const remove = Effect.fn("Chats.remove")(function* (
	chatId: ChatsApi.ChatCommandReceipt["chat"],
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | SecureRandom.SecureRandom
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.chats.deleteChat({
				params: { chatId },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})
