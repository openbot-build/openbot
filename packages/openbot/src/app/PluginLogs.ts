import {
	Array as Arr,
	Cause,
	Effect,
	Fiber,
	Layer,
	Logger,
	Queue,
	Redacted,
	Record as Rec,
	References,
	String as Str,
} from "effect"
import * as Report from "@openbot-build/server-kernel/errors/Report"
import * as Background from "@openbot-build/server-kernel/execution/Background"

/**
 * graft and its loader log the full cause of a plugin failure, and a log line
 * must carry only the id of an error record. These notes mark the lines that
 * come from graft or from a plugin fork.
 */
const fromPlugins = (annotations: Readonly<Record<string, unknown>>) =>
	Arr.some(
		Rec.keys(annotations),
		(key) =>
			key === "graft.fork" ||
			key === "graft.plugin" ||
			Str.startsWith("loader.")(key),
	)

/** A log line whose cause the logger took out. */
export interface Hidden {
	readonly message: ReadonlyArray<unknown>
	readonly cause: Cause.Cause<unknown>
	readonly annotations: Readonly<Record<string, unknown>>
}

/**
 * Takes a hidden cause. It gives `false` when it cannot keep the cause, and
 * the line then keeps its cause.
 */
export type Keep = (hidden: Hidden) => boolean

/**
 * Wraps one logger. A line from a plugin fork with a cause gets the cause as a
 * `Redacted` value at the end of its message, and no cause of its own. A
 * logger then prints `<redacted>` in place of the cause, and `keep` puts the
 * full cause in the error records.
 */
export const redact = <Output>(
	logger: Logger.Logger<unknown, Output>,
	keep: Keep,
): Logger.Logger<unknown, Output> =>
	Logger.make((options) => {
		const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
		if (options.cause.reasons.length === 0 || !fromPlugins(annotations))
			return logger.log(options)
		const message = Arr.isArray(options.message)
			? options.message
			: [options.message]
		if (!keep({ message, cause: options.cause, annotations }))
			return logger.log(options)
		return logger.log({
			...options,
			cause: Cause.empty,
			message: [...message, Redacted.make(options.cause)],
		})
	})

/**
 * graft writes these lines when a fork fails, and the fork then has the cause
 * in its `Failed` state: the supervisor failed, or the plugin itself stopped
 * with a failure. `PluginFailures` saves that cause one time for each failed
 * period, so these lines do not get a record of their own. Without this, a
 * fork that tries again and again would get a record for each try. Every
 * other hidden cause, such as a failed release or a failed loader step, gets
 * its own record.
 */
const savedByFailures = (hidden: Hidden) =>
	Rec.has(hidden.annotations, "graft.fork") &&
	(hidden.message[0] === "The plugin supervisor failed" ||
		hidden.message[0] ===
			`Plugin "${String(hidden.annotations["graft.plugin"])}" failed`)

/**
 * Puts `redact` around every logger of the context it is built in. Build
 * graft on top of it, so graft adds its own logger to the wrapped ones.
 *
 * A logger cannot run an effect, so it puts each hidden cause in a queue. A
 * fiber of this layer saves each one in the error records, and logs the
 * record id with the notes of the first line. Its line has no cause, so it
 * does not come back here. When the layer closes, the fiber saves what is
 * still in the queue; after that, a line keeps its cause.
 */
export const layer = Layer.effect(
	Logger.CurrentLoggers,
	Effect.gen(function* () {
		const report = yield* Report.make
		const hidden = yield* Queue.unbounded<Hidden, Cause.Done>()
		const save = (line: Hidden) =>
			Effect.gen(function* () {
				const failure = yield* report(
					`plugin log: ${String(line.message[0])}`,
					line.cause,
				)
				yield* Effect.logError(
					"A plugin log line had a failure. Its cause is in the error record.",
				).pipe(
					Effect.annotateLogs({
						...line.annotations,
						errorId: failure.errorId,
					}),
				)
			}).pipe(
				Effect.catchCause((cause) =>
					Background.beforeStorage.logFailure(
						"A plugin failure in the log could not be saved.",
					)(Effect.failCause(cause)),
				),
			)
		const drain = yield* Queue.take(hidden).pipe(
			Effect.flatMap(save),
			Effect.forever,
			Effect.catchTag("Done", () => Effect.void),
			Effect.forkScoped,
		)
		// Close the queue, then wait until the fiber saved what was in it.
		yield* Effect.addFinalizer(() =>
			Queue.end(hidden).pipe(Effect.andThen(Fiber.await(drain))),
		)
		const keep: Keep = (line) =>
			savedByFailures(line) || Queue.offerUnsafe(hidden, line)
		const loggers = yield* Logger.CurrentLoggers
		// The logger API takes a mutable Set. Nothing changes it after this.
		return new Set(
			Arr.map(Arr.fromIterable(loggers), (logger) => redact(logger, keep)),
		)
	}),
)
