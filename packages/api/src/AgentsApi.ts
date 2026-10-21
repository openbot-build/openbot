import { AgentAuth } from "./AuthApi.ts"
import {
	Authorize,
	Decision,
	GroupRequired,
	PermissionErrors,
} from "./Permissions.ts"
import { Config, Item, Session, Turn } from "@openbot-build/core"
import * as AgentMemory from "./AgentMemory.ts"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"

export const AgentId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/AgentId"))
export type AgentId = typeof AgentId.Type

/**
 * Who owns an Agent.
 * A member owns their Main Agent and their own Agents. The organization owns shared Agents.
 * A Session owns a subagent: the subagent lives as long as that Session.
 */
export const AgentOwner = Schema.TaggedUnion({
	Member: { userId: Schema.String },
	Organization: {},
	Session: { userId: Schema.String, session: Session.Id },
})
export type AgentOwner = typeof AgentOwner.Type

export const AgentKind = Schema.Literals(["main", "persistent", "subagent"])
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
	archived: Schema.Boolean,
	revision: Schema.Natural,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type Agent = typeof Agent.Type

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))
const Text = Schema.String.check(Schema.isMaxLength(20000))

export const CreateAgentRequest = Schema.Struct({
	name: Name,
	role: Schema.String.check(Schema.isMaxLength(500)),
	instructions: Text,
	model: Schema.optionalKey(Config.Selection),
	/** Shared Agents belong to the organization. Other Agents belong to the caller. */
	shared: Schema.optionalKey(Schema.Boolean),
})
export type CreateAgentRequest = typeof CreateAgentRequest.Type

export const UpdateAgentRequest = Schema.Struct({
	expected: Schema.Natural,
	name: Schema.optionalKey(Name),
	role: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
	instructions: Schema.optionalKey(Text),
	model: Schema.optionalKey(Schema.NullOr(Config.Selection)),
	archived: Schema.optionalKey(Schema.Boolean),
})
export type UpdateAgentRequest = typeof UpdateAgentRequest.Type

/**
 * What a capability is: an action, the thing it acts on, and optional exact arguments.
 * `target` is `*` for every target.
 */
export const CapabilityAction = Schema.Literals([
	"tools.call",
	"apps.call",
	"agents.spawn",
	"agents.delegate",
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

const agentParams = { agentId: AgentId }
export class AgentsApi extends HttpApiGroup.make("agents")
	.add(
		HttpApiEndpoint.get("listAgents", "/v1/agents", {
			query: {
				archived: Schema.optionalKey(Schema.Literals(["true", "false"])),
				session: Schema.optionalKey(Session.Id),
			},
			success: Schema.Array(Agent),
			error: AgentErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the Agents that the caller can use: their Main Agent, their own Agents and the shared Agents. With `session`, it lists the subagents of that Session.",
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
			payload: Schema.Struct({ expected: Schema.Natural }),
			success: Agent,
			error: AgentErrors,
		}).annotate(
			OpenApi.Description,
			"Makes a subagent a lasting Agent of the caller. Its Session memory becomes its Agent memory.",
		),
		HttpApiEndpoint.get("agentMemory", "/v1/agents/:agentId/memory", {
			params: agentParams,
			success: AgentMemoryView,
			error: AgentErrors,
		}),
		HttpApiEndpoint.post("updateAgentMemory", "/v1/agents/:agentId/memory", {
			params: agentParams,
			payload: UpdateAgentMemoryRequest,
			success: AgentMemoryView,
			error: AgentErrors,
		}),
		HttpApiEndpoint.get("agentMemoryLog", "/v1/agents/:agentId/memory/log", {
			params: agentParams,
			success: Schema.Array(AgentMemory.LogEntry),
			error: AgentErrors,
		}),
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
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	// The resource key of an Agent depends on its owner, which the path does not show.
	// So the handlers check the agents permissions themselves.
	.annotate(GroupRequired, { read: [], write: [] })
	.middleware(Authorize)
	.middleware(AgentAuth) {}
