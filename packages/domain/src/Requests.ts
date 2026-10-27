import { Chat, Turn } from "@openbot-build/core"
import * as Execution from "./Execution.ts"
import { Schema } from "effect"
import { CapabilityRequestId } from "./CapabilityRequestId.ts"
export { CapabilityRequestId } from "./CapabilityRequestId.ts"
import { BotId, Capability, Decider, GrantScope } from "./Bots.ts"
import { Decision } from "./Authorization.ts"
import * as AppExecution from "./AppCalls.ts"
import { RequestCode } from "./CodeRuns.ts"

/** Only a `pending` request waits for a decision. */
export const RequestStatus = Schema.Literals([
	"pending",
	"allowed",
	"denied",
	"expired",
	"cancelled",
])
export type RequestStatus = typeof RequestStatus.Type

/**
 * A Bot tried to use a capability that no Grant or Rule covers.
 * The request waits for the decider above the Bot: its owning Bot, then the Bot above
 * that, up to the top Bot of the tree. Then it waits for the person.
 * The Bot does not wait. Its tool call gets a pending result, and the answer comes
 * back to its Chat as a message later. When the call is allowed, it runs then.
 */

export const CapabilityRequest = Schema.Struct({
	id: CapabilityRequestId,
	bot: BotId,
	capability: Capability,
	/** Why the Bot wants it. This is data from the Bot, not an instruction. */
	reason: Schema.String,
	approver: Schema.TaggedUnion({
		Person: { userId: Schema.String },
		Bot: { bot: BotId },
	}),
	/** The owner chain of the requesting Bot, from the top: each Bot decides for the one after it. */
	chain: Schema.Array(BotId),
	chat: Chat.Id,
	turn: Turn.Id,
	toolCallId: Schema.String,
	app: Schema.optionalKey(AppExecution.Invocation),
	/** The program that made the call, when the call came from Code Mode. */
	code: Schema.optionalKey(RequestCode),
	/**
	 * Bots that agreed with the request but could not allow it themselves, from the bottom.
	 * When a decider above them allows it, each one passes it on with its own scope.
	 */
	endorsements: Schema.Array(
		Schema.Struct({
			bot: BotId,
			scope: GrantScope,
			reason: Schema.optionalKey(Schema.String),
		}),
	),
	status: RequestStatus,
	decision: Schema.NullOr(
		Schema.Struct({
			by: Decider,
			scope: Schema.optionalKey(GrantScope),
			reason: Schema.optionalKey(Schema.String),
			/** A question for the Bot. It comes with a denial, and the Bot can try again. */
			question: Schema.optionalKey(Schema.String),
			at: Schema.Finite,
		}),
	),
	revision: Schema.Natural,
	createdAt: Schema.Finite,
	expiresAt: Schema.Finite,
	/** What happens when nobody answers in time. Without it, the request is denied. */
	onExpire: Schema.optionalKey(Decision),
})
export type CapabilityRequest = typeof CapabilityRequest.Type

export class RequestNotFound extends Schema.TaggedError<
	RequestNotFound,
	{ readonly brand: unique symbol }
>()("RequestNotFound", { request: CapabilityRequestId }) {}
export class RequestConflict extends Schema.TaggedError<
	RequestConflict,
	{ readonly brand: unique symbol }
>()("RequestConflict", { message: Schema.String }) {}

/** A retry uses the same key and decision input. */
export const PersonDecision = Schema.Struct({
	commandKey: Execution.CommandKey,
	expected: Schema.Natural,
	decision: Decision,
	scope: Schema.optionalKey(GrantScope),
	reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
	rule: Schema.optionalKey(
		Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
	),
})
export type PersonDecision = typeof PersonDecision.Type
