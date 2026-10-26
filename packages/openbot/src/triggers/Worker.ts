import { Duration, Effect, Layer, Schedule } from "effect"
import * as Background from "../app/Background.ts"
import * as Fire from "./Fire.ts"
import { Triggers } from "./Triggers.ts"

export interface Options {
	/** How often the worker looks for triggers whose schedule is due. The default is 15 seconds. */
	readonly interval?: Duration.Input
}

/** Fires the triggers whose schedule is due. Each one fires once, also with many instances. */
export const layer = (options: Options = {}) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const triggers = yield* Triggers
			const fire = yield* Fire.make
			yield* Background.repeat(
				triggers.due.pipe(
					Effect.flatMap((due) =>
						Effect.forEach(
							due,
							(entry) =>
								fire(entry).pipe(
									Background.logFailure("A scheduled trigger could not fire"),
									Effect.annotateLogs({
										trigger: entry.trigger.id,
										organization: entry.organizationId,
									}),
								),
							{ discard: true },
						),
					),
				),
				{
					schedule: Schedule.spaced(options.interval ?? Duration.seconds(15)),
					message: "The trigger worker failed",
				},
			)
		}),
	)
