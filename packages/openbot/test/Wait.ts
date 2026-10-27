import {
	type Duration,
	Effect,
	Option,
	type Predicate,
	Schedule,
	Schema,
} from "effect"

/** Something that the test waits for did not happen in time. */
export class TimedOut extends Schema.TaggedError<
	TimedOut,
	{ readonly brand: unique symbol }
>()("TimedOut", { label: Schema.String }) {
	override get message() {
		return "Timed out: " + this.label
	}
}

/** How a wait checks again. */
export interface Options {
	/** The time between two checks. The default is 25 milliseconds. */
	readonly spacing?: Duration.Input
	/** How many times the wait checks again after the first check. The default is 600. */
	readonly times?: number
}

const repeatUntil = <A>(done: Predicate.Predicate<A>, options?: Options) => ({
	until: done,
	schedule: Schedule.spaced(options?.spacing ?? "25 millis"),
	times: options?.times ?? 600,
})

/**
 * Runs a check again and again until it gives a value. When it gives no value
 * after the last try, the wait fails with `TimedOut`.
 */
export const until = <A, E, R>(
	label: string,
	check: Effect.Effect<Option.Option<A>, E, R>,
	options?: Options,
) =>
	check.pipe(
		Effect.repeat(repeatUntil(Option.isSome<A>, options)),
		Effect.flatMap(Effect.fromOption(() => TimedOut.make({ label }))),
	)

/**
 * Reads a value again and again until `done` takes it, and gives that value.
 * When `done` does not take the value of the last try, the wait fails with
 * `TimedOut`.
 */
export const untilTrue = <A, E, R>(
	label: string,
	read: Effect.Effect<A, E, R>,
	done: Predicate.Predicate<A>,
	options?: Options,
) =>
	read.pipe(
		Effect.repeat(repeatUntil(done, options)),
		Effect.filterOrFail(done, () => TimedOut.make({ label })),
	)
