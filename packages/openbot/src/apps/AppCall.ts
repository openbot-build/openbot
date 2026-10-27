import { AppCalls, Execution } from "@openbot-build/domain"
import { Client } from "@openbot-build/protocol"
import { Effect, Schema } from "effect"
import { Records } from "../errors/Records.ts"
import { Calls } from "../execution/Calls.ts"
import * as Recovery from "../execution/Recovery.ts"
import { Store, type Fence } from "../execution/Store.ts"
import { json, jsonObject } from "./AppResults.ts"

/** Each input round has its own call. A continuation never repeats the first request. */
export const Input = Schema.Struct({
	round: Schema.Natural,
	source: AppCalls.Source,
	arguments: Schema.JsonObject,
	readOnly: Schema.Boolean,
	continuation: Schema.optionalKey(
		Schema.Struct({
			request: Schema.JsonObject,
			responses: Schema.JsonObject,
		}),
	),
})
export type Input = typeof Input.Type
const inputCodec = Schema.toCodecJson(Input)
const outputCodec = Schema.toCodecJson(AppCalls.Outcome)
export const stepId = (round: number) => `app:${round}`

/** These protocol errors prove that no unknown write is being hidden. */
const known = (error: unknown): Execution.Failure["category"] | undefined => {
	if (
		Schema.is(Client.PermissionDenied)(error) ||
		Schema.is(Client.AuthorizationRequired)(error)
	)
		return "forbidden"
	if (Schema.is(Client.ToolFailure)(error)) return "external"
	if (Schema.is(Client.ClientError)(error)) {
		switch (error.reason) {
			case "Schema":
				return "invalid"
			case "UnsupportedCapability":
			case "ConnectionChanged":
			case "PolicyUnavailable":
			case "InputUnavailable":
				return "unavailable"
			default:
				return undefined
		}
	}
	return undefined
}

/** App requests use the common intent, result, retry and error records. */
export const make = Effect.gen(function* () {
	const store = yield* Store
	const calls = yield* Calls
	const errors = yield* Records
	const recovery = yield* Recovery.make
	const invoke = Effect.fn("AppCall.invoke")(function* <E, R, CheckE, CheckR>(
		fence: Fence,
		input: Input,
		operation: Effect.Effect<Client.OperationResult<unknown>, E, R>,
		beforeSend: Effect.Effect<void, CheckE, CheckR>,
	) {
		if ((input.round === 0) !== (input.continuation === undefined))
			return yield* Execution.Conflict.make({ id: fence.id })
		const body = yield* Schema.encodeEffect(inputCodec)(input)
		const call = input.readOnly
			? yield* store.readAttempt(fence, stepId(input.round), body)
			: yield* store.writeAttempt(fence, stepId(input.round), body)
		const send = operation.pipe(
			Effect.flatMap(
				(result): Effect.Effect<AppCalls.Outcome, Schema.SchemaError> =>
					result._tag === "Completed"
						? json(result.result).pipe(
								Effect.map((result) => ({ _tag: "Completed", result })),
							)
						: jsonObject(result.result).pipe(
								Effect.map((request) => ({ _tag: "InputRequired", request })),
							),
			),
			Effect.catchCause(
				(
					cause,
				): Effect.Effect<
					AppCalls.Outcome,
					E | Schema.SchemaError | Execution.StorageError
				> => {
					const reason = cause.reasons[0]
					const category =
						cause.reasons.length === 1 && reason?._tag === "Fail"
							? known(reason.error)
							: undefined
					// An unknown write, a bad response or a transport failure stays a failure
					// until Calls records it. Never turn it into a completed App result.
					if (category === undefined) return Effect.failCause(cause)
					return recovery
						.commit(fence.id, errors.record(cause, category, fence.id))
						.pipe(
							Effect.map((failure): AppCalls.Outcome => ({
								_tag: "Failed",
								failure,
							})),
						)
				},
			),
			Effect.flatMap(Schema.encodeEffect(outputCodec)),
		)
		const outcome = yield* calls.invoke(fence, call, () => send, beforeSend)
		if (outcome._tag === "Unknown") return outcome
		return {
			...outcome,
			result: yield* Schema.decodeEffect(outputCodec)(outcome.result),
		}
	})
	return { invoke }
})
