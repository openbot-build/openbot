import { Cause, Effect, Option } from "effect"
import type { LazyArg } from "effect/Function"

/**
 * Fails with a public error in place of an inside failure, for example when a
 * database error becomes `SsoUnavailable`. The public error goes to the
 * client, so it must not hold the inside failure. This logs the full cause of
 * the inside failure first, with the place where it happened, so the reason is
 * not lost. The request log then reports the public error at level Error, so
 * this log uses level Warn.
 *
 * Use it only for failures that the caller cannot act on. Map a failure that
 * means something else, such as a unique key violation, to its own error with
 * `Effect.catchTag` before this step, so this step sees the original cause.
 */
export const replace =
	<E2>(message: string, error: LazyArg<E2>) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E2, R> =>
		self.pipe(
			Effect.tapCauseIf(Cause.hasFails, (cause) =>
				Effect.logWarning(message, cause),
			),
			Effect.mapError(error),
		)

/**
 * Like `replace`, but only for the failure with the tag `tag`. Other failures
 * keep their meaning. Use it in place of `Effect.catchTag(tag, (error) =>
 * Effect.fail(error).pipe(replace(...)))`, because a new failure loses the
 * place where the first one happened.
 */
export const replaceTag =
	<const K extends string, E2>(tag: K, message: string, error: LazyArg<E2>) =>
	<A, E extends { readonly _tag: string }, R>(self: Effect.Effect<A, E, R>) =>
		self.pipe(
			// `catchTag` takes the first failure of the cause, so this checks the same one.
			Effect.tapCauseIf(
				(cause) =>
					Option.exists(
						Cause.findErrorOption(cause),
						(failure) => failure._tag === tag,
					),
				(cause) => Effect.logWarning(message, cause),
			),
			Effect.catchIf(
				(failure): failure is Extract<E, { readonly _tag: K }> =>
					failure._tag === tag,
				() => Effect.fail(error()),
			),
		)
