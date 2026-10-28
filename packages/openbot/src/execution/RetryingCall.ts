import { Execution } from "@openbot-build/domain"
import { Cause, Clock, Effect, Option, Schema } from "effect"
import { DurableClock } from "effect/workflow"
import { Records } from "../errors/Records.ts"
import { Calls } from "./Calls.ts"
import { Store, type Fence } from "./Store.ts"

/** The result stays sealed. A retry keeps its cause and its next wake time. */
export const Result = Schema.TaggedUnion({
	Completed: { value: Schema.Json },
	Retry: { failure: Execution.Failure, retryAt: Schema.Finite },
})
/** Only use this for a read or write with a reliable, fixed idempotency key. */
export const make = Effect.gen(function* () {
	const calls = yield* Calls
	const store = yield* Store
	const errors = yield* Records
	return <E, R>(
		fence: Fence,
		step: string,
		input: Schema.Json,
		send: (
			idempotencyKey: Execution.CallId,
		) => Effect.Effect<Schema.Json, E, R>,
	) =>
		Effect.gen(function* () {
			yield* calls.authorize(fence, "replay")
			const prior = yield* store.latestCall(fence, step)
			let call = Option.isSome(prior)
				? prior.value
				: yield* store.writeAttempt(fence, step, input, "idempotent")
			if (
				call.retry !== "idempotent" ||
				!Schema.toEquivalence(Schema.Json)(call.input, input)
			)
				return yield* Execution.Conflict.make({ id: fence.id })
			const first = yield* store.firstCall(fence, step)
			if (Option.isNone(first) || first.value.attempt !== 0)
				return yield* Effect.die("The call has no first attempt.")
			const idempotencyKey = first.value.id
			while (true) {
				const outcome =
					call.status === "completed" &&
					(yield* store.get(fence)).status === "waiting"
						? { _tag: "Completed" as const, result: call.result }
						: yield* calls.invoke(fence, call, () =>
								send(idempotencyKey).pipe(
									Effect.map((value): typeof Result.Type => ({
										_tag: "Completed",
										value,
									})),
									Effect.catchCauseIf(
										(cause) =>
											!Cause.hasInterrupts(cause) && !Cause.hasDies(cause),
										(cause) =>
											Effect.gen(function* () {
												const failure = yield* errors.record(
													cause,
													"external",
													fence.id,
												)
												return {
													_tag: "Retry",
													failure,
													retryAt:
														(yield* Clock.currentTimeMillis) +
														Math.min(
															60000,
															1000 * 2 ** Math.min(call.attempt, 6),
														),
												} satisfies typeof Result.Type
											}),
									),
									Effect.flatMap(Schema.encodeEffect(Result)),
								),
							)
				if (outcome._tag === "Unknown") return Option.none<Schema.Json>()
				const saved = yield* Schema.decodeUnknownEffect(Result)(outcome.result)
				if (saved._tag === "Completed") return Option.some(saved.value)
				if ((yield* store.get(fence)).status !== "waiting")
					yield* store.commit(fence, { status: "waiting" }, Effect.void)
				yield* DurableClock.sleep({
					name: `retry:${step}:${call.attempt}`,
					duration: Math.max(
						0,
						saved.retryAt - (yield* Clock.currentTimeMillis),
					),
					inMemoryThreshold: 0,
				})
				yield* store.commit(fence, { status: "running" }, Effect.void)
				call = yield* store.repeatCall(fence, call.id, outcome.result)
			}
		})
})
