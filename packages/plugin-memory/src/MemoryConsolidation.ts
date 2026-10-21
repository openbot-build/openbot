import { Clock, Effect, Option } from "effect"
import type { Item } from "@openbot-build/core"
import type { LanguageModel } from "effect/ai"
import * as Memory from "./Memory.ts"

/**
 * Asks the model for changes from the Items that memory has not read yet.
 * The model call happens first. Then `update` applies the changes to the current state,
 * so a write that happened during the model call is not lost.
 * It returns None when there is nothing new to read.
 */
export const run = <A, E, R>(input: {
	readonly model: typeof Memory.MemoryModel.Service
	readonly policy: typeof Memory.MemoryPolicy.Service
	readonly state: Memory.State
	readonly history: ReadonlyArray<Item.Record>
	readonly update: (
		apply: (
			current: Memory.State,
		) => Effect.Effect<Memory.State, Memory.MemoryError>,
	) => Effect.Effect<A, E, R>
}): Effect.Effect<
	Option.Option<A>,
	E | Memory.MemoryError,
	R | LanguageModel.LanguageModel
> =>
	Effect.gen(function* () {
		const history = input.history.filter(
			(entry) => !input.state.processed.includes(entry.id),
		)
		if (history.length === 0) return Option.none()
		const extracted = yield* input.model.extract({
			state: input.state,
			history,
		})
		const now = yield* Clock.currentTimeMillis
		return Option.some(
			yield* input.update((current) =>
				input.policy.apply({
					state: current,
					history,
					changes: extracted.changes,
					now,
				}),
			),
		)
	})
