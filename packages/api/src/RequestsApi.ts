import { CapabilityRequestId } from "./CapabilityRequestId.ts"
export { CapabilityRequestId } from "./CapabilityRequestId.ts"
import { BotAuth } from "./AuthApi.ts"
import { Authorize, Decision, GroupRequired, own } from "./Authorization.ts"
import { Chat, Turn } from "@openbot-build/core"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { BotErrors, BotId, Capability, Decider, GrantScope } from "./BotsApi.ts"
import * as AppExecution from "./AppExecution.ts"
import { RequestCode } from "./CodeRunsApi.ts"

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

export const ResolveRequest = Schema.Struct({
	expected: Schema.Natural,
	decision: Decision,
	/** How long an allow lasts. A deny with a scope is kept as a deny Grant. */
	scope: Schema.optionalKey(GrantScope),
	reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
	/** Keep this decision as a Rule in plain language for the Bot. */
	rule: Schema.optionalKey(
		Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
	),
})
export type ResolveRequest = typeof ResolveRequest.Type

export class RequestNotFound extends Schema.TaggedError<
	RequestNotFound,
	{ readonly brand: unique symbol }
>()("RequestNotFound", { request: CapabilityRequestId }) {}
export class RequestConflict extends Schema.TaggedError<
	RequestConflict,
	{ readonly brand: unique symbol }
>()("RequestConflict", { message: Schema.String }) {}
export const RequestErrors = [
	...BotErrors,
	RequestNotFound.pipe(HttpApiSchema.status(404)),
	RequestConflict.pipe(HttpApiSchema.status(409)),
] as const

export class RequestsApi extends HttpApiGroup.make("requests")
	.add(
		HttpApiEndpoint.get("listRequests", "/v1/requests", {
			query: {
				status: Schema.optionalKey(RequestStatus),
			},
			success: Schema.Array(CapabilityRequest),
			error: RequestErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the requests that wait for the caller, or that the caller answered.",
		),
		HttpApiEndpoint.get("getRequest", "/v1/requests/:requestId", {
			params: { requestId: CapabilityRequestId },
			success: CapabilityRequest,
			error: RequestErrors,
		}),
		HttpApiEndpoint.post("resolveRequest", "/v1/requests/:requestId", {
			params: { requestId: CapabilityRequestId },
			payload: ResolveRequest,
			success: CapabilityRequest,
			error: RequestErrors,
		}).annotate(
			OpenApi.Description,
			"Allows or denies a request. The Chat of the Bot gets the answer as a message at once. An allowed call runs then.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.annotate(GroupRequired, {
		read: [own("resolve", "Request")],
		write: [own("resolve", "Request")],
	})
	.middleware(Authorize)
	.middleware(BotAuth) {}
