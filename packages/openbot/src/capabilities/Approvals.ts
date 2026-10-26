import { Bot, Chat } from "@openbot-build/core"
import {
	Cause,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	String as Str,
} from "effect"
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
	Str.startsWith("approved_")(callId)
		? Option.some(Str.slice("approved_".length)(callId))
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
				// The Bot plugin gives the Work to the Turns of a Bot. The approvals of core
				// cannot name it in their type, and a Turn without a Bot has none.
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
						yield* Effect.gen(function* () {
							const stored = yield* requests.find(
								organizationId,
								answer.request,
							)
							// A plan runs in a new Turn when it is allowed, and a Code Mode program
							// goes on by itself, so their calls never run again.
							if (
								Option.isSome(stored) &&
								stored.value.request.capability.action !== "plans.run" &&
								stored.value.request.code === undefined
							) {
								// A host action names its own tool. It keeps its source, so the
								// action can be made again when the call runs. Core gives the context
								// of the Bot only while a Bot runs the Turn.
								const source = Option.flatMap(
									yield* Effect.serviceOption(Bot.Context),
									(context) => Option.fromUndefinedOr(context.options.action),
								).pipe(
									Option.filter(
										(action) => action.name === input.toolCall.name,
									),
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
						}).pipe(
							// The request is made and waits for a decider, so the call is still
							// pending. Only the kept call is missing, so a storage failure here
							// does not turn it into a Deny.
							Effect.catchTag("BotStorageUnavailable", (error) =>
								Effect.logWarning(
									"The call that waits for a request could not be kept. It does not run by itself when the request is allowed.",
									error,
								),
							),
							Effect.annotateLogs({ request: answer.request }),
						)
						return Chat.Decision.Pending({
							result: pendingResult(answer.request),
						})
					}
				}
			}).pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.logWarning("A tool call could not be decided", cause).pipe(
								Effect.as(
									Chat.Decision.Deny({
										reason:
											"OpenBot could not check this now. Try again later.",
									}),
								),
							),
				),
				Effect.annotateLogs({
					toolCallId: input.toolCall.id,
					tool: input.toolCall.name,
				}),
			),
	})
})
export const layer = Layer.effect(Chat.Approvals, make)
