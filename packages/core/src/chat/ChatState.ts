import {
	Array as Arr,
	HashMap,
	Match,
	Order,
	Number as Num,
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
): HashMap.HashMap<string, Prompt.ToolCallPart> => pendingCalls(promptOf(items))

/** Local calls must have a saved result before the next model request. */
export const pendingCalls = (
	prompt: Prompt.Prompt,
): HashMap.HashMap<string, Prompt.ToolCallPart> =>
	pipe(
		prompt.content,
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

/** One occurrence of a tool call. Reusing its ID starts a new state. */
interface ToolCallState {
	readonly call: Prompt.ToolCallPart
	readonly order: number
	readonly done: boolean
	readonly request?: Prompt.ToolApprovalRequestPart
	readonly answer?: Prompt.ToolApprovalResponsePart
}

/** Approval state belongs to the latest call occurrence, not to all uses of its ID. */
export const toolCallStates = (prompt: Prompt.Prompt) => {
	let calls = HashMap.empty<string, ToolCallState>()
	let order = 0
	for (const message of prompt.content) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "tool-call") {
					calls = HashMap.set(calls, part.id, {
						call: part,
						order: order++,
						done: false,
					})
				} else if (part.type === "tool-approval-request") {
					const requestOrder = order++
					calls = HashMap.modify(calls, part.toolCallId, (current) => ({
						call: current.call,
						done: current.done,
						order: requestOrder,
						request: part,
					}))
				}
			}
		} else if (message.role === "tool") {
			for (const part of message.content) {
				if (part.type === "tool-result") {
					calls = HashMap.modify(calls, part.id, (current) => ({
						...current,
						done: true,
					}))
				} else if (part.type === "tool-approval-response") {
					calls = HashMap.map(calls, (current) =>
						current.request?.approvalId === part.approvalId
							? { ...current, answer: part }
							: current,
					)
				}
			}
		}
	}
	return calls
}

/** The current approval requests without an answer or a result, in request order. */
export const openApprovals = (
	prompt: Prompt.Prompt,
): ReadonlyArray<OpenApproval> =>
	pipe(
		Arr.fromIterable(HashMap.values(toolCallStates(prompt))),
		Arr.filter(
			(current) =>
				!current.done &&
				current.request !== undefined &&
				current.answer === undefined,
		),
		Arr.sort(
			Order.mapInput(Num.Order, (current: ToolCallState) => current.order),
		),
		Arr.flatMap((current) =>
			current.request === undefined
				? []
				: [{ approvalId: current.request.approvalId, toolCall: current.call }],
		),
	)
