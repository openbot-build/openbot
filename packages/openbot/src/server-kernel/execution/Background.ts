import { Cause, Effect, Redacted, type Schedule, type Scope } from "effect"
import * as Report from "../errors/Report.ts"

export interface RepeatOptions<Out, R> {
	/** When the next run starts. The first run starts at once. */
	readonly schedule: Schedule.Schedule<Out, unknown, never, R>
	/** A fixed message. Keep user data in the sealed failure cause. */
	readonly message: string
}

export interface Work {
	logFailure: (
		message: string,
	) => <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<void, never, R>
	repeat: <A, E, R, Out, ScheduleR>(
		effect: Effect.Effect<A, E, R>,
		options: RepeatOptions<Out, ScheduleR>,
	) => Effect.Effect<void, never, R | ScheduleR | Scope.Scope>
}

const using = (
	report: (message: string, cause: Cause.Cause<unknown>) => Effect.Effect<void>,
): Work => {
	/** Keep a failed step before going on. A plain interruption has no error record. */
	const logFailure =
		(message: string) =>
		<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
			effect.pipe(
				Effect.asVoid,
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause) ? Effect.void : report(message, cause),
				),
			)
	/** The scope owns each loop. A failed run is saved before the next run starts. */
	const repeat = <A, E, R, Out, ScheduleR>(
		effect: Effect.Effect<A, E, R>,
		options: RepeatOptions<Out, ScheduleR>,
	): Effect.Effect<void, never, R | ScheduleR | Scope.Scope> =>
		effect.pipe(
			logFailure(options.message),
			Effect.repeat(options.schedule),
			Effect.forkScoped,
			Effect.asVoid,
		)
	return { logFailure, repeat }
}

/** A service takes these functions at construction. Methods need no error store context. */
export const make = Effect.map(Report.make, (report) =>
	using((message, cause) => report(message, cause).pipe(Effect.asVoid)),
)

/** Only startup work before keys and storage exist may use a redacted cause. */
export const beforeStorage = using((message, cause) =>
	Effect.logError(message, Redacted.make(cause)),
)
