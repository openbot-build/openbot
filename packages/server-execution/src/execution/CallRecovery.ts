import { Execution } from "@openbot-build/domain"
import { Effect, Option } from "effect"
import { Calls } from "./Calls.ts"
import { RunScope } from "./RunScope.ts"
import { Store, type Fence } from "./Store.ts"

/** All workflows use the same rule for unknown outside results and saved choices. */
export const make = Effect.gen(function* () {
	const store = yield* Store
	const calls = yield* Calls
	const scopes = yield* RunScope
	return Effect.fn("CallRecovery.settle")(function* (
		fence: Fence,
		failed: boolean = false,
	) {
		let restarted = false
		while (true) {
			const state = yield* store.load(fence)
			if (state.generation !== fence.generation) return yield* Effect.interrupt
			if (
				Execution.isTerminal(state.record.status) ||
				state.record.status === "cancelling"
			)
				return { stop: false, restarted }
			const latest = yield* store.latestCalls(fence)
			let reload = false
			let stop = false
			let pending = Option.none<{
				readonly decisionId: string
				readonly afterSequence: number
			}>()
			for (const call of latest) {
				if (call.retry !== "never" && call.retry !== "idempotent") continue
				if (
					call.status === "sending" &&
					(call.retry === "never" ||
						state.phaseFailed ||
						(failed && !restarted))
				) {
					yield* store.uncertain(fence, call.id)
					reload = true
					break
				}
				if (
					call.status === "completed" &&
					state.record.status !== "outcome_unknown"
				) {
					// Another call may have resumed the execution. A saved stop still wins after a restart.
					const choice = yield* store.decision(
						fence,
						Execution.callDecisionId(call.id, state.cancelEpoch),
					)
					if (Option.isNone(choice) || choice.value.answer?.answer !== "stop")
						continue
				} else if (
					call.status !== "outcome_unknown" &&
					call.status !== "completed"
				)
					continue
				const answer = yield* calls.recover(fence, call.id)
				if (answer._tag === "Stop") stop = true
				if (answer._tag === "Retry") {
					restarted = true
					reload = true
					break
				}
				if (
					answer._tag === "Pending" &&
					(Option.isNone(pending) ||
						answer.afterSequence < pending.value.afterSequence)
				)
					pending = Option.some(answer)
			}
			if (reload) continue
			if (Option.isNone(pending)) return { stop, restarted }
			// One cursor covers every call in this execution. No tool scope stays open.
			yield* scopes.run(
				fence,
				`calls:${pending.value.decisionId}`,
				undefined,
				pending.value,
			)
		}
	})
})
