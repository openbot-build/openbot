import { HashMap, HashSet, Match, Schema } from "effect"
import { Prompt } from "effect/ai"
import type * as Item from "./Item.ts"
import * as ContextWindow from "../context/ContextWindow.ts"
import { PromptJson } from "../store/PromptCodec.ts"

/**
 * What the model sees: the messages since the last compaction. `closed` is true when
 * no Turn is in the middle of its work.
 */
export const Conversation = Schema.Struct({
	context: Schema.TaggedUnion({
		Prompt: { prompt: PromptJson },
		Native: { ...ContextWindow.Window.cases.Native.fields, prompt: PromptJson },
	}),
	closed: Schema.Boolean,
})
export type Conversation = typeof Conversation.Type
const opaque = Schema.declare(
	(_value: unknown): _value is unknown => true,
).annotate({ toCodecJson: () => undefined, toJsonSchema: () => ({}) })
/** The state of a Chat: the conversation and the data of the plugins with state scope. */
export const Value = <Fields extends Schema.Struct.Fields>(
	namespaces: Fields,
) =>
	Schema.StructWithRest(
		Schema.Struct({ ...namespaces, conversation: Conversation }),
		[Schema.Record(Schema.String, opaque)],
	)
export type Value<P = {}> = typeof Conversation extends never
	? never
	: { readonly conversation: Conversation; readonly [key: string]: unknown } & P

export const initial = <P>(plugins: P): Value<P> => ({
	...plugins,
	conversation: {
		context: ContextWindow.fromPrompt(Prompt.empty),
		closed: true,
	},
})

/** All the messages of some Items, in order. */
export const promptOf = (items: ReadonlyArray<Item.Entry>): Prompt.Prompt =>
	items.reduce(
		(prompt, entry) => Prompt.concat(prompt, entry.content),
		Prompt.empty,
	)

/** Client tool calls in some Items that have no tool result yet, by call ID. */
export const unansweredCalls = (
	items: ReadonlyArray<Item.Entry>,
): HashMap.HashMap<string, Prompt.ToolCallPart> =>
	items
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

/** A tool approval request in some Items that has no answer and no result yet. */
export interface OpenApproval {
	readonly approvalId: string
	readonly toolCall: Prompt.ToolCallPart
}

/** The approval requests in a prompt that have no answer yet, in request order. */
export const openApprovals = (
	prompt: Prompt.Prompt,
): ReadonlyArray<OpenApproval> => {
	const messages = prompt.content
	const assistant = messages.flatMap((message) =>
		message.role === "assistant" ? message.content : [],
	)
	const tool = messages.flatMap((message) =>
		message.role === "tool" ? message.content : [],
	)
	const answered = HashSet.fromIterable(
		tool.flatMap((part) =>
			part.type === "tool-approval-response" ? [part.approvalId] : [],
		),
	)
	const results = HashSet.fromIterable(
		tool.flatMap((part) => (part.type === "tool-result" ? [part.id] : [])),
	)
	return assistant.flatMap((part) => {
		if (
			part.type !== "tool-approval-request" ||
			HashSet.has(answered, part.approvalId) ||
			HashSet.has(results, part.toolCallId)
		)
			return []
		const toolCall = assistant.find(
			(call): call is Prompt.ToolCallPart =>
				call.type === "tool-call" && call.id === part.toolCallId,
		)
		return toolCall === undefined
			? []
			: [{ approvalId: part.approvalId, toolCall }]
	})
}

/**
 * Puts the results of earlier tool calls first. Effect AI runs an approved call before the
 * model answers, but it gives the result after the answer. A provider needs each result
 * right after its call, so such a result moves in front of the new messages.
 */
export const resultsFirst = (prompt: Prompt.Prompt): Prompt.Prompt => {
	const calls = HashSet.fromIterable(
		prompt.content.flatMap((message) =>
			message.role === "assistant"
				? message.content.flatMap((part) =>
						part.type === "tool-call" ? [part.id] : [],
					)
				: [],
		),
	)
	const earlier = (part: Prompt.ToolMessagePart) =>
		part.type === "tool-result" && !HashSet.has(calls, part.id)
	const early = prompt.content.flatMap((message) =>
		message.role === "tool" ? message.content.filter(earlier) : [],
	)
	if (early.length === 0) return prompt
	const rest = prompt.content.flatMap(
		(message): ReadonlyArray<Prompt.Message> => {
			if (message.role !== "tool") return [message]
			const kept = message.content.filter((part) => !earlier(part))
			return kept.length === 0
				? []
				: [Prompt.makeMessage("tool", { content: kept })]
		},
	)
	return Prompt.fromMessages([
		Prompt.makeMessage("tool", { content: early }),
		...rest,
	])
}
