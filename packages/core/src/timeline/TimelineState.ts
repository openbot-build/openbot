import { Chunk, HashMap, HashSet, Match, Option, Schema } from "effect"
import { Prompt } from "effect/ai"
import type * as Item from "./Item.ts"
import type * as Timeline from "./Timeline.ts"
import * as ContextWindow from "../context/ContextWindow.ts"

export const initial = <P>(plugins: P): Timeline.Value<P> => ({
	...plugins,
	conversation: {
		history: [],
		context: ContextWindow.fromPrompt(Prompt.empty),
		closed: true,
	},
})
export const fullHistory = <P>(value: Timeline.Value<P>): Prompt.Prompt =>
	value.conversation.history.reduce(
		(prompt, entry) => Prompt.concat(prompt, entry.content),
		Prompt.empty,
	)

/** Client tool calls in the history that have no tool result yet, by call ID. */
export const unansweredCalls = (
	history: ReadonlyArray<Item.Record>,
): HashMap.HashMap<string, Prompt.ToolCallPart> =>
	history
		.flatMap((entry) => entry.content.content)
		.reduce(
			(calls, message) =>
				Match.value(message).pipe(
					Match.when({ role: "assistant" }, (message) =>
						message.content.reduce(
							(calls, part) =>
								part.type === "tool-call" && !part.providerExecuted
									? HashMap.set(calls, part.id, part)
									: calls,
							calls,
						),
					),
					Match.when({ role: "tool" }, (message) =>
						message.content.reduce(
							(calls, part) =>
								part.type === "tool-result"
									? HashMap.remove(calls, part.id)
									: calls,
							calls,
						),
					),
					Match.orElse(() => calls),
				),
			HashMap.empty<string, Prompt.ToolCallPart>(),
		)

/** In coherent history, no client tool call is still waiting for a result. */
export const coherent = <P>(value: Timeline.Value<P>): boolean =>
	value.conversation.closed &&
	HashMap.isEmpty(unansweredCalls(value.conversation.history))

interface ToolOccurrence {
	readonly call: Prompt.ToolCallPart
	readonly result?: Prompt.ToolResultPart
}
interface ToolState {
	readonly calls: HashMap.HashMap<string, Prompt.ToolCallPart>
	readonly occurrences: HashMap.HashMap<string, ReadonlyArray<ToolOccurrence>>
	readonly pending: HashSet.HashSet<string>
}
const toolState = (prompt: Prompt.Prompt): ToolState => {
	let calls = HashMap.empty<string, Prompt.ToolCallPart>()
	let occurrences = HashMap.empty<string, ReadonlyArray<ToolOccurrence>>()
	let pending = HashSet.empty<string>()
	for (const message of prompt.content)
		Match.value(message).pipe(
			Match.when({ role: "assistant" }, (message) => {
				for (const part of message.content)
					Match.value(part).pipe(
						Match.when({ type: "tool-call" }, (part) => {
							if (part.providerExecuted !== true) {
								calls = HashMap.set(calls, part.id, part)
								occurrences = HashMap.set(occurrences, part.id, [
									...Option.getOrElse(
										HashMap.get(occurrences, part.id),
										() => [],
									),
									{ call: part },
								])
								pending = HashSet.add(pending, part.id)
							}
						}),
						Match.orElse(() => {}),
					)
			}),
			Match.when({ role: "tool" }, (message) => {
				for (const part of message.content)
					Match.value(part).pipe(
						Match.when({ type: "tool-result" }, (part) => {
							pending = HashSet.remove(pending, part.id)
							const entries = Option.getOrElse(
								HashMap.get(occurrences, part.id),
								() => [],
							)
							const latest = entries.at(-1)
							if (latest !== undefined)
								occurrences = HashMap.set(occurrences, part.id, [
									...entries.slice(0, -1),
									{ ...latest, result: part },
								])
						}),
						Match.orElse(() => {}),
					)
			}),
			Match.orElse(() => {}),
		)
	return { calls, occurrences, pending }
}
const unavailable = (call: Prompt.ToolCallPart) =>
	Prompt.toolResultPart({
		id: call.id,
		name: call.name,
		isFailure: true,
		providerExecuted: false,
		result:
			"The tool result is unavailable because its execution context ended. Observe the original operation before taking another action; do not resubmit it.",
	})
const sameCall = Schema.toEquivalence(Prompt.ToolCallPart)
const matchingOccurrences = (
	call: Prompt.ToolCallPart,
	state: ToolState,
): ReadonlyArray<ToolOccurrence> =>
	Option.getOrElse(HashMap.get(state.occurrences, call.id), () => []).filter(
		(candidate) => sameCall(candidate.call, call),
	)
const originalResult = (
	call: Prompt.ToolCallPart,
	source: ToolState,
	target: ToolState,
) => {
	const matches = matchingOccurrences(call, source)
	const result = matches.length === 1 ? matches[0]?.result : undefined
	// Context has no Item provenance: both sides must identify exactly one occurrence.
	return result !== undefined && matchingOccurrences(call, target).length === 1
		? result
		: unavailable(call)
}
const resultPrompt = (
	parts: ReadonlyArray<Prompt.ToolResultPart>,
): Prompt.Prompt =>
	Prompt.make(parts.length === 0 ? [] : [{ role: "tool", content: parts }])
/** Close retained client calls as observations only, without invoking their handlers. */
export const finishToolCalls =
	(options: { readonly item: Item.Id; readonly origin?: Item.Origin }) =>
	<P>(value: Timeline.Value<P>): Timeline.Value<P> => {
		const history = toolState(fullHistory(value))
		const context = toolState(value.conversation.context.prompt)
		if (
			HashSet.size(history.pending) === 0 &&
			HashSet.size(context.pending) === 0
		)
			return value
		const historyResult = resultPrompt(
			Array.from(history.pending, (id) =>
				originalResult(HashMap.getUnsafe(history.calls, id), context, history),
			),
		)
		const contextResult = resultPrompt(
			Array.from(context.pending, (id) =>
				originalResult(HashMap.getUnsafe(context.calls, id), history, context),
			),
		)
		return {
			...value,
			conversation: {
				...value.conversation,
				history:
					historyResult.content.length === 0
						? value.conversation.history
						: [
								...value.conversation.history,
								{
									id: options.item,
									content: historyResult,
									...(options.origin === undefined
										? {}
										: { origin: options.origin }),
								},
							],
				context: ContextWindow.append(
					value.conversation.context,
					contextResult,
				),
			},
		}
	}

export interface Wait {
	readonly approvalId: string
	readonly toolCallId: string
	readonly toolCall: Prompt.ToolCallPart
	readonly occurrence: number
}
/** Requests bind to a tool occurrence, not every call with the same provider ID. */
export const waits = <P>(value: Timeline.Value<P>): ReadonlyArray<Wait> => {
	interface Call {
		readonly toolCall: Prompt.ToolCallPart
		readonly occurrence: number
		readonly ordinal: number
	}
	let calls = HashMap.empty<string, Call>()
	let requests = HashMap.empty<string, Call>()
	let order = Chunk.empty<string>()
	let resolved = HashSet.empty<number>()
	let ordinal = 0
	for (const entry of value.conversation.history) {
		for (const message of entry.content.content)
			Match.value(message).pipe(
				Match.when({ role: "assistant" }, (message) => {
					for (const part of message.content)
						Match.value(part).pipe(
							Match.when({ type: "tool-call" }, (part) => {
								const prior = Option.getOrUndefined(HashMap.get(calls, part.id))
								calls = HashMap.set(calls, part.id, {
									toolCall: part,
									occurrence: prior === undefined ? 0 : prior.occurrence + 1,
									ordinal: ordinal++,
								})
							}),
							Match.when({ type: "tool-approval-request" }, (part) => {
								const call = Option.getOrUndefined(
									HashMap.get(calls, part.toolCallId),
								)
								if (
									call === undefined ||
									HashMap.has(requests, part.approvalId)
								)
									return
								order = Chunk.append(order, part.approvalId)
								requests = HashMap.set(requests, part.approvalId, call)
							}),
							Match.orElse(() => {}),
						)
				}),
				Match.when({ role: "tool" }, (message) => {
					for (const part of message.content)
						Match.value(part).pipe(
							Match.when({ type: "tool-result" }, (part) => {
								const call = Option.getOrUndefined(HashMap.get(calls, part.id))
								if (call !== undefined)
									resolved = HashSet.add(resolved, call.ordinal)
							}),
							Match.when({ type: "tool-approval-response" }, (part) => {
								const call = Option.getOrUndefined(
									HashMap.get(requests, part.approvalId),
								)
								if (call !== undefined)
									resolved = HashSet.add(resolved, call.ordinal)
							}),
							Match.orElse(() => {}),
						)
				}),
				Match.orElse(() => {}),
			)
	}
	return Array.from(order).flatMap((approvalId) => {
		const call = HashMap.getUnsafe(requests, approvalId)
		const latest = HashMap.getUnsafe(calls, call.toolCall.id)
		return call.toolCall.providerExecuted === true ||
			HashSet.has(resolved, call.ordinal) ||
			latest.ordinal !== call.ordinal
			? []
			: [
					{
						approvalId,
						toolCallId: call.toolCall.id,
						toolCall: call.toolCall,
						occurrence: call.occurrence,
					},
				]
	})
}
