import { HashMap, HashSet, Match, Option } from "effect"
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

/** A tool approval request in the history that has no answer and no result yet. */
export interface Wait {
	readonly approvalId: string
	readonly toolCallId: string
	readonly toolCall: Prompt.ToolCallPart
}

/** The approval requests that still wait for an answer, in request order. */
export const waits = <P>(value: Timeline.Value<P>): ReadonlyArray<Wait> => {
	const messages = fullHistory(value).content
	const assistant = messages.flatMap((message) =>
		message.role === "assistant" ? message.content : [],
	)
	const tool = messages.flatMap((message) =>
		message.role === "tool" ? message.content : [],
	)
	const calls = HashMap.fromIterable(
		assistant.flatMap((part) =>
			part.type === "tool-call" ? [[part.id, part] as const] : [],
		),
	)
	const answered = HashSet.fromIterable(
		tool.flatMap((part) =>
			part.type === "tool-approval-response" ? [part.approvalId] : [],
		),
	)
	const results = HashSet.fromIterable(
		tool.flatMap((part) => (part.type === "tool-result" ? [part.id] : [])),
	)
	return assistant.flatMap((part) =>
		part.type === "tool-approval-request" &&
		!HashSet.has(answered, part.approvalId) &&
		!HashSet.has(results, part.toolCallId)
			? Option.toArray(
					Option.map(HashMap.get(calls, part.toolCallId), (toolCall) => ({
						approvalId: part.approvalId,
						toolCallId: part.toolCallId,
						toolCall,
					})),
				)
			: [],
	)
}
