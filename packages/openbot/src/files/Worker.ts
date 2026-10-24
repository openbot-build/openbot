import { Duration, Effect, Layer, Schedule } from "effect"
import { Files } from "./Files.ts"

export interface Options {
	/** How often the garbage collector runs. The default is one minute. */
	readonly interval?: Duration.Input
}

/**
 * Deletes files that nobody completed, files that no Chat used for a time,
 * and files that people deleted. Each step is safe when many instances do it
 * at the same time.
 */
export const layer = (options: Options = {}) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const files = yield* Files
			yield* files.collect.pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("The file garbage collector failed", cause),
				),
				Effect.repeat(Schedule.spaced(options.interval ?? Duration.minutes(1))),
				Effect.forkScoped,
			)
		}),
	)
