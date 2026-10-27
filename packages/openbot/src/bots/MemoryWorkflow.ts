import { DurableClock } from "effect/workflow"
import { MemoryBot, MemoryBudgetSpent } from "./MemoryBot.ts"
import type { Fence } from "../execution/Store.ts"
import { Clock, DateTime, Effect, Layer, Result, Schema } from "effect"
import * as Engine from "../execution/Engine.ts"
import { Runner } from "../execution/Runner.ts"
import { RunScope } from "../execution/RunScope.ts"
import { MemoryLearning, workflowName } from "./MemoryLearning.ts"

export const workflow = Engine.define(workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const learning = yield* MemoryLearning
		const runner = yield* Runner
		const phases = yield* RunScope
		const registry = yield* Engine.Registry
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
		return workflow
			.toLayer((key) =>
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
			)
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(registry.register(workflow, learning.authorize)),
				),
			)
	}),
)
