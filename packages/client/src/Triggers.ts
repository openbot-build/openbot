import type { TriggerId } from "@openbot-build/domain/TriggerId"
import type { DelegationId } from "@openbot-build/domain/DelegationId"
import { type Execution } from "@openbot-build/domain"
import { Effect, type PlatformError, Redacted, type Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

/** Keep one key and body when a webhook reply is lost. */
export const fire = Effect.fn("Triggers.fire")(function* (
	id: TriggerId,
	input: {
		readonly secret: Redacted.Redacted<string>
		readonly data: Schema.Json
		readonly commandKey?: Execution.CommandKey
	},
): Effect.fn.Return<
	Command<
		Execution.Receipt & { readonly delegation: DelegationId },
		ClientError
	>,
	PlatformError.PlatformError,
	Client | SecureRandom.SecureRandom
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.triggerHooks.fireTrigger({
				params: { triggerId: id },
				headers: {
					authorization: "Bearer " + Redacted.value(input.secret),
					"idempotency-key": commandKey,
				},
				payload: input.data,
			}),
		input.commandKey,
	)
})
