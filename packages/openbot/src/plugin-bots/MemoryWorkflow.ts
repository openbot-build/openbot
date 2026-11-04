import { DurableClock } from "effect/workflow"
import { MemoryBot } from "../conversation-contract/bots/MemoryBot.ts"
import { MemoryBudgetSpent } from "./MemoryBot.ts"
import type { Fence } from "../server-execution/execution/Store.ts"
import { Clock, DateTime, Effect, Layer, Result, Schema } from "effect"
import * as Engine from "../server-execution/execution/Engine.ts"
import { Policy, Workflows } from "../server-execution/execution/Workflows.ts"
import { Runner } from "../server-execution/execution/Runner.ts"
import { RunScope } from "../server-execution/execution/RunScope.ts"
import { MemoryLearning, workflowName } from "./MemoryLearning.ts"

export const workflow = Engine.define(workflowName)
/** Adds the workflow and its access rules. When the scope closes, they go. */
export const contribute = Effect.gen(function* () {
	const learning = yield* MemoryLearning
	const runner = yield* Runner
	const phases = yield* RunScope
	const workflows = yield* Workflows
	const memory = yield* MemoryBot
	const learn = (fence: Fence) =>
		Effect.gen(function* () {
			while (true) {
				const result = yield* Effect.result(learning.learn(fence))
				if (Result.isSuccess(result)) return
				if (!Schema.is(MemoryBudgetSpent)(result.failure))
					return yield* Effect.fail(result.failure)
				const settings = yield* memory.settings(result.failure.home)
				if (settings.budget === undefined) continue
				const now = yield* Clock.currentTimeMillis
				const period = settings.budget.period
				const start = DateTime.startOf(
					DateTime.makeUnsafe(now),
					period === "day" ? "day" : "month",
				)
				const due = DateTime.toEpochMillis(
					DateTime.add(start, period === "day" ? { days: 1 } : { months: 1 }),
				)
				yield* DurableClock.sleep({
					name: "memory-budget:" + due,
					duration: due - now,
					inMemoryThreshold: 0,
				})
			}
		})
	yield* workflows.contribute({
		workflow,
		plugin: "bots",
		journal: 1,
		run: (key) =>
			runner.run(
				key,
				(fence) =>
					Effect.gen(function* () {
						const result = yield* phases.run(fence, "learn", learn(fence))
						if (result._tag === "Cancelled")
							yield* learning.finish(fence, {
								status: "cancelled",
								epoch: result.epoch,
							})
						if (result._tag === "Failed")
							yield* learning.finish(fence, {
								status: "failed",
								failure: result.failure,
							})
					}),
				(fence, failure) =>
					learning.finish(fence, { status: "failed", failure }),
			),
		policy: Policy.Public({ authorize: learning.authorize }),
	})
})

export const layer = Layer.effectDiscard(contribute)
