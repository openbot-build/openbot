import type { PersonDecision } from "@openbot-build/domain/Requests"
import type { CapabilityRequestId } from "@openbot-build/domain/CapabilityRequestId"
import { type Execution } from "@openbot-build/domain"
import { Effect, type PlatformError } from "effect"
import { SecureRandom } from "effect/crypto"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

type Input = Omit<PersonDecision, "commandKey"> &
	Partial<Pick<PersonDecision, "commandKey">>

/** Prepare one decision. A retry sends the same key, revision and answer. */
export const decide = Effect.fn("Requests.decide")(function* (
	requestId: CapabilityRequestId,
	input: Input,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | SecureRandom.SecureRandom
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
