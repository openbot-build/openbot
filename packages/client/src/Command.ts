import { Execution } from "@openbot-build/domain"
import { Crypto, Effect, Schedule } from "effect"
import { HttpClientError } from "effect/http"

/** Keep this value when an application retries a command after a lost reply. */
export interface Command<A, E> {
	readonly commandKey: Execution.CommandKey
	readonly send: Effect.Effect<A, E>
}
export const prepare = Effect.fn("Command.prepare")(function* <A, E>(
	send: (key: Execution.CommandKey) => Effect.Effect<A, E>,
	supplied?: Execution.CommandKey,
) {
	const key =
		supplied ??
		Execution.CommandKey.make(yield* (yield* Crypto.Crypto).randomUUIDv4())
	return {
		commandKey: key,
		send: send(key).pipe(
			Effect.retry({
				times: 2,
				schedule: Schedule.exponential("100 millis"),
				while: (error) =>
					HttpClientError.isHttpClientError(error) &&
					error.reason._tag === "TransportError",
			}),
		),
	} satisfies Command<A, E>
})
