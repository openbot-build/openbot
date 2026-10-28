import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Exit,
	Layer,
	Schema,
} from "effect"
import { Billing } from "../billing/Billing.ts"
import * as Recovery from "./Recovery.ts"
import { Store, type Fence, type Key } from "./Store.ts"

export interface Service {
	readonly run: <E, R, E2, R2>(
		key: Key,
		work: (fence: Fence) => Effect.Effect<void, E, R>,
		failed: (
			fence: Fence,
			failure: Execution.Failure,
		) => Effect.Effect<void, E2, R2>,
	) => Effect.Effect<
		void,
		{
			errorId: Execution.ErrorId
			category: Execution.Failure["category"]
		},
		R | R2
	>
}

export class Runner extends Context.Service<Runner, Service>()(
	"@openbot-build/openbot/execution/Runner",
) {}

const make = Effect.gen(function* () {
	const store = yield* Store
	const billing = yield* Billing
	const recovery = yield* Recovery.Recovery
	const release = (fence: Fence) =>
		recovery.storage(
			fence.id,
			billing
				.releaseExecution({
					executionId: fence.id,
					generation: fence.generation,
				})
				.pipe(
					Effect.mapError((error) =>
						error.retryable === true
							? Execution.StorageError.make({ cause: error })
							: error,
					),
					Effect.flatMap((current) =>
						current ? Effect.void : Effect.interrupt,
					),
				),
		)
	/** An engine result is returned only after the feature has committed its end. */
	const run = <E, R, E2, R2>(
		key: Key,
		work: (fence: Fence) => Effect.Effect<void, E, R>,
		failed: (
			fence: Fence,
			failure: Execution.Failure,
		) => Effect.Effect<void, E2, R2>,
	) =>
		Effect.gen(function* () {
			const initial = yield* recovery.storage(key.id, store.load(key))
			if (Execution.isTerminal(initial.record.status))
				return yield* release({ ...key, generation: initial.generation })
			const fence = yield* recovery.storage(key.id, store.takeOver(key))
			yield* release(fence)
			let task: Effect.Effect<void, E | E2, R | R2> = work(fence)
			let delay = 100
			while (true) {
				const result = yield* Effect.exit(recovery.storage(key.id, task))
				if (Exit.isSuccess(result)) return yield* release(fence)
				const cause = result.cause
				if (Cause.hasInterruptsOnly(cause))
					return yield* Effect.failCause(
						Cause.fromReasons<never>(
							Arr.filter(cause.reasons, Cause.isInterruptReason),
						),
					)
				const state = yield* recovery.storage(key.id, store.load(key))
				// A stale owner must not take ownership back or end the new owner's workflow.
				if (state.generation !== fence.generation)
					return yield* Effect.interrupt
				if (Execution.isTerminal(state.record.status))
					return yield* release(fence)
				if (
					state.record.status === "cancelling" &&
					Arr.every(
						cause.reasons,
						(reason) =>
							reason._tag === "Fail" &&
							Schema.is(Execution.Conflict)(reason.error),
					)
				) {
					task = work(fence)
					continue
				}
				// Keep each failed release cause, even when the first work failure is saved.
				const recorded = yield* recovery.record(cause, key.id)
				const failure =
					state.phaseFailed && state.record.failure !== null
						? state.record.failure
						: recorded
				// Stop new child sends before the feature releases its resources.
				yield* recovery
					.commit(key.id, store.failPhase(fence, failure))
					.pipe(Effect.catchTag("ExecutionConflict", () => Effect.interrupt))
				task = failed(fence, failure)
				// A failed end write must not make the engine report completion.
				yield* Effect.sleep(delay)
				delay = Math.min(delay * 2, 5000)
			}
		}).pipe(
			Effect.catchCause((cause) => {
				if (Cause.hasInterruptsOnly(cause))
					return Effect.failCause(
						Cause.fromReasons<never>(
							Arr.filter(cause.reasons, Cause.isInterruptReason),
						),
					)
				// This path is for a missing record before ownership was obtained.
				return recovery.record(cause, key.id).pipe(Effect.flatMap(Effect.fail))
			}),
		)
	return Runner.of({ run })
})

export const layer = Layer.effect(Runner, make).pipe(
	Layer.provide(Recovery.layer),
)
