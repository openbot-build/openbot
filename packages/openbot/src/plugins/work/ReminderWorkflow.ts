import { Effect, Layer } from "effect"
import * as Engine from "../../execution/Engine.ts"
import { Runner } from "../../execution/Runner.ts"
import { RunScope } from "../../execution/RunScope.ts"
import { ReminderCommands, workflowName } from "./ReminderCommands.ts"

export const workflow = Engine.define(workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const commands = yield* ReminderCommands
		const runner = yield* Runner
		const phases = yield* RunScope
		const registry = yield* Engine.Registry
		return workflow
			.toLayer((key) =>
				runner.run(
					key,
					(fence) =>
						Effect.gen(function* () {
							const saved = yield* commands.load(fence)
							const result = yield* phases.run(fence, "due", undefined, {
								deadline: saved.record.dueAt,
							})
							if (result._tag === "Cancelled") {
								yield* commands.finish(fence, {
									status: "cancelled",
									epoch: result.epoch,
								})
								return
							}
							if (result._tag === "Failed") {
								yield* commands.finish(fence, {
									status: "failed",
									failure: result.failure,
								})
								return
							}
							if (result._tag === "Expired") yield* commands.deliver(fence)
						}),
					(fence, failure) =>
						commands.finish(fence, { status: "failed", failure }),
				),
			)
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(registry.register(workflow, commands.authorize)),
				),
			)
	}),
)
