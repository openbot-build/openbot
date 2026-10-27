import { Cause, Clock, Effect, Layer, Schema } from "effect"
import { DurableClock, DurableDeferred } from "effect/workflow"
import { Records } from "../errors/Records.ts"
import { Calls } from "../execution/Calls.ts"
import * as Engine from "../execution/Engine.ts"
import * as Program from "../execution/Program.ts"
import { Store, type Fence } from "../execution/Store.ts"
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
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const monitor = yield* DeveloperMonitor
		const watches = yield* DeveloperWatches
		const store = yield* Store
		const calls = yield* Calls
		const errors = yield* Records
		const registry = yield* Engine.Registry
		const run = yield* Program.make
		const work = (fence: Fence) =>
			Effect.gen(function* () {
				while (true) {
					const current = yield* watches.load(fence)
					const revision = current.row.revision
					const delay =
						current.row.nextCheckAt - (yield* Clock.currentTimeMillis)
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
		return workflow
			.toLayer((key) => run(key, work))
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(
						registry.registerService(workflow, serviceId, watches.authorize),
					),
				),
			)
	}),
)
