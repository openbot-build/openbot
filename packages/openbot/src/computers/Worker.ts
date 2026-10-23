import { Clock, Duration, Effect, Layer, Schedule } from "effect"
import { Computers } from "./Computers.ts"
import { removeOld } from "./connector/Connectors.ts"
import { Pairings } from "./Pairings.ts"

export interface Options {
	/** How often the worker runs. The default is one minute. */
	readonly interval?: Duration.Input
}

/**
 * Pauses idle Computers, and removes old pairings, old calls and the rights of
 * archived Agents. Each step is safe when many instances do it at the same time.
 */
export const layer = (options: Options = {}) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const computers = yield* Computers
			const pairings = yield* Pairings
			const context =
				yield* Effect.context<Effect.Services<ReturnType<typeof removeOld>>>()
			yield* Effect.gen(function* () {
				yield* computers.pauseIdle
				yield* pairings.removeOld
				yield* computers.forgetArchived
				const now = yield* Clock.currentTimeMillis
				yield* removeOld(now - Duration.toMillis(Duration.minutes(10))).pipe(
					Effect.provideContext(context),
					Effect.ignore,
				)
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("The Computer worker failed", cause),
				),
				Effect.repeat(Schedule.spaced(options.interval ?? Duration.minutes(1))),
				Effect.forkScoped,
			)
		}),
	)
