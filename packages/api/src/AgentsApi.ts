import { AccountAuth, AgentAuth, NoStore, ReturnTo } from "./AuthApi.ts"
import {
	Authorize,
	Decision,
	GroupRequired,
	PermissionErrors,
} from "./Permissions.ts"
import { Config, Item, Session, Turn } from "@openbot-build/core"
import * as AgentMemory from "./AgentMemory.ts"
import { Name } from "./Name.ts"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { PlanApproval } from "./PlanApproval.ts"
import {
	InvitationId,
	InvitationInvalid,
	InvitationNotFound,
	InvitationStatus,
} from "./Invitation.ts"

export const AgentId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/AgentId"))
export type AgentId = typeof AgentId.Type

/**
 * Who owns an Agent.
 * A member owns their own Agents. The organization owns shared Agents.
 * A Session owns a Session Agent: the Session Agent lives as long as that Session.
 * `agent` is the Agent of that Session.
 * An Agent can own lasting Agents too. `userId` is the member at the top of this tree.
 * It is `null` when the organization owns the Agent at the top.
 */
export const AgentOwner = Schema.TaggedUnion({
	Member: { userId: Schema.String },
	Organization: {},
	Session: { userId: Schema.String, session: Session.Id, agent: AgentId },
	Agent: { agent: AgentId, userId: Schema.NullOr(Schema.String) },
})
export type AgentOwner = typeof AgentOwner.Type

export const AgentKind = Schema.Literals(["persistent", "session"])

/** An Agent in another organization. */
export const AgentSource = Schema.Struct({
	organizationId: Schema.String,
	agent: AgentId,
})
export type AgentSource = typeof AgentSource.Type

/** A person who uses a shared Agent in their own organization. */
export const AgentMember = Schema.Struct({
	userId: Schema.String,
	/** The organization where the person uses the Agent. */
	organizationId: Schema.String,
	/** The Agent in that organization that uses this Agent. */
	linked: AgentId,
	joinedAt: Schema.Finite,
})
export type AgentMember = typeof AgentMember.Type
export type AgentKind = typeof AgentKind.Type

export const Agent = Schema.Struct({
	id: AgentId,
	kind: AgentKind,
	owner: AgentOwner,
	name: Schema.String,
	role: Schema.String,
	/** The lasting instructions of the Agent, like a job description. */
	instructions: Schema.String,
	/** The default model for new Sessions of this Agent. */
	model: Schema.optionalKey(Config.Selection),
	/** How the plans of this Agent are approved. Without it, the settings of the member count. */
	planApproval: Schema.optionalKey(PlanApproval),
	/**
	 * The Agent that this Agent uses, when someone shared it with the owner. The name,
	 * role, instructions and model always come from that Agent, and only its people change them.
	 */
	source: Schema.optionalKey(AgentSource),
	archived: Schema.Boolean,
	revision: Schema.Natural,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type Agent = typeof Agent.Type

const Text = Schema.String.check(Schema.isMaxLength(20000))

export const CreateAgentRequest = Schema.Struct({
	name: Name,
	role: Schema.String.check(Schema.isMaxLength(500)),
	instructions: Text,
	model: Schema.optionalKey(Config.Selection),
	planApproval: Schema.optionalKey(PlanApproval),
	/** Shared Agents belong to the organization. Other Agents belong to the caller. */
	shared: Schema.optionalKey(Schema.Boolean),
	/** The Agent that owns the new Agent. You cannot use it together with `shared`. */
	agent: Schema.optionalKey(AgentId),
})
export type CreateAgentRequest = typeof CreateAgentRequest.Type

export const UpdateAgentRequest = Schema.Struct({
	expected: Schema.Natural,
	name: Schema.optionalKey(Name),
	role: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
	instructions: Schema.optionalKey(Text),
	model: Schema.optionalKey(Schema.NullOr(Config.Selection)),
	/** `null` makes the Agent follow the settings of the member again. */
	planApproval: Schema.optionalKey(Schema.NullOr(PlanApproval)),
	archived: Schema.optionalKey(Schema.Boolean),
})
export type UpdateAgentRequest = typeof UpdateAgentRequest.Type

export const PromoteAgentRequest = Schema.Struct({
	expected: Schema.Natural,
	/** The Agent that owns the promoted Agent. Without it, the caller owns it. */
	agent: Schema.optionalKey(AgentId),
})
export type PromoteAgentRequest = typeof PromoteAgentRequest.Type

/**
 * What a capability is: an action, the thing it acts on, and optional exact arguments.
 * `target` is `*` for every target.
 */
export const CapabilityAction = Schema.Literals([
	"tools.call",
	"apps.call",
	"agents.spawn",
	"agents.create",
	"agents.promote",
	"agents.delegate",
	/** An Agent in plan mode wants to carry out its plan. The target is the Session. */
	"plans.run",
	/** An Agent posts to a chat of a Channel. The target is the Channel. */
	"channels.send",
])
export type CapabilityAction = typeof CapabilityAction.Type
export const Capability = Schema.Struct({
	action: CapabilityAction,
	target: Schema.String.check(Schema.isMaxLength(512)),
	arguments: Schema.optionalKey(Schema.JsonObject),
})
export type Capability = typeof Capability.Type

/** A person, an Agent, or a Rule that made a decision. */
export const Decider = Schema.TaggedUnion({
	Person: { userId: Schema.String },
	Agent: { agent: AgentId },
	Rule: { rule: Schema.String },
})
export type Decider = typeof Decider.Type

/**
 * How long a decision lasts.
 * `once` is used up by one call. `session` lasts for one Session. `lifetime` lasts until it is revoked.
 */
export const GrantScope = Schema.Literals(["once", "session", "lifetime"])
export type GrantScope = typeof GrantScope.Type

/** `used` means a `once` Grant was used up. */
export const GrantStatus = Schema.Literals(["active", "used", "revoked"])
export type GrantStatus = typeof GrantStatus.Type

/** A stored decision about one capability of one Agent. The Agent never sees it. */
export const Grant = Schema.Struct({
	id: Schema.String,
	agent: AgentId,
	capability: Capability,
	effect: Decision,
	scope: GrantScope,
	session: Schema.optionalKey(Session.Id),
	grantedBy: Decider,
	reason: Schema.optionalKey(Schema.String),
	/** The Grant of the decider that this Grant came from. Revoking it revokes this one too. */
	parent: Schema.optionalKey(Schema.String),
	status: GrantStatus,
	createdAt: Schema.Finite,
})
export type Grant = typeof Grant.Type

export const CreateGrantRequest = Schema.Struct({
	capability: Capability,
	effect: Decision,
	scope: GrantScope,
	reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
})
export type CreateGrantRequest = typeof CreateGrantRequest.Type

/** A `proposed` Rule waits for a person to confirm it. */
export const RuleStatus = Schema.Literals(["active", "proposed", "retired"])
export type RuleStatus = typeof RuleStatus.Type

/**
 * A rule in plain language that a decider uses to answer requests of one Agent.
 * A judge model reads it. Only a Rule that the judge quotes can allow a request.
 */
export const Rule = Schema.Struct({
	id: Schema.String,
	agent: AgentId,
	author: Decider,
	text: Schema.String,
	status: RuleStatus,
	version: Schema.Natural,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type Rule = typeof Rule.Type

const RuleText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(4000),
)
export const CreateRuleRequest = Schema.Struct({ text: RuleText })
export const UpdateRuleRequest = Schema.Struct({
	expected: Schema.Natural,
	text: Schema.optionalKey(RuleText),
	status: Schema.optionalKey(RuleStatus.pick(["active", "retired"])),
})
export type UpdateRuleRequest = typeof UpdateRuleRequest.Type

export const AgentMemoryView = Schema.Struct({
	...AgentMemory.State.fields,
})
export type AgentMemoryView = typeof AgentMemoryView.Type
export const UpdateAgentMemoryRequest = Schema.Struct({
	expected: Schema.Natural,
	command: AgentMemory.Edit,
})
export type UpdateAgentMemoryRequest = typeof UpdateAgentMemoryRequest.Type
/** Whose memory to read or change. Without it, it is the memory about the caller. */
const personQuery = { person: Schema.optionalKey(Schema.NonEmptyString) }
/** One person that an Agent keeps memory about. */
export const AgentMemoryPerson = Schema.Struct({
	/** The user id of the person. */
	person: Schema.String,
	/** The number of active entries. */
	entries: Schema.Natural,
	version: Schema.Natural,
})
export type AgentMemoryPerson = typeof AgentMemoryPerson.Type

/** What a delegating Agent sends to another Agent. */
export const Brief = Schema.Struct({
	task: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20000)),
	/** The words of the person, unchanged. */
	userRequest: Schema.String.check(Schema.isMaxLength(20000)),
	context: Schema.Array(Schema.String),
	references: Schema.Array(
		Schema.Struct({ session: Session.Id, item: Item.Id }),
	),
	constraints: Schema.Array(Schema.String),
	expectedOutput: Schema.String,
	/** Continue this Session of the Agent. Without it, the work starts in a new Session. */
	session: Schema.optionalKey(Session.Id),
})
export type Brief = typeof Brief.Type

export const Artifact = Schema.Struct({
	kind: Schema.String,
	ref: Schema.String,
	description: Schema.optionalKey(Schema.String),
})
/** The status of a Delegation that has ended. */
export const DelegationResultStatus = Schema.Literals([
	"completed",
	"failed",
	"cancelled",
])
export type DelegationResultStatus = typeof DelegationResultStatus.Type
/** The status of a Delegation that has not ended yet. */
export const OpenDelegationStatus = Schema.Literals([
	"authorizing",
	"queued",
	"running",
])
export type OpenDelegationStatus = typeof OpenDelegationStatus.Type
export const DelegationStatus = Schema.Literals([
	...OpenDelegationStatus.literals,
	...DelegationResultStatus.literals,
])
export type DelegationStatus = typeof DelegationStatus.Type

/** What the other Agent sends back. It never holds the full history. */
export const DelegationResult = Schema.Struct({
	status: DelegationResultStatus,
	summary: Schema.String,
	artifacts: Schema.Array(Artifact),
	openQuestions: Schema.Array(Schema.String),
	child: Schema.Struct({ session: Session.Id, turn: Schema.NullOr(Turn.Id) }),
})
export type DelegationResult = typeof DelegationResult.Type

/** The link from the tool call of one Session to the work of another Agent. */
export const Delegation = Schema.Struct({
	id: Schema.String,
	parent: Schema.Struct({
		session: Session.Id,
		turn: Turn.Id,
		toolCallId: Schema.String,
	}),
	agent: AgentId,
	child: Schema.NullOr(
		Schema.Struct({ session: Session.Id, turn: Schema.NullOr(Turn.Id) }),
	),
	status: DelegationStatus,
	brief: Brief,
	result: Schema.NullOr(DelegationResult),
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type Delegation = typeof Delegation.Type

export class AgentNotFound extends Schema.TaggedError<AgentNotFound>()(
	"AgentNotFound",
	{ agent: Schema.String },
) {}
export class AgentConflict extends Schema.TaggedError<AgentConflict>()(
	"AgentConflict",
	{ message: Schema.String },
) {}
export class AgentInvalid extends Schema.TaggedError<AgentInvalid>()(
	"AgentInvalid",
	{ message: Schema.String },
) {}
export class AgentStorageUnavailable extends Schema.TaggedError<AgentStorageUnavailable>()(
	"AgentStorageUnavailable",
	{},
) {}
/** The handlers check permissions on Agents themselves, so these errors are listed here too. */
export const AgentErrors = [
	...PermissionErrors,
	AgentNotFound.pipe(HttpApiSchema.status(404)),
	AgentConflict.pipe(HttpApiSchema.status(409)),
	AgentInvalid.pipe(HttpApiSchema.status(400)),
	AgentStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const

/** The start of the secret of every Agent invitation link. */
export const InvitationSecretPrefix = "obai_"

/**
 * An invitation to use one Agent. With `email`, the person with this verified email can
 * accept it once. Without `email`, it is a link: everyone who has its secret can accept it,
 * until someone revokes it or it expires.
 */
export const AgentInvitation = Schema.Struct({
	id: InvitationId,
	agent: AgentId,
	email: Schema.NullOr(Schema.String),
	/** The first characters of the secret of a link, so people can tell links apart. */
	prefix: Schema.NullOr(Schema.String),
	/** A same-origin path where a client opens invitation links. */
	path: Schema.NullOr(ReturnTo),
	status: InvitationStatus,
	invitedBy: Schema.String,
	createdAt: Schema.String,
	/** A link without it never expires. */
	expiresAt: Schema.NullOr(Schema.String),
})
export type AgentInvitation = typeof AgentInvitation.Type
export const CreateAgentInvitationRequest = Schema.Struct({
	/** Without it, the invitation is a link. */
	email: Schema.optionalKey(
		Schema.String.check(
			Schema.isMaxLength(320),
			Schema.isPattern(/^[^@\s]+@[^@\s]+$/),
		),
	),
	/** Milliseconds since 1970. An email invitation always lasts 7 days. */
	expiresAt: Schema.optionalKey(Schema.Finite),
	/**
	 * A path on the public origin where your client opens invitation links.
	 * With it, a link has a full `url` that you can show as a QR code.
	 */
	path: Schema.optionalKey(ReturnTo),
})
export type CreateAgentInvitationRequest =
	typeof CreateAgentInvitationRequest.Type
/**
 * An invitation with the secret of its link. `url` is the public origin, then `path`,
 * then `#` and the secret, so the secret never reaches a server log.
 */
export const AgentInvitationSecret = Schema.Struct({
	invitation: AgentInvitation,
	secret: Schema.NullOr(Schema.String),
	url: Schema.NullOr(Schema.String),
})
export type AgentInvitationSecret = typeof AgentInvitationSecret.Type
export const AcceptAgentInvitationRequest = Schema.Struct({
	/** The ID of an email invitation. */
	invitation: Schema.optionalKey(InvitationId),
	/** The secret of an invitation link. */
	secret: Schema.optionalKey(
		Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	),
	/**
	 * The organization where you use the Agent. You must be an active member of it.
	 * You can leave it out when you have only one organization.
	 */
	organization: Schema.optionalKey(Schema.String),
})
export type AcceptAgentInvitationRequest =
	typeof AcceptAgentInvitationRequest.Type

const agentParams = { agentId: AgentId }
const invitationAgentErrors = [
	...AgentErrors,
	InvitationNotFound.pipe(HttpApiSchema.status(404)),
	InvitationInvalid.pipe(HttpApiSchema.status(400)),
] as const
export class AgentsApi extends HttpApiGroup.make("agents")
	.add(
		HttpApiEndpoint.get("listAgents", "/v1/agents", {
			query: {
				archived: Schema.optionalKey(Schema.Literals(["true", "false"])),
				session: Schema.optionalKey(Session.Id),
				agent: Schema.optionalKey(AgentId),
			},
			success: Schema.Array(Agent),
			error: AgentErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the Agents that the caller can use: their own Agents and the shared Agents. With `session`, it lists the Session Agents of that Session. With `agent`, it lists the Agents that this Agent owns.",
		),
		HttpApiEndpoint.post("createAgent", "/v1/agents", {
			payload: CreateAgentRequest,
			success: Agent.pipe(HttpApiSchema.status(201)),
			error: AgentErrors,
		}),
		HttpApiEndpoint.get("getAgent", "/v1/agents/:agentId", {
			params: agentParams,
			success: Agent,
			error: AgentErrors,
		}),
		HttpApiEndpoint.patch("updateAgent", "/v1/agents/:agentId", {
			params: agentParams,
			payload: UpdateAgentRequest,
			success: Agent,
			error: AgentErrors,
		}),
		HttpApiEndpoint.post("promoteAgent", "/v1/agents/:agentId/promote", {
			params: agentParams,
			payload: PromoteAgentRequest,
			success: Agent,
			error: AgentErrors,
		}).annotate(
			OpenApi.Description,
			"Makes a Session Agent a lasting Agent of the caller, or of the Agent in `agent`. Its Session memory becomes its Agent memory.",
		),
		HttpApiEndpoint.get("agentMemory", "/v1/agents/:agentId/memory", {
			params: agentParams,
			query: personQuery,
			success: AgentMemoryView,
			error: AgentErrors,
		}).annotate(
			OpenApi.Description,
			"Reads what the Agent remembers about one person. Without `person`, it is the caller. Reading the memory about another person needs `agents.write` on the Agent.",
		),
		HttpApiEndpoint.post("updateAgentMemory", "/v1/agents/:agentId/memory", {
			params: agentParams,
			query: personQuery,
			payload: UpdateAgentMemoryRequest,
			success: AgentMemoryView,
			error: AgentErrors,
		}).annotate(
			OpenApi.Description,
			"Changes what the Agent remembers about one person. Without `person`, it is the caller. Changing the memory about another person needs `agents.write` on the Agent.",
		),
		HttpApiEndpoint.get("agentMemoryLog", "/v1/agents/:agentId/memory/log", {
			params: agentParams,
			query: personQuery,
			success: Schema.Array(AgentMemory.LogEntry),
			error: AgentErrors,
		}),
		HttpApiEndpoint.get(
			"agentMemoryPeople",
			"/v1/agents/:agentId/memory/people",
			{
				params: agentParams,
				success: Schema.Array(AgentMemoryPerson),
				error: AgentErrors,
			},
		).annotate(
			OpenApi.Description,
			"Lists the people that the Agent keeps memory about. It needs `agents.write` on the Agent.",
		),
	)
	.add(
		HttpApiEndpoint.get("listRules", "/v1/agents/:agentId/rules", {
			params: agentParams,
			success: Schema.Array(Rule),
			error: AgentErrors,
		}),
		HttpApiEndpoint.post("createRule", "/v1/agents/:agentId/rules", {
			params: agentParams,
			payload: CreateRuleRequest,
			success: Rule.pipe(HttpApiSchema.status(201)),
			error: AgentErrors,
		}).annotate(
			OpenApi.Description,
			"Adds a Rule that the caller wrote for this Agent. A Rule from a person is active at once.",
		),
		HttpApiEndpoint.patch("updateRule", "/v1/agents/:agentId/rules/:ruleId", {
			params: { ...agentParams, ruleId: Schema.String },
			payload: UpdateRuleRequest,
			success: Rule,
			error: AgentErrors,
		}).annotate(
			OpenApi.Description,
			"Changes the text of a Rule, confirms a proposed Rule, or retires a Rule.",
		),
		HttpApiEndpoint.get("listGrants", "/v1/agents/:agentId/grants", {
			params: agentParams,
			query: {
				status: Schema.optionalKey(GrantStatus),
			},
			success: Schema.Array(Grant),
			error: AgentErrors,
		}),
		HttpApiEndpoint.post("createGrant", "/v1/agents/:agentId/grants", {
			params: agentParams,
			payload: CreateGrantRequest,
			success: Grant.pipe(HttpApiSchema.status(201)),
			error: AgentErrors,
		}),
		HttpApiEndpoint.delete(
			"revokeGrant",
			"/v1/agents/:agentId/grants/:grantId",
			{
				params: { ...agentParams, grantId: Schema.String },
				success: HttpApiSchema.NoContent,
				error: AgentErrors,
			},
		).annotate(
			OpenApi.Description,
			"Revokes a Grant and every Grant that came from it.",
		),
	)
	.add(
		HttpApiEndpoint.get("listAgentMembers", "/v1/agents/:agentId/members", {
			params: agentParams,
			success: Schema.Array(AgentMember),
			error: AgentErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the people who use this Agent in their own organizations. It needs `agents.share`.",
		),
		HttpApiEndpoint.delete(
			"removeAgentMember",
			"/v1/agents/:agentId/members/:userId",
			{
				params: { ...agentParams, userId: Schema.String },
				success: HttpApiSchema.NoContent,
				error: AgentErrors,
			},
		).annotate(
			OpenApi.Description,
			"Takes a person off this Agent. Their linked Agent stops working at once.",
		),
		HttpApiEndpoint.post(
			"createAgentInvitation",
			"/v1/agents/:agentId/invitations",
			{
				params: agentParams,
				payload: CreateAgentInvitationRequest,
				success: AgentInvitationSecret.pipe(HttpApiSchema.status(201)),
				error: invitationAgentErrors,
			},
		).annotate(
			OpenApi.Description,
			"Invites a person by email, or makes an invitation link, to use this Agent. It needs `agents.share`. Only a lasting top Agent can be shared.",
		),
		HttpApiEndpoint.get(
			"listAgentInvitations",
			"/v1/agents/:agentId/invitations",
			{
				params: agentParams,
				query: { status: Schema.optionalKey(InvitationStatus) },
				success: Schema.Array(AgentInvitation),
				error: invitationAgentErrors,
			},
		),
		HttpApiEndpoint.get(
			"agentInvitationSecret",
			"/v1/agents/:agentId/invitations/:invitationId/secret",
			{
				params: { ...agentParams, invitationId: InvitationId },
				success: AgentInvitationSecret,
				error: invitationAgentErrors,
			},
		).annotate(
			OpenApi.Description,
			"Reads the secret and the URL of an invitation link again, for example to print its QR code again.",
		),
		HttpApiEndpoint.delete(
			"revokeAgentInvitation",
			"/v1/agents/:agentId/invitations/:invitationId",
			{
				params: { ...agentParams, invitationId: InvitationId },
				success: HttpApiSchema.NoContent,
				error: invitationAgentErrors,
			},
		).annotate(
			OpenApi.Description,
			"Takes back a pending invitation. People who accepted it stay members.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	// The resource key of an Agent depends on its owner, which the path does not show.
	// So the handlers check the agents permissions themselves.
	.annotate(GroupRequired, { read: [], write: [] })
	.middleware(Authorize)
	.middleware(AgentAuth) {}

/** A person accepts an invitation to use an Agent. Any signed-in account can use it. */
export class AgentInvitationsApi extends HttpApiGroup.make("agentInvitations")
	.add(
		HttpApiEndpoint.post(
			"acceptAgentInvitation",
			"/v1/agent-invitations/accept",
			{
				payload: AcceptAgentInvitationRequest,
				success: Agent,
				error: invitationAgentErrors,
			},
		).annotate(
			OpenApi.Description,
			"Accepts an email invitation (`invitation`) or an invitation link (`secret`). It makes a linked Agent in your organization and gives it back. When you already use the Agent, it gives back your linked Agent.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.middleware(AccountAuth)
	.middleware(NoStore) {}
