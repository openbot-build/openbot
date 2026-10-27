import type { Execution } from "@openbot-build/domain"
import { Crypto, Effect, type PlatformError } from "effect"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

/** Keep the returned command to retry a check after a lost reply. */
export const verifyClaim = Effect.fn("Proofs.verifyClaim")(function* (
	id: string,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.developer.verifyClaim({
				params: { id },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})
export const verifyProof = Effect.fn("Proofs.verifyProof")(function* (
	id: string,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.developer.verifyProof({
				params: { id },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})
