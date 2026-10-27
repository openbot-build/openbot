import { Execution } from "@openbot-build/domain"
import { Effect, Layer, Option, Schema } from "effect"
import * as Engine from "../execution/Engine.ts"
import { Runner } from "../execution/Runner.ts"
import { RunScope } from "../execution/RunScope.ts"
import { Store, storage, type Key, type Fence } from "../execution/Store.ts"
import * as Fire from "./Fire.ts"
import { Triggers, ScheduleInput, workflowName } from "./Triggers.ts"

export const workflow = Engine.define(workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const store = yield* Store
		const triggers = yield* Triggers
		const fire = yield* Fire.make
		const runner = yield* Runner
		const phases = yield* RunScope
		const registry = yield* Engine.Registry
		const load = (key: Key) =>
			Effect.gen(function* () {
				const execution = yield* store.loadMember(key)
				const input = yield* Schema.decodeUnknownEffect(ScheduleInput)(
					execution.input,
				)
				if (
					execution.workflow !== workflowName ||
					execution.record.resource.kind !== "TriggerSchedule" ||
					execution.record.resource.id !== input.triggerId
				)
					return yield* Execution.Forbidden.make({})
				return { execution, input }
			}).pipe(storage)
		const authorize: Engine.Authorize = (key, actor, mode) =>
			load(key).pipe(
				Effect.flatMap(({ input, execution }) =>
					Effect.gen(function* () {
						if (
							actor.organizationId !== execution.identity.owner.organizationId
						)
							return yield* Execution.Forbidden.make({})
						yield* triggers.get(
							actor,
							input.triggerId,
							mode === "read" ? "read" : "write",
						)
					}),
				),
				storage,
			)
		const finish = (
			fence: Fence,
			end:
				| { readonly status: "failed"; readonly failure: Execution.Failure }
				| { readonly status: "cancelled"; readonly epoch: number },
		) =>
			end.status === "cancelled"
				? store.finishCancellation(fence, end.epoch)
				: store.commit(fence, end, Effect.void)
		return workflow
			.toLayer((key) =>
				runner.run(
					key,
					(fence) =>
						Effect.gen(function* () {
							const { input, execution } = yield* load(fence)
							const result = yield* phases.run(fence, "due", undefined, {
								deadline: input.dueAt,
							})
							if (result._tag === "Cancelled")
								return yield* finish(fence, {
									status: "cancelled",
									epoch: result.epoch,
								})
							if (result._tag === "Failed")
								return yield* finish(fence, {
									status: "failed",
									failure: result.failure,
								})
							if (result._tag !== "Expired") return
							const current = yield* triggers.read(
								execution.identity.owner.organizationId,
								input.triggerId,
							)
							if (
								Option.isNone(current) ||
								current.value.trigger.executionId !== fence.id ||
								current.value.trigger.revision !== input.revision
							) {
								// A saved change has replaced this timer. It must not start old work.
								return yield* store.commit(
									fence,
									{ status: "completed" },
									Effect.void,
								)
							}
							yield* fire({
								organizationId: execution.identity.owner.organizationId,
								id: input.triggerId,
								revision: input.revision,
								key: Execution.CommandKey.make(
									`schedule:${input.revision}:${input.dueAt}`,
								),
								schedule: fence,
							})
						}).pipe(Effect.asVoid),
					(fence, failure) => finish(fence, { status: "failed", failure }),
				),
			)
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(registry.register(workflow, authorize)),
				),
			)
	}),
)
