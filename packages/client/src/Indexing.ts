import type { DeveloperApi } from "@openbot-build/api"
import type { Execution } from "@openbot-build/domain"
import { Crypto, Effect, type PlatformError } from "effect"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

/** Ask for a public App check. Reuse send after a lost reply. */
export const request = Effect.fn("Indexing.request")(function* (
	cardUrl: string,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<DeveloperApi.IndexRequest, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.developer.requestIndexing({ payload: { cardUrl, commandKey: key } }),
		commandKey,
	)
})
