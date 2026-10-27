import { type AppCalls, type Execution } from "@openbot-build/domain"
import { Crypto, Effect, type PlatformError, type Schema } from "effect"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

/** Keep one key for the input answer, including network retries. */
export const respond = Effect.fn("AppCalls.respond")(function* (
	id: AppCalls.AppOperationId,
	input: {
		readonly round: number
		readonly responses: Schema.JsonObject
		readonly commandKey?: Execution.CommandKey
	},
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.appOperations.respond({
				params: { id },
				payload: { ...input, commandKey },
			}),
		input.commandKey,
	)
})
