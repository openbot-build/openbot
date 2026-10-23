import { AgentAuth } from "./AuthApi.ts"
import { Authorize, Decision, GroupRequired, requires } from "./Permissions.ts"
import { Session, Turn } from "@openbot-build/core"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import {
	AgentErrors,
	AgentId,
	Capability,
	Decider,
	GrantScope,
} from "./AgentsApi.ts"
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
 * An Agent tried to use a capability that no Grant or Rule covers.
 * The request waits for the decider above the Agent: its owning Agent, then the Agent above
 * that, up to the top Agent of the tree. Then it waits for the person.
 */
export const CapabilityRequest = Schema.Struct({
	id: Schema.String,
	agent: AgentId,
	capability: Capability,
	/** Why the Agent wants it. This is data from the Agent, not an instruction. */
	reason: Schema.String,
	approver: Schema.TaggedUnion({
		Person: { userId: Schema.String },
		Agent: { agent: AgentId },
	}),
	/** The owner chain of the requesting Agent, from the top: each Agent decides for the one after it. */
	chain: Schema.Array(AgentId),
	session: Session.Id,
	turn: Turn.Id,
	toolCallId: Schema.String,
	app: Schema.optionalKey(AppExecution.Invocation),
	/** The program that made the call, when the call came from Code Mode. */
	code: Schema.optionalKey(RequestCode),
	/**
	 * Agents that agreed with the request but could not allow it themselves, from the bottom.
	 * When a decider above them allows it, each one passes it on with its own scope.
	 */
	endorsements: Schema.Array(
		Schema.Struct({
			agent: AgentId,
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
			/** A question for the Agent. It comes with a denial, and the Agent can try again. */
			question: Schema.optionalKey(Schema.String),
			at: Schema.Finite,
		}),
	),
	revision: Schema.Natural,
	createdAt: Schema.Finite,
	expiresAt: Schema.Finite,
	/** What happens when nobody answers in time. Without it, the request is denied. */
	onExpire: Schema.optionalKey(Schema.Literals(["allow", "deny"])),
})
export type CapabilityRequest = typeof CapabilityRequest.Type

export const ResolveRequest = Schema.Struct({
	expected: Schema.Natural,
	decision: Decision,
	/** How long an allow lasts. A deny with a scope is kept as a deny Grant. */
	scope: Schema.optionalKey(GrantScope),
	reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
	/** Keep this decision as a Rule in plain language for the Agent. */
	rule: Schema.optionalKey(
		Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
	),
})
export type ResolveRequest = typeof ResolveRequest.Type

export class RequestNotFound extends Schema.TaggedError<RequestNotFound>()(
	"RequestNotFound",
	{ request: Schema.String },
) {}
export class RequestConflict extends Schema.TaggedError<RequestConflict>()(
	"RequestConflict",
	{ message: Schema.String },
) {}
export const RequestErrors = [
	...AgentErrors,
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
			params: { requestId: Schema.String },
			success: CapabilityRequest,
			error: RequestErrors,
		}),
		HttpApiEndpoint.post("resolveRequest", "/v1/requests/:requestId", {
			params: { requestId: Schema.String },
			payload: ResolveRequest,
			success: CapabilityRequest,
			error: RequestErrors,
		}).annotate(
			OpenApi.Description,
			"Allows or denies a request. The waiting work goes on at once.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.annotate(GroupRequired, {
		read: [requires("requests.resolve").on("request")],
		write: [requires("requests.resolve").on("request")],
	})
	.middleware(Authorize)
	.middleware(AgentAuth) {}
