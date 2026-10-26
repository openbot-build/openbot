import { Cause, Effect, type LogLevel, type Schedule, type Scope } from "effect"

export interface LogFailureOptions {
	/**
	 * The level of the log line. The default is `Warn`. Use `Debug` for a step
	 * that often fails for a reason that does no harm.
	 */
	readonly level?: LogLevel.Severity
}

/**
 * Logs a failure of `effect` with its cause, and goes on. An interruption is
 * not a failure, so it is not logged.
 */
export const logFailure =
	(message: string, options: LogFailureOptions = {}) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
		effect.pipe(
			Effect.asVoid,
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.void
					: Effect.logWithLevel(options.level ?? "Warn")(message, cause),
			),
		)

export interface RepeatOptions<Out, R> {
	/** When the next run starts. The first run starts at once. */
	readonly schedule: Schedule.Schedule<Out, unknown, never, R>
	/** The log message for a run that fails. The log also has the cause. */
	readonly message: string
}

/**
 * Runs `effect` again and again on a schedule, in a fiber that lives as long
 * as the current scope. A failed run is logged with its cause, and the next
 * run still comes. When the scope closes, the fiber stops, and the stop is not
 * logged. An interruption inside a run, such as of a child fiber, is not
 * logged either.
 */
export const repeat = <A, E, R, Out, ScheduleR>(
	effect: Effect.Effect<A, E, R>,
	options: RepeatOptions<Out, ScheduleR>,
): Effect.Effect<void, never, R | ScheduleR | Scope.Scope> =>
	effect.pipe(
		logFailure(options.message),
		Effect.repeat(options.schedule),
		Effect.forkScoped,
		Effect.asVoid,
	)
