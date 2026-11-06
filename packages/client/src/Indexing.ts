import type { IndexRequest } from "@openbot-build/domain/Developers"
import type { Execution } from "@openbot-build/domain"
import { Effect, type PlatformError } from "effect"
import { SecureRandom } from "effect/crypto"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

/** Ask for a public App check. Reuse send after a lost reply. */
export const request = Effect.fn("Indexing.request")(function* (
	cardUrl: string,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<IndexRequest, ClientError>,
	PlatformError.PlatformError,
	Client | SecureRandom.SecureRandom
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.developer.requestIndexing({ payload: { cardUrl, commandKey: key } }),
		commandKey,
	)
})
