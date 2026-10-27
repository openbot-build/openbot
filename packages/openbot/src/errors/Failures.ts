import { Array as Arr, Cause, Context, Effect, Redacted } from "effect"
import type { LazyArg } from "effect/Function"

class Inside extends Context.Service<
	Inside,
	Redacted.Redacted<Cause.Cause<unknown>>
>()("@openbot-build/openbot/errors/Failures/Inside") {}
const inside = Symbol.for("@openbot-build/openbot/errors/Failures/inside")
class Operation extends Context.Service<Operation, string>()(
	"@openbot-build/openbot/errors/Failures/Operation",
) {}

/**
 * Keep the full cause until an outside boundary saves it. The field is private,
 * non-enumerable, and Redacted, so a public schema or log cannot expose it.
 */
const keep = <E>(
	error: E,
	cause: Cause.Cause<unknown>,
	operation: string,
): E => {
	if (
		(typeof error === "object" && error !== null) ||
		typeof error === "function"
	) {
		// Native Error objects need a private field to retain diagnostics across catchTag.
		Object.defineProperty(error, inside, {
			value: Redacted.make(
				Cause.annotate(cause, Context.make(Operation, operation)),
			),
			enumerable: false,
			configurable: true,
		})
	}
	return error
}

/** Change typed failures while keeping their full private cause for the boundary. */
export const map =
	<E, E2>(message: string, change: (error: E) => E2) =>
	<A, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E2, R> =>
		self.pipe(
			Effect.catchCause((cause) => {
				const mapped = Cause.map(cause, (original) => {
					const error = change(original)
					return Object.is(error, original)
						? error
						: keep(error, cause, message)
				})
				// Primitive failures have no field that can keep their private cause.
				const primitive = Arr.some(
					mapped.reasons,
					(reason) =>
						reason._tag === "Fail" &&
						(typeof reason.error !== "object" || reason.error === null) &&
						typeof reason.error !== "function",
				)
				return Effect.failCause(
					primitive
						? Cause.annotate(mapped, Context.make(Inside, Redacted.make(cause)))
						: mapped,
				)
			}),
		)

/**
 * Replace an inside failure with a typed public error. Its private cause is
 * saved by the HTTP or workflow boundary, not sent to the ordinary log.
 * Map a failure the caller can act on, such as a unique key conflict, first.
 */
export const replace =
	<E2>(message: string, error: LazyArg<E2>) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E2, R> =>
		self.pipe(map(message, (_original: E) => error()))

/** Replace typed failures with this tag. Keep all other reasons. */
export const replaceTag =
	<const K extends string, E2>(tag: K, message: string, error: LazyArg<E2>) =>
	<A, E extends { readonly _tag: string }, R>(self: Effect.Effect<A, E, R>) =>
		self.pipe(
			map(message, (failure: E): Exclude<E, { readonly _tag: K }> | E2 =>
				// The tag check removes this member of the union.
				failure._tag === tag
					? error()
					: (failure as Exclude<E, { readonly _tag: K }>),
			),
		)
