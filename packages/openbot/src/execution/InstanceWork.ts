import { Context, Data, Effect, Layer, Option } from "effect"

export class InstancePaused extends Data.TaggedError("InstancePaused")<{}> {}
export const CurrentTask = Context.Reference<symbol | undefined>(
	"platform/execution/CurrentInstanceTask",
	{ defaultValue: () => undefined },
)

/** A task reserved before it enters a background queue. */
export interface Reservation {
	readonly context: Context.Context<never>
	readonly run: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | InstancePaused, R>
	readonly release: Effect.Effect<void>
}

/** Counts complete process-local work, including gaps before an account lease exists. */
export class InstanceWork extends Context.Service<
	InstanceWork,
	{
		readonly wrap: <A, E, R>(
			effect: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E | InstancePaused, R>
		readonly reserve: Effect.Effect<Reservation, InstancePaused>
		readonly admitted: Effect.Effect<boolean>
		/** Temporarily pause admission without clearing an operator pause on release. */
		readonly pause: Effect.Effect<Effect.Effect<void>>
		readonly quiesce: Effect.Effect<void>
		readonly resume: Effect.Effect<void>
		readonly status: Effect.Effect<{
			readonly quiesced: boolean
			readonly activeTasks: number
		}>
	}
>()("@openbot-build/openbot/execution/InstanceWork") {}

export const make = Effect.sync(() => {
	let quiesced = false
	const pauses = new Set<symbol>()
	const active = new Set<symbol>()
	const reserve: Effect.Effect<Reservation, InstancePaused> = Effect.flatMap(
		CurrentTask,
		(parent) =>
			Effect.suspend(() => {
				// A counted parent can enqueue its final work after admission has paused.
				if (
					(quiesced || pauses.size > 0) &&
					(parent === undefined || !active.has(parent))
				)
					return Effect.fail(new InstancePaused())
				const token = Symbol()
				active.add(token)
				const release = Effect.sync(() => {
					active.delete(token)
				})
				return Effect.succeed({
					context: Context.make(CurrentTask, token),
					release,
					run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
						Effect.suspend<A, E | InstancePaused, R>(() =>
							active.has(token)
								? effect.pipe(
										Effect.provideService(CurrentTask, token),
										Effect.ensuring(release),
									)
								: Effect.fail(new InstancePaused()),
						),
				})
			}),
	)
	return InstanceWork.of({
		admitted: Effect.map(
			CurrentTask,
			(token) => token !== undefined && active.has(token),
		),
		reserve,
		wrap: (effect) =>
			Effect.acquireUseRelease(
				reserve,
				(task) => task.run(effect),
				(task) => task.release,
			),
		pause: Effect.sync(() => {
			const token = Symbol()
			pauses.add(token)
			return Effect.sync(() => {
				pauses.delete(token)
			})
		}),
		quiesce: Effect.sync(() => {
			quiesced = true
		}),
		resume: Effect.sync(() => {
			quiesced = false
		}),
		status: Effect.sync(() => ({
			quiesced: quiesced || pauses.size > 0,
			activeTasks: active.size,
		})),
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

/** Reserve before publishing work; the consumer runs or releases the reservation. */
export const reserve: Effect.Effect<Reservation, InstancePaused> =
	Effect.flatMap(Effect.serviceOption(InstanceWork), (gate) =>
		Option.isSome(gate)
			? gate.value.reserve
			: Effect.succeed({
					context: Context.empty(),
					run: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
					release: Effect.void,
				}),
	)
