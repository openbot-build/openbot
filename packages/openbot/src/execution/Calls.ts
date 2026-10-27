import * as Send from "./Send.ts"
import * as Admission from "./Admission.ts"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import { Records } from "../errors/Records.ts"
import { Registry } from "./Engine.ts"
import * as Recovery from "./Recovery.ts"
import { Store, transactionFailures, type Fence, type Key } from "./Store.ts"

export const Outcome = Schema.TaggedUnion({
	Completed: { callId: Execution.CallId, result: Schema.Json },
	Unknown: { callId: Execution.CallId },
})
export type Outcome = typeof Outcome.Type
export interface Input<E = never, R = never> {
	/** Read a committed command receipt. This must not start or change work. */
	readonly savedResult?: (
		callId: Execution.CallId,
	) => Effect.Effect<Option.Option<Schema.Json>, E, R>

	/** Database writes that commit with the call result, including late results. */
	readonly onResult?: (
		callId: Execution.CallId,
		result: Schema.Json,
	) => Effect.Effect<void, E, R>
	readonly step: string
	readonly attempt: number
	readonly retry: Execution.Retry
	readonly input: Schema.Json
	/** Output events commit with the saved result. They must not carry a state change. */
	readonly resultEvents?: (
		result: Schema.Json,
	) => ReadonlyArray<Exclude<Execution.EventBody, { readonly _tag: "State" }>>
}
const make = Effect.gen(function* () {
	const client = yield* SqlClient.SqlClient
	const store = yield* Store
	const registry = yield* Registry
	const errors = yield* Records
	const recovery = yield* Recovery.Recovery
	const authorize = Effect.fn("ExecutionCalls.authorize")(function* (
		fence: Key,
		access: "advance" | "replay" = "advance",
	) {
		const execution = yield* store.load(fence)
		const feature = yield* registry.get(execution.workflow)
		if (Option.isNone(feature)) return yield* Execution.Forbidden.make({})
		return yield* feature.value.authorize(
			fence,
			execution.identity.actor,
			access,
		)
	})
	const admission = Effect.fn("ExecutionCalls.admission")(function* (
		key: Key,
		lock: boolean,
		call?: Execution.Call,
		intent?: Pick<Execution.Call, "retry" | "input">,
	) {
		const execution = yield* store.load(key)
		const feature = yield* registry.get(execution.workflow)
		if (Option.isNone(feature)) return yield* Execution.Forbidden.make({})
		if (feature.value.admit !== undefined)
			yield* feature.value.admit(key, lock, call, intent)
	}, Effect.asVoid)
	const pause = (value: Admission.Paused) =>
		Effect.interruptible(
			Effect.gen(function* () {
				if (value.wake !== undefined)
					yield* recovery.commit(value.id, store.wake(value, value.wake))
				return yield* Admission.stop(value)
			}),
		)
	const stopOnPause = <A, E, R>(work: Effect.Effect<A, E, R>) =>
		work.pipe(
			Effect.catchCause(
				(
					cause,
				): Effect.Effect<never, E | Effect.Error<ReturnType<typeof pause>>> => {
					const reason = cause.reasons[0]
					if (
						cause.reasons.length === 1 &&
						reason?._tag === "Fail" &&
						Schema.is(Admission.Paused)(reason.error)
					)
						return pause(reason.error)
					return Effect.failCause(cause)
				},
			),
		)
	/** Call before opening phase resources. Sending checks again in its transaction. */
	const ready = (key: Key, intent?: Pick<Execution.Call, "retry" | "input">) =>
		admission(key, false, undefined, intent).pipe(stopOnPause, Effect.asVoid)
	/** Run only database work here. The check and reservation share the owner locks. */
	const reserve = <A, E, R>(
		fence: Fence,
		call: Execution.Call,
		work: Effect.Effect<A, E, R>,
	) =>
		recovery
			.commit(
				fence.id,
				client
					.withTransaction(
						Effect.gen(function* () {
							yield* admission(fence, true, call)
							yield* store.lock(fence)
							const state = yield* store.load(fence)
							if (state.record.status !== "running" || state.phaseFailed)
								return yield* Execution.Conflict.make({ id: fence.id })
							yield* authorize(fence, "advance")
							return yield* work
						}),
					)
					.pipe(transactionFailures),
			)
			.pipe(
				// The transaction has ended before a pause waits. Acquisition may mask interruption.
				stopOnPause,
			)
	/** The adapter uses callId as the provider key when the provider supports it. */
	const invoke = Effect.fn("ExecutionCalls.invoke")(function* <
		E,
		R,
		BeforeE = never,
		BeforeR = never,
		ResultE = never,
		ResultR = never,
	>(
		fence: Fence,
		input: Input<ResultE, ResultR>,
		send: (callId: Execution.CallId) => Effect.Effect<Schema.Json, E, R>,
		beforeSend?: Effect.Effect<void, BeforeE, BeforeR>,
	) {
		// Check current permissions even when a saved result can be reused.
		yield* authorize(fence, "replay")
		const call = yield* store.intent(fence, input)
		const finish = (result: Schema.Json) =>
			recovery.commit(
				fence.id,
				store.finishCall(
					fence,
					call.id,
					result,
					input.resultEvents?.(result),
					input.onResult?.(call.id, result),
				),
			)

		if (call.status === "completed") {
			if (!(yield* finish(call.result)))
				return yield* Execution.Conflict.make({ id: fence.id })
			return Outcome.cases.Completed.make({
				callId: call.id,
				result: call.result,
			})
		}
		if (call.status === "outcome_unknown")
			return Outcome.cases.Unknown.make({ callId: call.id })
		if (
			(call.retry === "idempotent" || call.retry === "local") &&
			call.status === "sending" &&
			input.savedResult !== undefined
		) {
			const saved = yield* input.savedResult(call.id)
			if (Option.isSome(saved)) {
				if (!(yield* finish(saved.value)))
					return yield* Execution.Conflict.make({ id: fence.id })
				return Outcome.cases.Completed.make({
					callId: call.id,
					result: saved.value,
				})
			}
		}
		// An unsafe send with no result needs a decision, not another send permit.
		if (call.status === "sending" && call.retry === "never") {
			const saved = yield* store.sending(fence, call.id)
			if (saved.status === "completed") {
				if (!(yield* finish(saved.result)))
					return yield* Execution.Conflict.make({ id: fence.id })
				return Outcome.cases.Completed.make({
					callId: call.id,
					result: saved.result,
				})
			}
			if (saved.status === "outcome_unknown")
				return Outcome.cases.Unknown.make({ callId: call.id })
		}
		yield* ready(fence)
		const checkSend = Effect.gen(function* () {
			yield* authorize(fence, "advance")
			if (call.retry === "never" && call.attempt > 0) {
				const previous = Arr.findFirst(
					yield* store.calls(fence),
					(prior) =>
						prior.step === call.step && prior.attempt === call.attempt - 1,
				)
				if (Option.isNone(previous))
					return yield* Execution.Conflict.make({ id: fence.id })
				// A feature can repeat a saved refusal. An unknown result needs a person's decision.
				const saved = yield* store.decision(
					fence,
					Execution.callDecisionId(
						previous.value.id,
						(yield* store.load(fence)).cancelEpoch,
					),
				)
				if (Option.isNone(saved)) {
					if (previous.value.status !== "completed")
						return yield* Execution.Conflict.make({ id: fence.id })
				} else {
					if (saved.value.answer?.answer !== "retry")
						return yield* Execution.Conflict.make({ id: fence.id })
					const execution = yield* store.load(fence)
					const feature = yield* registry.get(execution.workflow)
					if (Option.isNone(feature)) return yield* Execution.Forbidden.make({})
					// A restart after intent was saved must not keep a revoked decision maker's rights.
					yield* feature.value.authorize(
						fence,
						saved.value.answer.actor,
						"decide",
					)
				}
			}
		})
		yield* checkSend
		// A saved result needs no new approval. A new send checks the action before it is marked sent.
		if (beforeSend !== undefined) yield* beforeSend
		// This transaction checks the generation and cancellation state, then commits
		// before any outside I/O. Another owner may only save a late result after this.
		const sending = yield* store
			.sending(
				fence,
				call.id,
				// A send check may wait. Read both callers' current rights again after it.
				admission(fence, true, call).pipe(Effect.andThen(checkSend)),
			)
			.pipe(stopOnPause)
		if (sending.status === "completed") {
			if (!(yield* finish(sending.result)))
				return yield* Execution.Conflict.make({ id: fence.id })
			return Outcome.cases.Completed.make({
				callId: call.id,
				result: sending.result,
			})
		}
		if (sending.status === "outcome_unknown")
			return Outcome.cases.Unknown.make({ callId: call.id })
		return yield* Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const result = yield* restore(send(call.id)).pipe(
					Effect.provideService(
						Send.Current,
						Option.some(
							Send.Authority.cases.Call.make({
								reference: { ...fence, callId: call.id },
							}),
						),
					),
					Effect.matchCauseEffect({
						onSuccess: (result) => Effect.succeedSome(result),
						onFailure: (cause) =>
							Effect.gen(function* () {
								if (Cause.hasInterruptsOnly(cause))
									return yield* Effect.failCause(
										Cause.fromReasons<never>(
											Arr.filter(cause.reasons, Cause.isInterruptReason),
										),
									)
								const failure = yield* errors.record(
									cause,
									input.retry === "never" ? "outcome_unknown" : "external",
									fence.id,
								)
								if (input.retry === "read_only")
									yield* store.incompleteRead(fence, call.id)
								if (input.retry !== "never") return yield* Effect.fail(failure)
								yield* store.uncertain(fence, call.id)
								return Option.none<Schema.Json>()
							}),
					}),
				)
				if (Option.isNone(result))
					return Outcome.cases.Unknown.make({ callId: call.id })
				// The first save stays inside this mask, even if cancellation is pending.
				// Only a failed save opens an interruptible wait before the next try.
				if (!(yield* finish(result.value)))
					return yield* Execution.Conflict.make({ id: fence.id })

				return Outcome.cases.Completed.make({
					callId: call.id,
					result: result.value,
				})
			}),
		)
	})
	/** Pending carries the cursor saved with the choice, so a late result cannot be missed. */
	const recover = store.recoverCall

	return { invoke, authorize, recover, ready, reserve, admission, stopOnPause }
})
export class Calls extends Context.Service<
	Calls,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/execution/Calls") {}
export const layer = Layer.effect(Calls, make).pipe(
	Layer.provide(Recovery.layer),
)
