import { Bot, Chat } from "@openbot-build/core"
import { Effect, HashMap, Layer, Option, Ref } from "effect"
import { Gate } from "./Gate.ts"
import { Requests } from "./Requests.ts"
import { Work } from "./Work.ts"
import { toolJson } from "../plugins/ToolJson.ts"

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
	callId.startsWith("approved_")
		? Option.some(callId.slice("approved_".length))
		: Option.none()

/**
 * Answers each tool call that asks for approval, so a Turn never waits.
 * A tool that checked its capability itself has its answer in the Work of the Turn.
 * Any other tool that asks for approval is a `tools.call` capability. A pending call
 * keeps its name and parameters with its request, so it can run later.
 */
export const make = Effect.gen(function* () {
	const gate = yield* Gate
	const requests = yield* Requests
	return Chat.Approvals.of({
		decide: (input) =>
			Effect.gen(function* () {
				const work = yield* Effect.serviceOption(Work)
				if (Option.isNone(work))
					return Chat.Decision.Deny({ reason: "No Bot runs this work." })
				const organizationId = work.value.caller.organizationId
				const known = HashMap.get(
					yield* Ref.get(work.value.checks),
					input.toolCall.id,
				)
				const answer = Option.isSome(known)
					? known.value
					: yield* gate.check({
							capability: {
								action: "tools.call",
								target: input.toolCall.name,
							},
							reason: "The tool asks for approval before each call.",
							toolCallId: input.toolCall.id,
						})
				switch (answer._tag) {
					case "Allow":
						return Chat.Decision.Allow()
					case "Deny":
						return Chat.Decision.Deny({ reason: answer.reason })
					case "Pending": {
						const stored = yield* requests.find(organizationId, answer.request)
						// A plan runs in a new Turn when it is allowed, and a Code Mode program
						// goes on by itself, so their calls never run again.
						if (
							Option.isSome(stored) &&
							stored.value.request.capability.action !== "plans.run" &&
							stored.value.request.code === undefined
						) {
							// A host action names its own tool. It keeps its source, so the
							// action can be made again when the call runs.
							const source = Option.flatMap(
								yield* Effect.serviceOption(Bot.Context),
								(context) => Option.fromUndefinedOr(context.options.action),
							).pipe(
								Option.filter((action) => action.name === input.toolCall.name),
								Option.flatMap((action) =>
									Option.fromUndefinedOr(action.source),
								),
							)
							yield* requests.setCall(organizationId, answer.request, {
								name: input.toolCall.name,
								params: toolJson(input.toolCall.params ?? {}),
								...(Option.isSome(source) ? { source: source.value } : {}),
							})
						}
						return Chat.Decision.Pending({
							result: pendingResult(answer.request),
						})
					}
				}
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("A tool call could not be decided", cause).pipe(
						Effect.as(
							Chat.Decision.Deny({
								reason: "OpenBot could not check this now. Try again later.",
							}),
						),
					),
				),
			),
	})
})
export const layer = Layer.effect(Chat.Approvals, make)
