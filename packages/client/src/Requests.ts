import { type Execution } from "@openbot-build/domain"
import { type RequestsApi } from "@openbot-build/api"
import { Crypto, Effect, type PlatformError } from "effect"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

type Input = Omit<RequestsApi.ResolveRequest, "commandKey"> &
	Partial<Pick<RequestsApi.ResolveRequest, "commandKey">>

/** Prepare one decision. A retry sends the same key, revision and answer. */
export const decide = Effect.fn("Requests.decide")(function* (
	requestId: RequestsApi.CapabilityRequestId,
	input: Input,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.requests.resolveRequest({
				params: { requestId },
				payload: { ...input, commandKey },
			}),
		input.commandKey,
	)
})
