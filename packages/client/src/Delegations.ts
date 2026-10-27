import { type DelegationsApi } from "@openbot-build/api"
import { type Execution } from "@openbot-build/domain"
import { Crypto, Effect, type PlatformError } from "effect"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

/** A cancel receipt starts resource release. Follow its execution to the end. */
export const cancel = Effect.fn("Delegations.cancel")(function* (
	delegationId: DelegationsApi.DelegationId,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.delegations.cancelDelegation({
				params: { delegationId },
				payload: { commandKey },
			}),
		commandKey,
	)
})
