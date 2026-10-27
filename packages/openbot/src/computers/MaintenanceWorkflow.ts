import { Clock, Effect, Layer, Schema } from "effect"
import { DurableClock } from "effect/workflow"
import { Calls } from "../execution/Calls.ts"
import * as Engine from "../execution/Engine.ts"
import * as Program from "../execution/Program.ts"
import { Store } from "../execution/Store.ts"
import { pauseWorkflowName } from "./Activity.ts"
import { Maintenance, serviceId, sweepWorkflowName } from "./Maintenance.ts"

export const sweep = Engine.define(sweepWorkflowName)
export const pause = Engine.define(pauseWorkflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const maintenance = yield* Maintenance
		const registry = yield* Engine.Registry
		const store = yield* Store
		const calls = yield* Calls
		const run = yield* Program.make
		const sweeps = sweep.toLayer((key) =>
			run(
				key,
				(fence) =>
					Effect.gen(function* () {
						const input = yield* maintenance.loadSweep(fence)
						const delay = input.due - (yield* Clock.currentTimeMillis)
						if (delay > 0) {
							if ((yield* store.get(fence)).status !== "waiting")
								yield* store.commit(fence, { status: "waiting" }, Effect.void)
							yield* DurableClock.sleep({
								name: "idle-check",
								duration: delay,
								inMemoryThreshold: 0,
							})
							yield* store.commit(fence, { status: "running" }, Effect.void)
						}
						yield* maintenance.sweep(fence)
					}),
				maintenance.finishSweep,
			),
		)
		const pauses = pause.toLayer((key) =>
			run(
				key,
				(fence) =>
					Effect.gen(function* () {
						const attempt = yield* store.writeAttempt(fence, "pause", {
							computer: (yield* maintenance.loadPause(fence)).input.computerId,
						})
						const prepare = yield* Effect.cached(maintenance.prepare(fence))
						const result = yield* calls.invoke(
							fence,
							attempt,
							() =>
								Effect.gen(function* () {
									const machine = yield* prepare
									if (machine.pausable === undefined) return { paused: false }
									yield* machine.pausable.pause
									return { paused: true }
								}),
							Effect.asVoid(prepare),
						)
						if (result._tag === "Completed") {
							const { paused } = yield* Schema.decodeUnknownEffect(
								Schema.Struct({ paused: Schema.Boolean }),
							)(result.result)
							yield* maintenance.complete(fence, paused)
						}
					}),
				maintenance.finish,
			),
		)
		return Layer.merge(sweeps, pauses).pipe(
			Layer.provideMerge(
				Layer.effectDiscard(
					Effect.gen(function* () {
						yield* registry.registerService(sweep, serviceId, (key) =>
							maintenance.loadSweep(key).pipe(Effect.asVoid),
						)
						yield* registry.registerService(
							pause,
							serviceId,
							maintenance.authorizePause,
							undefined,
							maintenance.publicAccess,
							{
								authorize: maintenance.publicAccess,
								decide: maintenance.decide,
							},
						)
					}),
				),
			),
		)
	}),
)
