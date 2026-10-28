import { Execution } from "@openbot-build/domain"
import { Effect, Option, type Scope } from "effect"
import * as CallRecovery from "./CallRecovery.ts"
import { Runner } from "./Runner.ts"
import { RunScope, type Options } from "./RunScope.ts"
import { Store, type Fence, type Key } from "./Store.ts"

export type End =
	| { readonly status: "failed"; readonly failure: Execution.Failure }
	| { readonly status: "interrupted" }
	| { readonly status: "cancelled"; readonly epoch: number }

export interface Current {
	readonly fence: Fence
	readonly record: Execution.Record
}

export type EndReason =
	| { readonly _tag: "Cancel"; readonly epoch: number }
	| {
			readonly _tag: "Stop"
			readonly failure: Option.Option<Execution.Failure>
	  }
	| { readonly _tag: "Fail"; readonly failure: Execution.Failure }

/** A phase keeps its saved name. Its next state waits until its scope closes. */
export type Step<E = never, R = never, EAfter = E, RAfter = R> =
	| { readonly _tag: "Again" }
	| { readonly _tag: "Failed"; readonly failure: Execution.Failure }
	| {
			readonly _tag: "Phase"
			readonly name: string
			readonly work: Effect.Effect<void, E, R | Scope.Scope> | undefined
			readonly options: Options | undefined
			readonly after: Effect.Effect<void, EAfter, RAfter>
	  }

/** Features choose phases and end transactions. This loop owns the execution rules. */
export const phased = Effect.gen(function* () {
	const runner = yield* Runner
	const scopes = yield* RunScope
	const store = yield* Store
	const settle = yield* CallRecovery.make
	return <
		E = never,
		R = never,
		EAfter = never,
		RAfter = never,
		ENext = never,
		RNext = never,
		EEnd = never,
		REnd = never,
	>(
		key: Key,
		program: {
			readonly next: (
				current: Current,
			) => Effect.Effect<Step<E, R, EAfter, RAfter>, ENext, RNext>
			readonly end: (
				fence: Fence,
				reason: EndReason,
			) => Effect.Effect<void, EEnd, REnd>
		},
	) => {
		const run = (fence: Fence, initial?: Execution.Failure) =>
			Effect.gen(function* () {
				let failure = initial
				while (true) {
					const recovered = yield* settle(fence, failure !== undefined)
					if (recovered.restarted) failure = undefined
					const state = yield* store.load(fence)
					if (state.generation !== fence.generation)
						return yield* Effect.interrupt
					if (Execution.isTerminal(state.record.status)) return
					failure = (state.phaseFailed ? state.record.failure : null) ?? failure
					if (state.record.status === "cancelling") {
						yield* program.end(fence, {
							_tag: "Cancel",
							epoch: state.cancelEpoch,
						})
						continue
					}
					if (recovered.stop)
						return yield* program.end(fence, {
							_tag: "Stop",
							failure: Option.fromUndefinedOr(failure),
						})
					if (failure !== undefined)
						return yield* program.end(fence, { _tag: "Fail", failure })
					const next = yield* program.next({ fence, record: state.record })
					if (next._tag === "Again") continue
					if (next._tag === "Failed") {
						failure = next.failure
						continue
					}
					const result = yield* scopes.run(
						fence,
						next.name,
						next.work,
						next.options,
					)
					if (result._tag === "Failed") {
						failure = result.failure
						continue
					}
					if (result._tag === "Cancelled" || result._tag === "Expired") continue
					yield* next.after
				}
			})
		return runner.run(key, (fence) => run(fence), run)
	}
})

/** A one-phase program uses the same driver and keeps its saved work names. */
export const make = Effect.gen(function* () {
	const run = yield* phased
	const store = yield* Store
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
		const endRun = (
			fence: Fence,
			end: End,
		): Effect.Effect<
			void,
			E2 | Effect.Error<ReturnType<typeof defaultFinish>>,
			R2
		> => (finish === undefined ? defaultFinish(fence, end) : finish(fence, end))
		return run(key, {
			next: ({ fence, record }) =>
				Effect.succeed<Step<E, R, never, never>>({
					_tag: "Phase",
					name: "work:" + record.sequence,
					work: work(fence),
					options: undefined,
					after: Effect.void,
				}),
			end: (fence, reason) =>
				endRun(
					fence,
					reason._tag === "Cancel"
						? { status: "cancelled", epoch: reason.epoch }
						: reason._tag === "Fail"
							? { status: "failed", failure: reason.failure }
							: { status: "interrupted" },
				),
		})
	}
})
