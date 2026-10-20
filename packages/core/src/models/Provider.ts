import { Data, Schema, type Effect } from "effect"
import type * as Config from "./Config.ts"
import type * as Model from "./Model.ts"

export const Id = Schema.String.pipe(
	Schema.brand("@openbot-build/core/ProviderId"),
)
export type Id = typeof Id.Type

/** The host builds executable models from configuration with its own provider integration. */
export class Provider<
	E = never,
	R = never,
	ModelR = never,
> extends Data.TaggedClass("Provider.Provider")<{
	readonly id: Id
	readonly model: (
		selection: Config.Selection,
	) => Effect.Effect<Model.Model<ModelR>, E, R>
}> {}
