import { Chat } from "@openbot-build/core"
import { Effect, Option, String as Str } from "effect"
import type { Gate } from "./Gate.ts"

/** What the Bot reads when a call waits for a decider. */
export const pendingNote =
	"This call waits for a decision. The answer comes back to this Chat as a message. Go on with other work, or end your answer now."

/** The tool result of a call that waits for a request. */
export const pendingResult = (request: string) => ({
	pending: request,
	note: pendingNote,
})

/** The ID of a call that a decider allowed, when it runs again in a later step. */
export const approvedCallId = (request: string) => "approved_" + request
/** The request of an allowed call that runs again, when the ID is one. */
export const approvedRequest = (callId: string): Option.Option<string> =>
	Str.startsWith("approved_")(callId)
		? Option.some(Str.slice("approved_".length)(callId))
		: Option.none()

/** The Gate saved any pending call with its request in the same transaction. */
export const durable = (gate: typeof Gate.Service) =>
	Chat.Approvals.of({
		decide: (input) =>
			Effect.gen(function* () {
				const known = yield* gate.answer(input.toolCall.id)
				const answer = Option.isSome(known)
					? known.value
					: yield* gate.check({
							capability: { action: "tools.call", target: input.toolCall.name },
							reason: "The tool asks for approval before each call.",
							site: { main: input.toolCall.id, path: [] },
						})
				switch (answer._tag) {
					case "Allow":
						return Chat.Decision.Allow()
					case "Deny":
						return Chat.Decision.Deny({ reason: answer.reason })
					case "Pending":
						return Chat.Decision.Pending({
							result: pendingResult(answer.request),
						})
				}
			}),
	})
