import { Clock, Effect, Layer, Option, Schema, Stream } from "effect"
import { DurableClock, DurableDeferred } from "effect/workflow"
import * as Engine from "@openbot-build/server-execution/execution/Engine"
import {
	Policy,
	Workflows,
} from "@openbot-build/server-execution/execution/Workflows"
import * as Program from "@openbot-build/server-execution/execution/Program"
import { Observation } from "@openbot-build/server-execution/execution/Observation"
import {
	Store,
	type Fence,
} from "@openbot-build/server-execution/execution/Store"
import { TestCommands } from "./TestCommands.ts"
import { TestCleanup, serviceId, signal, workflowName } from "./TestCleanup.ts"

export const workflow = Engine.define(workflowName)
export const make = Effect.gen(function* () {
	const clock = yield* Clock.Clock
	const cleanup = yield* TestCleanup
	const commands = yield* TestCommands
	const observation = yield* Observation
	const store = yield* Store
	const run = yield* Program.make
	const work = (fence: Fence) =>
		Effect.gen(function* () {
			while (true) {
				const state = yield* cleanup.current(fence)
				if (state.record.value.cleanup === "Pending") break
				const due = Math.min(
					state.record.value.expiresAt,
					state.record.value.createdAt + (state.revision + 1) * 60000,
				)
				const delay = due - (yield* Clock.currentTimeMillis)
				if (delay > 0) {
					if (state.saved.record.status !== "waiting")
						yield* store.commit(fence, { status: "waiting" }, Effect.void)
					yield* DurableDeferred.raceAll({
						name: `expiry:${state.revision}`,
						success: Schema.Void,
						error: Schema.Never,
						effects: [
							DurableDeferred.await(Engine.signal(signal)),
							DurableClock.sleep({
								name: `check:${state.revision}`,
								duration: delay,
								inMemoryThreshold: 0,
							}),
						],
					})
				}
				if ((yield* store.get(fence)).status === "waiting")
					yield* store.commit(fence, { status: "running" }, Effect.void)
				if (yield* cleanup.tick(fence)) break
			}
			if ((yield* store.get(fence)).status === "waiting")
				yield* store.commit(fence, { status: "running" }, Effect.void)
			const { record } = yield* cleanup.current(fence)
			// The source keeps an unknown write pending until its decision is saved.
			yield* commands.stop(record.owner, record.value.id)
			yield* cleanup.transfer(fence)

			while (true) {
				const pending = yield* cleanup.complete(fence)
				if (Option.isNone(pending)) return
				yield* observation.observe(pending.value, 0).pipe(Stream.runDrain)
			}
		})
	return (key: Parameters<typeof run>[0]) =>
		run(key, work).pipe(Effect.provideService(Clock.Clock, clock))
})
/** Adds the workflow and its access rules. When the scope closes, they go. */
export const contribute = Effect.gen(function* () {
	const execute = yield* make
	const cleanup = yield* TestCleanup
	const workflows = yield* Workflows
	yield* workflows.contribute({
		workflow,
		plugin: "apps",
		journal: 1,
		run: execute,
		policy: Policy.Service({
			serviceId: serviceId,
			authorize: cleanup.serviceAuthorize,
			publicRead: cleanup.authorize,
		}),
	})
})

export const layer = Layer.effectDiscard(contribute)
