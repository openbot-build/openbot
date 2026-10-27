import { resultCodec } from "../models/ModelCalls.ts"
import {
	ChatState,
	type Item,
	ModelStep,
	ToolStep,
	type Turn,
} from "@openbot-build/core"
import type { Execution } from "@openbot-build/domain"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { Prompt } from "effect/ai"
import * as ToolResults from "./ToolResults.ts"
import { outputCodec, stepId } from "./ToolSteps.ts"

const modelCodec = resultCodec(Schema.toCodecJson(ModelStep.Result))

/** Saved children supply results even when the parent stopped before its checkpoint. */
export interface Child extends Omit<ToolResults.Saved, "position"> {
	readonly item: Item.Id
	readonly callId: string
}

/** Keep known work in Chat history before ending its execution. This never sends a call. */
export const items = Effect.fn("TurnEnd.items")(function* (
	turn: Turn.Record,
	history: ReadonlyArray<Item.Record>,
	calls: ReadonlyArray<Execution.Call>,
	failure: Execution.Failure | undefined,
	fallbackItem: Item.Id,
	children: ReadonlyArray<Child> = [],
) {
	const saved = turn.pendingStep
	const latest = (step: string) =>
		Arr.reduce(calls, Option.none<Execution.Call>(), (prior, call) =>
			call.step === step &&
			(Option.isNone(prior) || call.attempt > prior.value.attempt)
				? Option.some(call)
				: prior,
		)
	let model = saved?.model
	if (saved !== undefined && model === undefined) {
		const call = latest(`model:${saved.item}`)
		if (Option.isSome(call) && call.value.status === "completed") {
			const result = yield* Schema.decodeUnknownEffect(modelCodec)(
				call.value.result,
			)
			if (result._tag === "Completed") model = result.value
		}
	}
	let content = Prompt.concat(
		saved?.before ?? Prompt.empty,
		Prompt.concat(model?.output ?? Prompt.empty, saved?.after ?? Prompt.empty),
	)
	const prompt = Prompt.concat(ChatState.promptOf(history), content)
	for (const tool of ToolStep.pending(prompt)) {
		const child = Arr.findFirst(
			children,
			(child) => child.item === saved?.item && child.callId === tool.id,
		)
		if (Option.isSome(child)) {
			const output = yield* ToolResults.output(
				{ ...child.value, position: { item: child.value.item } },
				tool,
			)
			content = Prompt.concat(
				content,
				Prompt.make([
					{
						role: "tool",
						content: [
							Prompt.toolResultPart({
								...output,
								result: output.result,
								providerExecuted: false,
							}),
						],
					},
				]),
			)
			continue
		}
		const found =
			saved === undefined
				? Option.none<Execution.Call>()
				: latest(stepId(saved.item, tool.id))
		if (Option.isSome(found) && found.value.status === "completed") {
			const output = yield* Schema.decodeEffect(outputCodec)(found.value.result)
			if (
				output.id !== tool.id ||
				output.name !== tool.name ||
				output.preliminary
			)
				return yield* Effect.die(
					"The saved tool result does not match the call.",
				)
			content = Prompt.concat(
				content,
				Prompt.make([
					{
						role: "tool",
						content: [
							Prompt.toolResultPart({
								...output,
								result: output.result,
								providerExecuted: false,
							}),
						],
					},
				]),
			)
		} else {
			const unknown =
				Option.isSome(found) &&
				(found.value.status === "sending" ||
					found.value.status === "outcome_unknown")
			content = Prompt.concat(
				content,
				Prompt.make([
					{
						role: "tool",
						content: [
							Prompt.toolResultPart({
								id: tool.id,
								name: tool.name,
								isFailure: true,
								providerExecuted: false,
								result: {
									outcome: unknown ? "unknown" : "interrupted",
									...(failure === undefined
										? {}
										: { errorId: failure.errorId }),
									message: unknown
										? "The outside result is unknown. Check it before any new write."
										: "The Turn ended before this call finished.",
								},
							}),
						],
					},
				]),
			)
		}
	}
	if (content.content.length === 0) return []
	return [
		{
			id: saved?.item ?? fallbackItem,
			content,
			origin: {
				chat: turn.chat,
				turn: turn.id,
				step: saved?.step ?? turn.steps,
			},
		},
	]
})
