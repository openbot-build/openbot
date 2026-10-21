import { Array, Context, HashMap, HashSet, Layer, Option } from "effect"
import { type Session } from "@openbot-build/core"
import { type Prompt } from "effect/ai"

export interface Pending {
	readonly approvalId: string
	readonly toolCallId: string
	readonly toolCall: Prompt.ToolCallPart
}
export class Approvals extends Context.Service<
	Approvals,
	{
		readonly pending: (view: Session.View<{}>) => ReadonlyArray<Pending>
	}
>()("@openbot-build/platform/approvals/Approvals") {}

/** Reads native pending approvals from the committed conversation window. */
export const pending = (view: Session.View<{}>): ReadonlyArray<Pending> => {
	const messages = view.state.value.memory.context.prompt.content
	const assistantParts = messages.flatMap((message) =>
		message.role === "assistant" ? message.content : [],
	)
	const toolParts = messages.flatMap((message) =>
		message.role === "tool" ? message.content : [],
	)
	const calls = HashMap.fromIterable(
		assistantParts.flatMap((part) =>
			part.type === "tool-call" ? [[part.id, part] as const] : [],
		),
	)
	const requests = assistantParts.flatMap((part) =>
		part.type === "tool-approval-request" ? [part] : [],
	)
	// A later request with the same approval ID replaces the earlier tool call ID.
	const requested = HashMap.fromIterable(
		requests.map((part) => [part.approvalId, part.toolCallId] as const),
	)
	const resolved = HashSet.fromIterable(
		toolParts.flatMap((part) =>
			part.type === "tool-result"
				? [part.id]
				: part.type === "tool-approval-response"
					? Option.toArray(HashMap.get(requested, part.approvalId))
					: [],
		),
	)
	return Array.dedupe(requests.map((part) => part.approvalId)).flatMap(
		(approvalId) => {
			const toolCallId = HashMap.getUnsafe(requested, approvalId)
			return HashSet.has(resolved, toolCallId)
				? []
				: Option.toArray(
						Option.map(HashMap.get(calls, toolCallId), (toolCall) => ({
							approvalId,
							toolCallId,
							toolCall,
						})),
					)
		},
	)
}

export const layer = Layer.succeed(Approvals, { pending })
