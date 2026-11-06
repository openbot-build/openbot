import { Cause, Effect } from "effect"

/** Logs the failure of work that may fail. An interruption is not a failure, so it logs nothing. */
export const logFailure =
	(message: string) =>
	(cause: Cause.Cause<unknown>): Effect.Effect<void> =>
		Cause.hasInterruptsOnly(cause)
			? Effect.void
			: Effect.logWarning(message, cause)
