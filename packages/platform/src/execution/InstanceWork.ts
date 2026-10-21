import { Context, Data, Effect, Layer, Option } from "effect"

export class InstancePaused extends Data.TaggedError("InstancePaused")<{}> {}
const CurrentTask = Context.Reference<symbol | undefined>(
	"platform/execution/CurrentInstanceTask",
	{ defaultValue: () => undefined },
)

/** Counts complete process-local work, including gaps before an account lease exists. */
export class InstanceWork extends Context.Service<
	InstanceWork,
	{
		readonly wrap: <A, E, R>(
			effect: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E | InstancePaused, R>
		readonly admitted: Effect.Effect<boolean>
		readonly quiesce: Effect.Effect<void>
		readonly resume: Effect.Effect<void>
		readonly status: Effect.Effect<{
			readonly quiesced: boolean
			readonly activeTasks: number
		}>
	}
>()("@openbot-build/platform/execution/InstanceWork") {}

export const make = Effect.sync(() => {
	let quiesced = false
	const active = new Set<symbol>()
	return InstanceWork.of({
		admitted: Effect.map(
			CurrentTask,
			(token) => token !== undefined && active.has(token),
		),
		wrap: (effect) =>
			Effect.acquireUseRelease(
				Effect.flatMap(CurrentTask, (parent) =>
					Effect.suspend(() => {
						// Work admitted before quiescence may finish its nested writes. Each
						// nested task owns a count, so it cannot outlive a released parent unnoticed.
						if (quiesced && (parent === undefined || !active.has(parent)))
							return Effect.fail(new InstancePaused())
						const token = Symbol()
						active.add(token)
						return Effect.succeed(token)
					}),
				),
				(token) =>
					effect.pipe(
						Effect.uninterruptible,
						Effect.provideService(CurrentTask, token),
					),
				(token) =>
					Effect.sync(() => {
						active.delete(token)
					}),
			),
		quiesce: Effect.sync(() => {
			quiesced = true
		}),
		resume: Effect.sync(() => {
			quiesced = false
		}),
		status: Effect.sync(() => ({ quiesced, activeTasks: active.size })),
	})
})
export const layer = Layer.effect(InstanceWork, make)

/** Optional only for stand-alone services/tests; production Platform always installs the gate. */
export const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.flatMap(Effect.serviceOption(InstanceWork), (gate) =>
		Option.isSome(gate) ? gate.value.wrap(effect) : effect,
	)

/** True only inside a still-counted task, never for an inherited released token. */
export const admitted = Effect.flatMap(
	Effect.serviceOption(InstanceWork),
	(gate) => (Option.isSome(gate) ? gate.value.admitted : Effect.succeed(false)),
)
