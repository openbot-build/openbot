import { Chunk } from "effect"
import { Option, HashMap, HashSet, Match, Context, Layer } from "effect"
import { type Session } from "@openbot-build/core"
import { type Prompt } from "effect/ai"

export interface Pending {
	readonly approvalId: string
	readonly toolCallId: string
	readonly toolCall: Prompt.ToolCallPart | undefined
}
export class Approvals extends Context.Service<
	Approvals,
	{
		readonly pending: (view: Session.View<{}>) => ReadonlyArray<Pending>
	}
>()("@openbot-build/platform/approvals/Approvals") {}

/** Reads native pending approvals from the committed conversation window. */
export const pending = (view: Session.View<{}>) => {
	let calls = HashMap.empty<string, Prompt.ToolCallPart>()
	let requests = HashMap.empty<string, string>()
	let requestOrder = Chunk.empty<string>()
	let resolved = HashSet.empty<string>()
	for (const message of view.state.value.memory.context.prompt.content) {
		Match.value(message).pipe(
			Match.when({ role: "assistant" }, (message) => {
				for (const part of message.content) {
					Match.value(part).pipe(
						Match.when({ type: "tool-call" as const }, (part) => {
							calls = HashMap.set(calls, part.id, part)
						}),
						Match.orElse(() => {}),
					)
					Match.value(part).pipe(
						Match.when({ type: "tool-approval-request" as const }, (part) => {
							if (!HashMap.has(requests, part.approvalId))
								requestOrder = Chunk.append(requestOrder, part.approvalId)
							requests = HashMap.set(requests, part.approvalId, part.toolCallId)
						}),
						Match.orElse(() => {}),
					)
				}
			}),
			Match.orElse(() => {}),
		)
		Match.value(message).pipe(
			Match.when({ role: "tool" }, (message) => {
				for (const part of message.content) {
					Match.value(part).pipe(
						Match.when({ type: "tool-result" as const }, (part) => {
							resolved = HashSet.add(resolved, part.id)
						}),
						Match.orElse(() => {}),
					)
					Match.value(part).pipe(
						Match.when({ type: "tool-approval-response" as const }, (part) => {
							const id = Option.getOrUndefined(
								HashMap.get(requests, part.approvalId),
							)
							if (id !== undefined) resolved = HashSet.add(resolved, id)
						}),
						Match.orElse(() => {}),
					)
				}
			}),
			Match.orElse(() => {}),
		)
	}
	return Array.from(requestOrder, (approvalId) => {
		const toolCallId = HashMap.getUnsafe(requests, approvalId)
		return {
			approvalId,
			toolCallId,
			toolCall: Option.getOrUndefined(HashMap.get(calls, toolCallId)),
		}
	}).filter(
		(item) =>
			!HashSet.has(resolved, item.toolCallId) && item.toolCall !== undefined,
	)
}

export const layer = Layer.succeed(Approvals, { pending })
