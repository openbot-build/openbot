import { Clock, Data, Effect, HashMap, Option } from "effect"

export class CapacityExceeded extends Data.TaggedError(
	"CapacityExceeded",
)<{}> {}

export interface Temporary<A> {
	readonly get: (key: string) => Effect.Effect<Option.Option<A>>
	readonly put: (key: string, value: A) => Effect.Effect<void, CapacityExceeded>
	readonly take: (key: string) => Effect.Effect<Option.Option<A>>
	readonly remove: (key: string) => Effect.Effect<void>
}

/** The caller's runtime owns the state. Expired entries are removed on access. */
export const make =
	<A>(ttl: number) =>
	(capacity = 2048): Temporary<A> => {
		let entries = HashMap.empty<
			string,
			{ readonly value: A; readonly expiresAt: number }
		>()
		const get = Effect.fn(function* (key: string) {
			const now = yield* Clock.currentTimeMillis
			const entry = Option.getOrUndefined(HashMap.get(entries, key))
			if (entry === undefined) return Option.none<A>()
			if (entry.expiresAt <= now) {
				entries = HashMap.remove(entries, key)
				return Option.none<A>()
			}
			return Option.some(entry.value)
		})
		return {
			get,
			put: Effect.fn(function* (key, value) {
				const now = yield* Clock.currentTimeMillis
				entries = HashMap.filter(entries, (entry) => entry.expiresAt > now)
				if (!HashMap.has(entries, key) && HashMap.size(entries) >= capacity)
					return yield* new CapacityExceeded()
				entries = HashMap.set(entries, key, { value, expiresAt: now + ttl })
			}),
			take: Effect.fn(function* (key) {
				const found = yield* get(key)
				entries = HashMap.remove(entries, key)
				return found
			}),
			remove: (key) =>
				Effect.sync(() => {
					entries = HashMap.remove(entries, key)
				}),
		}
	}
