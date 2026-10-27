import { Effect, Layer } from "effect"
import { Maintenance } from "./Maintenance.ts"

/** Start one saved timer. The shared engine owns all later checks and pauses. */
export const layer = Layer.effectDiscard(
	Effect.flatMap(Maintenance, (maintenance) => maintenance.bootstrap).pipe(
		Effect.orDie,
	),
)
