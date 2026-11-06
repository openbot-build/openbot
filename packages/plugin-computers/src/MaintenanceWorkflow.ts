import { Clock, Effect, Layer, Schema } from "effect"
import { DurableClock } from "effect/workflow"
import { Calls } from "@openbot-build/server-execution/Calls"
import * as Engine from "@openbot-build/server-execution/Engine"
import { Policy, Workflows } from "@openbot-build/server-execution/Workflows"
import * as Program from "@openbot-build/server-execution/Program"
import { Store } from "@openbot-build/server-execution/Store"
import { pauseWorkflowName } from "./Activity.ts"
import { Maintenance, serviceId, sweepWorkflowName } from "./Maintenance.ts"

export const sweep = Engine.define(sweepWorkflowName)
export const pause = Engine.define(pauseWorkflowName)
/** Adds both workflows and their access rules. When the scope closes, they go. */
export const contribute = Effect.gen(function* () {
	const maintenance = yield* Maintenance
	const workflows = yield* Workflows
	const store = yield* Store
	const calls = yield* Calls
	const run = yield* Program.make
	yield* workflows.contribute({
		workflow: sweep,
		plugin: "computers",
		journal: 1,
		policy: Policy.Service({
			serviceId,
			authorize: (key) => maintenance.loadSweep(key).pipe(Effect.asVoid),
		}),
		run: (key) =>
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
	})
	yield* workflows.contribute({
		workflow: pause,
		plugin: "computers",
		journal: 1,
		policy: Policy.Service({
			serviceId,
			authorize: maintenance.authorizePause,
			publicRead: maintenance.publicAccess,
			publicDecision: {
				authorize: maintenance.publicAccess,
				decide: maintenance.decide,
			},
		}),
		run: (key) =>
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
	})
})

export const layer = Layer.effectDiscard(contribute)
