import { Cause, Clock, Effect, Layer, Schema } from "effect"
import { DurableClock, DurableDeferred } from "effect/workflow"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import { Calls } from "@openbot-build/server-execution/execution/Calls"
import * as Engine from "@openbot-build/server-execution/execution/Engine"
import {
	Policy,
	Workflows,
} from "@openbot-build/server-execution/execution/Workflows"
import * as Program from "@openbot-build/server-execution/execution/Program"
import {
	Store,
	type Fence,
} from "@openbot-build/server-execution/execution/Store"
import { CheckResult, DeveloperMonitor } from "./DeveloperMonitor.ts"
import {
	DeveloperWatches,
	Reference,
	nextSignal,
	serviceId,
	workflowName,
} from "./DeveloperWatches.ts"

export const workflow = Engine.define(workflowName)
const resultCodec = Schema.toCodecJson(CheckResult)
/** Adds the workflow and its access rules. When the scope closes, they go. */
export const contribute = Effect.gen(function* () {
	const monitor = yield* DeveloperMonitor
	const watches = yield* DeveloperWatches
	const store = yield* Store
	const calls = yield* Calls
	const errors = yield* Records
	const workflows = yield* Workflows
	const run = yield* Program.make
	const work = (fence: Fence) =>
		Effect.gen(function* () {
			while (true) {
				const current = yield* watches.load(fence)
				const revision = current.row.revision
				const delay = current.row.nextCheckAt - (yield* Clock.currentTimeMillis)
				if (delay > 0) {
					if (current.saved.record.status !== "waiting")
						yield* store.commit(fence, { status: "waiting" }, Effect.void)
					yield* DurableDeferred.raceAll({
						name: `next:${revision}`,
						success: Schema.Void,
						error: Schema.Never,
						effects: [
							DurableDeferred.await(Engine.signal(nextSignal(revision))),
							DurableClock.sleep({
								name: `due:${revision}`,
								duration: delay,
								inMemoryThreshold: 0,
							}),
						],
					})
				}
				const latest = yield* watches.load(fence)
				if (latest.saved.record.status === "waiting")
					yield* store.commit(fence, { status: "running" }, Effect.void)
				const prepared = yield* monitor.prepare(current.ref)
				const step = `check:${revision}`
				const call = yield* store.readAttempt(
					fence,
					step,
					yield* Schema.encodeEffect(Schema.toCodecJson(Reference))(
						current.ref,
					),
				)
				const result = yield* calls.invoke(fence, call, () =>
					monitor.inspect(prepared).pipe(
						Effect.timeout("4 minutes"),
						Effect.catchCauseIf(
							(cause) => !Cause.hasInterrupts(cause),
							(cause) =>
								errors.record(cause, "external", fence.id).pipe(
									Effect.map((failure): CheckResult => ({
										_tag: "Failed",
										failure,
									})),
								),
						),
						Effect.flatMap(Schema.encodeEffect(resultCodec)),
					),
				)
				if (result._tag === "Unknown") return
				yield* monitor.complete(
					fence,
					revision,
					yield* Schema.decodeEffect(resultCodec)(result.result),
				)
				if ((yield* store.get(fence)).status === "completed") return
			}
		})
	yield* workflows.contribute({
		workflow,
		plugin: "apps",
		journal: 1,
		run: (key) => run(key, work),
		policy: Policy.Service({
			serviceId: serviceId,
			authorize: watches.authorize,
		}),
	})
})

export const layer = Layer.effectDiscard(contribute)
