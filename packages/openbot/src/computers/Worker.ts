import { Clock, Duration, Effect, Layer, Schedule } from "effect"
import * as Background from "../app/Background.ts"
import { Computers } from "./Computers.ts"
import { Connectors } from "./connector/Connectors.ts"
import { Pairings } from "./Pairings.ts"

export interface Options {
	/** How often the worker runs. The default is one minute. */
	readonly interval?: Duration.Input
}

/**
 * Pauses idle Computers, and removes old pairings, old calls and the rights of
 * archived Bots. Each step is safe when many instances do it at the same time.
 */
export const layer = (options: Options = {}) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const computers = yield* Computers
			const pairings = yield* Pairings
			const connectors = yield* Connectors
			yield* Background.repeat(
				Effect.gen(function* () {
					yield* computers.pauseIdle
					yield* pairings.removeOld
					yield* computers.forgetArchived
					const now = yield* Clock.currentTimeMillis
					yield* connectors.removeOld(
						now - Duration.toMillis(Duration.minutes(10)),
					)
				}),
				{
					schedule: Schedule.spaced(options.interval ?? Duration.minutes(1)),
					message: "The Computer worker failed",
				},
			)
		}),
	)
