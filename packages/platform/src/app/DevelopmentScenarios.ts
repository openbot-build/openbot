import { Context, Effect, Layer, Ref, Schema } from "effect"

export const Mode = Schema.Literals([
	"available",
	"authorization-expired",
	"requirements-changed",
	"cleanup-failure",
	"protocol-failure",
	"input-required",
	"result-unknown",
	"business-failure",
])
export type Mode = typeof Mode.Type
/** Only the explicit development assembly can use development controls. */
export class Scenarios extends Context.Service<
	Scenarios,
	{
		readonly mode: Effect.Effect<Mode>
		readonly set: (mode: Mode) => Effect.Effect<void>
	}
>()("@openbot-build/platform/app/DevelopmentScenarios/Scenarios") {}
export const layer = Layer.effect(
	Scenarios,
	Effect.map(Ref.make<Mode>("available"), (state) =>
		Scenarios.of({ mode: Ref.get(state), set: (mode) => Ref.set(state, mode) }),
	),
)
