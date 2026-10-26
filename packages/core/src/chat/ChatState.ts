import {
	Array as Arr,
	HashMap,
	HashSet,
	Match,
	Option,
	Schema,
	pipe,
} from "effect"
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
/** Plugin data that the core keeps as it is. */
export const Opaque = Schema.declare(
	(_value: unknown): _value is unknown => true,
).annotate({ toCodecJson: () => undefined, toJsonSchema: () => ({}) })
/** The state of a Chat: the conversation and the data of the plugins with state scope. */
export const Value = <Fields extends Schema.Struct.Fields>(
	namespaces: Fields,
) =>
	Schema.StructWithRest(
		Schema.Struct({ ...namespaces, conversation: Conversation }),
		[Schema.Record(Schema.String, Opaque)],
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
	Arr.reduce(items, Prompt.empty, (prompt, entry) =>
		Prompt.concat(prompt, entry.content),
	)

/** Client tool calls in some Items that have no tool result yet, by call ID. */
export const unansweredCalls = (
	items: ReadonlyArray<Item.Entry>,
): HashMap.HashMap<string, Prompt.ToolCallPart> =>
	pipe(
		items,
		Arr.flatMap((entry) => entry.content.content),
		Arr.reduce(HashMap.empty<string, Prompt.ToolCallPart>(), (calls, message) =>
			Match.value(message).pipe(
				Match.when({ role: "assistant" }, (message) =>
					Arr.reduce(message.content, calls, (calls, part) =>
						part.type === "tool-call" && !part.providerExecuted
							? HashMap.set(calls, part.id, part)
							: calls,
					),
				),
				Match.when({ role: "tool" }, (message) =>
					Arr.reduce(message.content, calls, (calls, part) =>
						part.type === "tool-result"
							? HashMap.remove(calls, part.id)
							: calls,
					),
				),
				Match.orElse(() => calls),
			),
		),
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
	const assistant = Arr.flatMap(messages, (message) =>
		message.role === "assistant" ? message.content : [],
	)
	const tool = Arr.flatMap(messages, (message) =>
		message.role === "tool" ? message.content : [],
	)
	const answered = HashSet.fromIterable(
		Arr.flatMap(tool, (part) =>
			part.type === "tool-approval-response" ? [part.approvalId] : [],
		),
	)
	const results = HashSet.fromIterable(
		Arr.flatMap(tool, (part) => (part.type === "tool-result" ? [part.id] : [])),
	)
	return Arr.flatMap(assistant, (part) => {
		if (
			part.type !== "tool-approval-request" ||
			HashSet.has(answered, part.approvalId) ||
			HashSet.has(results, part.toolCallId)
		)
			return []
		return pipe(
			Arr.findFirst(
				assistant,
				(call): call is Prompt.ToolCallPart =>
					call.type === "tool-call" && call.id === part.toolCallId,
			),
			Option.map((toolCall) => ({ approvalId: part.approvalId, toolCall })),
			Option.toArray,
		)
	})
}

/**
 * The allowed calls in a prompt that have no result yet and whose tool is not in
 * `tools`. Effect AI would fail the whole step on such a call, so it gets a result
 * that says that it did not run.
 */
export const withoutTool = (
	prompt: Prompt.Prompt,
	tools: ReadonlyArray<string>,
): ReadonlyArray<Prompt.ToolCallPart> => {
	const messages = prompt.content
	const assistant = Arr.flatMap(messages, (message) =>
		message.role === "assistant" ? message.content : [],
	)
	const tool = Arr.flatMap(messages, (message) =>
		message.role === "tool" ? message.content : [],
	)
	const allowed = HashSet.fromIterable(
		Arr.flatMap(tool, (part) =>
			part.type === "tool-approval-response" && part.approved
				? [part.approvalId]
				: [],
		),
	)
	const results = HashSet.fromIterable(
		Arr.flatMap(tool, (part) => (part.type === "tool-result" ? [part.id] : [])),
	)
	return Arr.flatMap(assistant, (part) => {
		if (
			part.type !== "tool-approval-request" ||
			!HashSet.has(allowed, part.approvalId) ||
			HashSet.has(results, part.toolCallId)
		)
			return []
		return pipe(
			Arr.findFirst(
				assistant,
				(call): call is Prompt.ToolCallPart =>
					call.type === "tool-call" && call.id === part.toolCallId,
			),
			Option.filter((toolCall) => !tools.includes(toolCall.name)),
			Option.toArray,
		)
	})
}

/**
 * Puts the results of earlier tool calls first. Effect AI runs an approved call before the
 * model answers, but it gives the result after the answer. A provider needs each result
 * right after its call, so such a result moves in front of the new messages.
 */
export const resultsFirst = (prompt: Prompt.Prompt): Prompt.Prompt => {
	const calls = HashSet.fromIterable(
		Arr.flatMap(prompt.content, (message) =>
			message.role === "assistant"
				? Arr.flatMap(message.content, (part) =>
						part.type === "tool-call" ? [part.id] : [],
					)
				: [],
		),
	)
	const earlier = (part: Prompt.ToolMessagePart) =>
		part.type === "tool-result" && !HashSet.has(calls, part.id)
	const early = Arr.flatMap(prompt.content, (message) =>
		message.role === "tool" ? Arr.filter(message.content, earlier) : [],
	)
	if (early.length === 0) return prompt
	const rest = Arr.flatMap(
		prompt.content,
		(message): ReadonlyArray<Prompt.Message> => {
			if (message.role !== "tool") return [message]
			const kept = Arr.filter(message.content, (part) => !earlier(part))
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
