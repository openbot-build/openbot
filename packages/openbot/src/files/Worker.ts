import { Duration, Effect, Layer, Schedule } from "effect"
import * as Background from "../app/Background.ts"
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
			yield* Background.repeat(files.collect, {
				schedule: Schedule.spaced(options.interval ?? Duration.minutes(1)),
				message: "The file garbage collector failed",
			})
		}),
	)
