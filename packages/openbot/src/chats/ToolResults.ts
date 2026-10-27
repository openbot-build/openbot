import { Execution, type ToolExecution } from "@openbot-build/domain"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { type Prompt } from "effect/ai"
import { outputCodec, stepId } from "./ToolSteps.ts"

/** A child end and its known outside result are separate facts. Keep both. */
export interface Saved extends Pick<
	ToolExecution.Record,
	"id" | "executionId" | "detached" | "status" | "failure" | "callId"
> {
	readonly position: Pick<ToolExecution.Record["position"], "item">
	readonly calls: ReadonlyArray<Execution.Call>
}

/** Helper calls belong to their own steps. Only this step gives the tool result. */
export const latestCall = (
	record: Pick<Saved, "position" | "callId">,
	calls: ReadonlyArray<Execution.Call>,
) => {
	const step = stepId(record.position.item, record.callId)
	const matches = Arr.filter(calls, (call) => call.step === step)
	return Arr.findFirst(
		matches,
		(call) => !Arr.some(matches, (other) => other.attempt > call.attempt),
	)
}

export const output = Effect.fn("ToolResults.output")(function* (
	saved: Saved,
	call: Pick<Prompt.ToolCallPart, "id" | "name">,
): Effect.fn.Return<
	typeof outputCodec.Type,
	Execution.Conflict | Schema.SchemaError
> {
	const base = { id: call.id, name: call.name, preliminary: false }
	if (saved.detached)
		return {
			...base,
			isFailure: false,
			result: {
				background: true,
				toolExecutionId: saved.id,
				executionId: saved.executionId,
			},
		}
	if (!Execution.isTerminal(saved.status))
		return yield* Execution.Conflict.make({ id: saved.executionId })
	const latest = latestCall(saved, saved.calls)
	const known =
		Option.isSome(latest) && latest.value.status === "completed"
			? yield* Schema.decodeEffect(outputCodec)(latest.value.result)
			: undefined
	if (
		known !== undefined &&
		(known.id !== call.id || known.name !== call.name || known.preliminary)
	)
		return yield* Execution.Conflict.make({ id: saved.executionId })
	if (saved.status === "completed") {
		if (known === undefined)
			return yield* Execution.Conflict.make({ id: saved.executionId })
		return known
	}
	const unknown = Option.exists(
		latest,
		(entry) =>
			entry.retry !== "read_only" &&
			entry.retry !== "local" &&
			(entry.status === "sending" || entry.status === "outcome_unknown"),
	)
	return {
		...base,
		isFailure: true,
		result: {
			executionId: saved.executionId,
			status: saved.status,
			failure: saved.failure,
			...(unknown ? { outcome: "unknown" } : {}),
			...(known === undefined
				? {}
				: { knownResult: yield* Schema.encodeEffect(outputCodec)(known) }),
		},
	}
})
