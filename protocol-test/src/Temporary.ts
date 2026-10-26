import { Clock, Duration, Effect, HashMap, Option, Ref, Schema } from "effect"

export class CapacityExceeded extends Schema.TaggedError<
	CapacityExceeded,
	{ readonly brand: unique symbol }
>()("CapacityExceeded", {}) {}

export interface Temporary<A> {
	readonly get: (key: string) => Effect.Effect<Option.Option<A>>
	readonly put: (key: string, value: A) => Effect.Effect<void, CapacityExceeded>
	readonly take: (key: string) => Effect.Effect<Option.Option<A>>
	readonly remove: (key: string) => Effect.Effect<void>
}

interface Entry<A> {
	readonly value: A
	readonly expiresAt: number
}

/** The default number of entries in one store. */
export const capacity = 2048

/**
 * Many request fibers use one store at the same time. Each step that reads and
 * then changes the entries is one atomic `Ref.modify`, so `take` gives an entry
 * to one caller only. Expired entries are removed on access.
 */
export const make = <A>(
	ttl: Duration.Input,
	max = capacity,
): Effect.Effect<Temporary<A>> =>
	Effect.map(Ref.make(HashMap.empty<string, Entry<A>>()), (ref) => {
		const ttlMillis = Duration.toMillis(ttl)
		return {
			get: (key) =>
				Effect.flatMap(Clock.currentTimeMillis, (now) =>
					Ref.modify(ref, (entries) => {
						const entry = HashMap.get(entries, key)
						return Option.isSome(entry) && entry.value.expiresAt <= now
							? [Option.none<A>(), HashMap.remove(entries, key)]
							: [Option.map(entry, (found) => found.value), entries]
					}),
				),
			put: Effect.fn(function* (key, value) {
				const now = yield* Clock.currentTimeMillis
				const stored = yield* Ref.modify(ref, (entries) => {
					const live = HashMap.filter(entries, (entry) => entry.expiresAt > now)
					return !HashMap.has(live, key) && HashMap.size(live) >= max
						? ([false, live] as const)
						: ([
								true,
								HashMap.set(live, key, { value, expiresAt: now + ttlMillis }),
							] as const)
				})
				if (!stored) return yield* CapacityExceeded.make({})
			}),
			take: (key) =>
				Effect.flatMap(Clock.currentTimeMillis, (now) =>
					Ref.modify(ref, (entries) => [
						HashMap.get(entries, key).pipe(
							Option.filter((entry) => entry.expiresAt > now),
							Option.map((entry) => entry.value),
						),
						HashMap.remove(entries, key),
					]),
				),
			remove: (key) => Ref.update(ref, HashMap.remove(key)),
		}
	})
