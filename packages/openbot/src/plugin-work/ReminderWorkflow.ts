import { Effect, Layer } from "effect"
import * as Engine from "../server-execution/execution/Engine.ts"
import { Policy, Workflows } from "../server-execution/execution/Workflows.ts"
import { Runner } from "../server-execution/execution/Runner.ts"
import { RunScope } from "../server-execution/execution/RunScope.ts"
import { ReminderCommands, workflowName } from "./ReminderCommands.ts"

export const workflow = Engine.define(workflowName)
/** Adds the workflow and its access rules. When the scope closes, they go. */
export const contribute = Effect.gen(function* () {
	const commands = yield* ReminderCommands
	const runner = yield* Runner
	const phases = yield* RunScope
	const workflows = yield* Workflows
	yield* workflows.contribute({
		workflow,
		plugin: "work",
		journal: 1,
		run: (key) =>
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
		policy: Policy.Public({ authorize: commands.authorize }),
	})
})

export const layer = Layer.effectDiscard(contribute)
