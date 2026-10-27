import { Execution } from "@openbot-build/domain"
import { Effect } from "effect"
import * as CallRecovery from "./CallRecovery.ts"
import { Runner } from "./Runner.ts"
import { RunScope } from "./RunScope.ts"
import { Store, type Fence, type Key } from "./Store.ts"

export type End =
	| { readonly status: "failed"; readonly failure: Execution.Failure }
	| { readonly status: "interrupted" }
	| { readonly status: "cancelled"; readonly epoch: number }

/** A program commits its own result after releasing resources. The common loop owns recovery and cancellation. */
export const make = Effect.gen(function* () {
	const runner = yield* Runner
	const scopes = yield* RunScope
	const store = yield* Store
	const settle = yield* CallRecovery.make
	const defaultFinish = (fence: Fence, end: End) =>
		end.status === "cancelled"
			? store
					.finishCancellation(fence, end.epoch, () => Effect.succeed([]))
					.pipe(Effect.asVoid)
			: store.commit(
					fence,
					{
						status: end.status,
						...(end.status === "failed" ? { failure: end.failure } : {}),
					},
					Effect.void,
				)
	return <E, R, E2 = never, R2 = never>(
		key: Key,
		work: (fence: Fence) => Effect.Effect<void, E, R>,
		finish?: (fence: Fence, end: End) => Effect.Effect<void, E2, R2>,
	) => {
		const endRun = finish ?? defaultFinish
		const run = (fence: Fence, initial?: Execution.Failure) =>
			Effect.gen(function* () {
				let failure = initial
				while (true) {
					const recovered = yield* settle(fence, failure !== undefined)
					if (recovered.restarted) failure = undefined
					const state = yield* store.load(fence)
					if (Execution.isTerminal(state.record.status)) return
					if (state.record.status === "cancelling") {
						yield* endRun(fence, {
							status: "cancelled",
							epoch: state.cancelEpoch,
						})
						continue
					}
					if (recovered.stop)
						return yield* endRun(fence, { status: "interrupted" })
					failure = (state.phaseFailed ? state.record.failure : null) ?? failure
					if (failure !== undefined)
						return yield* endRun(fence, { status: "failed", failure })
					const result = yield* scopes.run(
						fence,
						"work:" + state.record.sequence,
						work(fence),
					)
					if (result._tag === "Failed") failure = result.failure
				}
			})
		return runner.run(key, (fence) => run(fence), run)
	}
})
