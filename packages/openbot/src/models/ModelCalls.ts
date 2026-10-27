import { category } from "../errors/Records.ts"
import * as ModelFailure from "./ModelFailure.ts"
import * as Recovery from "../execution/Recovery.ts"
import { Execution } from "@openbot-build/domain"
import { Effect, Schema, Ref, Option, Exit } from "effect"
import { AiError, type Response } from "effect/ai"
import { Array as Arr, Cause } from "effect"
import {
	Billing,
	BillingStorageError,
	SpendingBlocked,
	tokensOf,
} from "../billing/Billing.ts"
import {
	CurrentCallIdentity,
	CurrentReservation,
	CurrentUsage,
	confirmed,
} from "../billing/MeteredModel.ts"
import { Calls } from "../execution/Calls.ts"
import { Store, type Fence } from "../execution/Store.ts"

/** A saved model result distinguishes an answer from a call that was not sent. */
export const resultCodec = <A>(value: Schema.Codec<A, Schema.Json>) =>
	Schema.Union([
		Schema.TaggedStruct("Completed", { value }),
		Schema.TaggedStruct("NotSent", { failure: Execution.Failure }),
	])

/** All model uses share saved attempts, call identity and confirmed usage. */
export const make = Effect.gen(function* () {
	const store = yield* Store
	const calls = yield* Calls
	const billing = yield* Billing
	const recovery = yield* Recovery.make
	const ledger = <A, R>(effect: Effect.Effect<A, BillingStorageError, R>) =>
		effect.pipe(
			Effect.mapError((error) =>
				error.retryable === true
					? Execution.StorageError.make({ cause: error })
					: error,
			),
		)
	const settle = (id: Execution.CallId, usage: Response.Usage) =>
		ledger(
			confirmed(usage)
				? billing.record(id, tokensOf(usage))
				: billing.unknown(id),
		)
	const run = Effect.fn("ModelCalls.run")(function* <A, E, R, BeforeE, BeforeR>(
		fence: Fence,
		step: string,
		input: Schema.Json,
		options: {
			readonly codec: Schema.Codec<A, Schema.Json>
			readonly retry?: "read_only" | "never"
			readonly send: (call: Execution.Call) => Effect.Effect<A, E, R>
			readonly usage: (value: A) => Response.Usage
			readonly beforeSend: Effect.Effect<void, BeforeE, BeforeR>
		},
	) {
		yield* calls.authorize(fence, "replay")
		const call = yield* options.retry === "never"
			? store.writeAttempt(fence, step, input, "never")
			: store.readAttempt(fence, step, input)
		const output = resultCodec(options.codec)
		const usage = yield* Ref.make(Option.none<Response.Usage>())
		const beforeSend = options.beforeSend.pipe(
			Effect.provide(yield* Effect.context<BeforeR>()),
		)
		const outcome = yield* calls.invoke(
			fence,
			{
				...call,
				onResult: (callId, saved) =>
					Schema.decodeUnknownEffect(output)(saved).pipe(
						Effect.flatMap((result) =>
							result._tag === "Completed"
								? settle(callId, options.usage(result.value))
								: ledger(billing.unknown(callId)),
						),
					),
			},
			() =>
				options.send(call).pipe(
					Effect.map((value) => ({ _tag: "Completed" as const, value })),
					Effect.catchCause((cause) => {
						const failure = ModelFailure.fromCause(cause)
						return Option.isSome(failure)
							? Effect.succeed({
									_tag: "NotSent" as const,
									failure: failure.value,
								})
							: Effect.failCause(cause)
					}),
					Effect.flatMap(Schema.encodeEffect(output)),
					Effect.onExit((result) =>
						Exit.isFailure(result)
							? Ref.get(usage).pipe(
									Effect.flatMap(
										Option.match({
											onNone: () => Effect.void,
											onSome: (usage) =>
												recovery.commit(fence.id, settle(call.id, usage)),
										}),
									),
								)
							: Effect.void,
					),
					Effect.provideService(CurrentReservation, (reserve) =>
						calls
							.reserve(
								fence,
								call,
								beforeSend.pipe(
									Effect.andThen(
										reserve.pipe(
											Effect.mapError((error) =>
												error._tag === "BillingStorageError" &&
												error.retryable === true
													? Execution.StorageError.make({ cause: error })
													: error,
											),
										),
									),
								),
							)
							.pipe(
								Effect.catchCause(
									(
										cause,
									): Effect.Effect<
										never,
										AiError.AiError | BillingStorageError | SpendingBlocked
									> => {
										if (Cause.hasInterruptsOnly(cause))
											return Effect.failCause(
												Cause.fromReasons<never>(
													Arr.filter(cause.reasons, Cause.isInterruptReason),
												),
											)
										const reason = cause.reasons[0]
										const blocked =
											cause.reasons.length === 1 &&
											reason?._tag === "Fail" &&
											Schema.is(SpendingBlocked)(reason.error)
										return Effect.gen(function* () {
											const failure = yield* recovery.record(
												cause,
												fence.id,
												blocked ? "forbidden" : category(cause),
											)
											return yield* ModelFailure.notSent(failure)
										})
									},
								),
							),
					),
					Effect.provideService(CurrentUsage, (value) =>
						Ref.set(usage, Option.some(value)),
					),
					Effect.provideService(CurrentCallIdentity, {
						id: call.id,
						executionId: fence.id,
						generation: fence.generation,
					}),
				),
			options.beforeSend,
		)
		if (outcome._tag === "Unknown")
			return yield* Execution.OutcomeUnknown.make({ callId: outcome.callId })
		const result = yield* Schema.decodeUnknownEffect(output)(outcome.result)
		if (result._tag === "NotSent") return yield* Effect.fail(result.failure)
		return {
			callId: outcome.callId,
			attempt: call.attempt,
			result: result.value,
		}
	})
	return { run }
})
