import { Duration, Effect, Layer, Schedule } from "effect"
import { fire } from "./Fire.ts"
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
			const context =
				yield* Effect.context<Effect.Services<ReturnType<typeof fire>>>()
			yield* triggers.due.pipe(
				Effect.flatMap((due) =>
					Effect.forEach(
						due,
						(entry) =>
							fire(entry).pipe(
								Effect.catchCause((cause) =>
									Effect.logWarning(
										"A scheduled trigger could not fire",
										cause,
									),
								),
							),
						{ discard: true },
					),
				),
				Effect.provideContext(context),
				Effect.catchCause((cause) =>
					Effect.logWarning("The trigger worker failed", cause),
				),
				Effect.repeat(
					Schedule.spaced(options.interval ?? Duration.seconds(15)),
				),
				Effect.forkScoped,
			)
		}),
	)
