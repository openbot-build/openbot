import { AgentAuth } from "./AuthApi.ts"
import { Authorize, GroupRequired, PermissionErrors } from "./Permissions.ts"
import { Config, Session, Turn } from "@openbot-build/core"
import { AgentId } from "./AgentsApi.ts"
import { Name } from "./Name.ts"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"

export const WorkflowId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/WorkflowId"))
export type WorkflowId = typeof WorkflowId.Type

export const RunId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/RunId"))
export type RunId = typeof RunId.Type

/**
 * Who owns a Workflow. A member owns their own Workflows. The organization owns shared Workflows.
 * An Agent can own Workflows too. `userId` is the member at the top of the owner tree of that Agent.
 */
export const WorkflowOwner = Schema.TaggedUnion({
	Member: { userId: Schema.String },
	Organization: {},
	Agent: { agent: AgentId, userId: Schema.NullOr(Schema.String) },
})
export type WorkflowOwner = typeof WorkflowOwner.Type

/** The name of a node. Other nodes use it in `needs` and in templates, such as `{{nodes.login.output}}`. */
export const NodeId = Schema.String.check(
	Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/),
)
export type NodeId = typeof NodeId.Type

const Text = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(20000),
)
const Seconds = Schema.Int.check(
	Schema.isBetween({ minimum: 1, maximum: 86400 }),
)

/** A comparison with no model, for example `{{nodes.total.output}}` equals `42`. */
export const Condition = Schema.Struct({
	value: Schema.String.check(Schema.isMaxLength(20000)),
	operator: Schema.Literals(["equals", "contains", "matches", "not_empty"]),
	expected: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20000))),
})
export type Condition = typeof Condition.Type

/**
 * What happens when a node fails.
 * `fail` stops the Run. `continue` lets the nodes after it run anyway.
 * `replan` ends the Run and asks the Plan or Goal node that made this Workflow to plan again.
 */
export const OnFail = Schema.Literals(["fail", "continue", "replan"])
export type OnFail = typeof OnFail.Type

/** The fields that every node has. */
const common = {
	id: NodeId,
	/** The nodes that must end first. Nodes with no `needs` start at once, at the same time. */
	needs: Schema.optionalKey(Schema.Array(NodeId)),
	/** The node runs only when this condition is true. Otherwise it is skipped. */
	when: Schema.optionalKey(Condition),
	/** Without it, a failed node stops the Run. */
	onFail: Schema.optionalKey(OnFail),
	/** How many times the node may run before it fails. Without it, one time. */
	attempts: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
	),
}

/**
 * One node of a Workflow graph. A node starts when every node in its `needs` has ended.
 * Text fields can use templates: `{{input.name}}` and `{{nodes.id.output}}`.
 *
 * - `Call` runs one tool with exact arguments. No model takes part.
 * - `Expect` compares a value with no model.
 * - `Task` gives a goal to an Agent. OpenBot records the tool calls when a check passes later,
 *   and replays them in later Runs without a model. `check` is a condition that must be true after it.
 * - `Check` asks an Agent to look and say whether a condition is true. It never changes anything.
 *   With `output`, the Agent also gives a value that matches this JSON Schema.
 *   With `until`, the Agent checks again and again until the condition is true or the time is over.
 * - `Plan` asks an Agent to plan. The plan is a new Workflow graph, not text.
 *   OpenBot keeps it as a Workflow of that Agent and runs it as a child Run.
 * - `Goal` plans like `Plan`, and then checks the result. When the check fails,
 *   the Agent plans again, until the check passes. `budget` is how many model tokens it may use
 *   before it must ask to go on.
 * - `Workflow` runs another Workflow as a child Run.
 * - `Wait` waits for some seconds.
 */
export const Node = Schema.TaggedUnion({
	Call: {
		...common,
		tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
		arguments: Schema.JsonObject,
	},
	Expect: { ...common, ...Condition.fields },
	Task: {
		...common,
		goal: Text,
		/** Another Agent for this node. Without it, the Agent of the Workflow works. */
		agent: Schema.optionalKey(AgentId),
		check: Schema.optionalKey(Text),
	},
	Check: {
		...common,
		condition: Text,
		agent: Schema.optionalKey(AgentId),
		/** A JSON Schema for a value that the Agent finds. The value is the output of the node. */
		output: Schema.optionalKey(Schema.JsonObject),
		until: Schema.optionalKey(
			Schema.Struct({ timeoutSeconds: Seconds, intervalSeconds: Seconds }),
		),
	},
	Plan: { ...common, goal: Text, agent: Schema.optionalKey(AgentId) },
	Goal: {
		...common,
		goal: Text,
		/** The condition that tells when the goal is reached. */
		check: Text,
		agent: Schema.optionalKey(AgentId),
		budget: Schema.optionalKey(
			Schema.Struct({ tokens: Schema.Int.check(Schema.isGreaterThan(0)) }),
		),
	},
	Workflow: {
		...common,
		workflow: WorkflowId,
		input: Schema.optionalKey(Schema.JsonObject),
	},
	Wait: { ...common, seconds: Seconds },
})
export type Node = typeof Node.Type
export type NodeKind = Node["_tag"]

/** The nodes of a Workflow and how they depend on each other. */
export const Graph = Schema.Struct({
	nodes: Schema.Array(Node).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(1000),
	),
})
export type Graph = typeof Graph.Type

/** When OpenBot starts a Run by itself. `cron` has five fields, such as `0 9 * * 1-5`. */
export const Schedule = Schema.Struct({
	cron: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	/** An IANA time zone, such as `Europe/Berlin`. Without it, the time zone is UTC. */
	timeZone: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
})
export type Schedule = typeof Schedule.Type

/**
 * Where a planned Workflow comes from. An Agent wrote it as a plan.
 * `Plan`: a Plan or Goal node of a Run. `Session`: an Agent in a Session, with `openbot_plan`.
 */
export const WorkflowOrigin = Schema.TaggedUnion({
	Plan: { workflow: WorkflowId, run: RunId, node: NodeId },
	Session: { session: Session.Id },
})
export type WorkflowOrigin = typeof WorkflowOrigin.Type

export const Workflow = Schema.Struct({
	id: WorkflowId,
	owner: WorkflowOwner,
	name: Schema.String,
	description: Schema.String,
	/**
	 * The Agent that runs the nodes. With `null`, the Main Agent of the member
	 * that the Run works for runs them.
	 */
	agent: Schema.NullOr(AgentId),
	/** The model for checks. Without it, the model of the Agent works. */
	judge: Schema.optionalKey(Config.Selection),
	graph: Graph,
	/** `null` for a Workflow that a person made. Otherwise the plan that made it. */
	origin: Schema.NullOr(WorkflowOrigin),
	/** The last revision that a Run passed with. A Plan node uses it again with no model. */
	passedRevision: Schema.NullOr(Schema.Natural),
	schedule: Schema.NullOr(Schedule),
	/** True when the Workflow has a webhook secret. */
	webhook: Schema.Boolean,
	/**
	 * The member that scheduled Runs and webhook Runs work for.
	 * It is the last member who changed the schedule or the webhook.
	 */
	actor: Schema.NullOr(Schema.String),
	archived: Schema.Boolean,
	revision: Schema.Natural,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type Workflow = typeof Workflow.Type

const Description = Schema.String.check(Schema.isMaxLength(4000))

export const CreateWorkflowRequest = Schema.Struct({
	name: Name,
	description: Schema.optionalKey(Description),
	/** Without it, the Main Agent of the member that a Run works for runs the nodes. */
	agent: Schema.optionalKey(AgentId),
	judge: Schema.optionalKey(Config.Selection),
	graph: Graph,
	schedule: Schema.optionalKey(Schedule),
	/** Shared Workflows belong to the organization. Other Workflows belong to the caller. */
	shared: Schema.optionalKey(Schema.Boolean),
	/** The Agent that owns the new Workflow. You cannot use it together with `shared`. */
	owner: Schema.optionalKey(AgentId),
})
export type CreateWorkflowRequest = typeof CreateWorkflowRequest.Type

export const UpdateWorkflowRequest = Schema.Struct({
	expected: Schema.Natural,
	name: Schema.optionalKey(Name),
	description: Schema.optionalKey(Description),
	agent: Schema.optionalKey(Schema.NullOr(AgentId)),
	judge: Schema.optionalKey(Schema.NullOr(Config.Selection)),
	graph: Schema.optionalKey(Graph),
	schedule: Schema.optionalKey(Schema.NullOr(Schedule)),
	archived: Schema.optionalKey(Schema.Boolean),
})
export type UpdateWorkflowRequest = typeof UpdateWorkflowRequest.Type

/** What started a Run. `plan` and `workflow` are child Runs of a node of another Run. */
export const RunTrigger = Schema.Literals([
	"manual",
	"schedule",
	"webhook",
	"agent",
	"plan",
	"workflow",
])
export type RunTrigger = typeof RunTrigger.Type

/**
 * How a Run uses recorded work.
 * `use` replays and records. `read` replays but never records, for CI. `off` runs every node live.
 */
export const CacheMode = Schema.Literals(["use", "read", "off"])
export type CacheMode = typeof CacheMode.Type

export const RunStatus = Schema.Literals([
	"queued",
	"running",
	"passed",
	"failed",
	"cancelled",
])
export type RunStatus = typeof RunStatus.Type

export const NodeStatus = Schema.Literals([
	"pending",
	"running",
	"passed",
	"failed",
	"skipped",
])
export type NodeStatus = typeof NodeStatus.Type

/**
 * How a node ran.
 * `deterministic`: with no model. `live`: an Agent did it. `replayed`: recorded work ran again.
 * `handed_off`: a replay did not work, so the Agent went on from where the replay stopped.
 */
export const NodeMode = Schema.Literals([
	"deterministic",
	"live",
	"replayed",
	"handed_off",
])
export type NodeMode = typeof NodeMode.Type

export const TurnRef = Schema.Struct({ session: Session.Id, turn: Turn.Id })
export type TurnRef = typeof TurnRef.Type

export const NodeResult = Schema.Struct({
	id: NodeId,
	kind: Schema.Literals(Object.keys(Node.cases) as ReadonlyArray<NodeKind>),
	needs: Schema.Array(NodeId),
	status: NodeStatus,
	mode: Schema.NullOr(NodeMode),
	attempts: Schema.Natural,
	/** The planning round of a Plan or Goal node. It starts at 0. */
	round: Schema.Natural,
	/** The Turns that did the node. */
	turns: Schema.Array(TurnRef),
	output: Schema.NullOr(Schema.Json),
	/** Why the node failed, or what the Agent said about it. */
	message: Schema.NullOr(Schema.String),
	/** The model tokens that the node used, with its child Runs. */
	tokens: Schema.Natural,
	/** The child Runs that a Plan, Goal or Workflow node started. */
	children: Schema.Array(RunId),
	startedAt: Schema.NullOr(Schema.Finite),
	finishedAt: Schema.NullOr(Schema.Finite),
})
export type NodeResult = typeof NodeResult.Type

export const Severity = Schema.Literals(["low", "medium", "high", "critical"])
export type Severity = typeof Severity.Type

/** A problem that an Agent found while it worked on a node. */
export const Finding = Schema.Struct({
	node: NodeId,
	severity: Severity,
	title: Schema.String,
	expected: Schema.String,
	observed: Schema.String,
	/** The steps that show the problem again. */
	reproduction: Schema.Array(Schema.String),
})
export type Finding = typeof Finding.Type

export const RunSummary = Schema.Struct({
	passed: Schema.Natural,
	failed: Schema.Natural,
	skipped: Schema.Natural,
	deterministic: Schema.Natural,
	live: Schema.Natural,
	replayed: Schema.Natural,
	handedOff: Schema.Natural,
})
export type RunSummary = typeof RunSummary.Type

export const Run = Schema.Struct({
	id: RunId,
	workflow: WorkflowId,
	/** The revision of the Workflow that the Run uses. */
	revision: Schema.Natural,
	name: Schema.String,
	trigger: RunTrigger,
	status: RunStatus,
	cache: CacheMode,
	/** The member that the Run works for. */
	userId: Schema.String,
	agent: AgentId,
	input: Schema.JsonObject,
	nodes: Schema.Array(NodeResult),
	findings: Schema.Array(Finding),
	summary: RunSummary,
	/** The model tokens that the Run used, with its child Runs. */
	usage: Schema.Struct({ tokens: Schema.Natural }),
	/** The node of another Run that started this Run. */
	parent: Schema.NullOr(Schema.Struct({ run: RunId, node: NodeId })),
	/** The Sessions where the Agents of the Run work. */
	sessions: Schema.Array(
		Schema.Struct({ agent: AgentId, session: Session.Id }),
	),
	error: Schema.NullOr(Schema.String),
	createdAt: Schema.Finite,
	startedAt: Schema.NullOr(Schema.Finite),
	finishedAt: Schema.NullOr(Schema.Finite),
})
export type Run = typeof Run.Type

export const StartRunRequest = Schema.Struct({
	input: Schema.optionalKey(Schema.JsonObject),
	cache: Schema.optionalKey(CacheMode),
})
export type StartRunRequest = typeof StartRunRequest.Type

export const ReviseRunRequest = Schema.Struct({
	/** Without it, the Run moves to the newest revision. */
	revision: Schema.optionalKey(Schema.Natural),
})
export type ReviseRunRequest = typeof ReviseRunRequest.Type

/** The secret of a webhook. OpenBot shows it only once. */
export const WebhookSecret = Schema.Struct({
	url: Schema.String,
	secret: Schema.String,
})
export type WebhookSecret = typeof WebhookSecret.Type

/** Tool calls that OpenBot replays for one `Task` node. */
export const Recording = Schema.Struct({
	node: NodeId,
	calls: Schema.Array(
		Schema.Struct({ tool: Schema.String, arguments: Schema.JsonObject }),
	),
	verifiedAt: Schema.Finite,
})
export type Recording = typeof Recording.Type

export class WorkflowNotFound extends Schema.TaggedError<WorkflowNotFound>()(
	"WorkflowNotFound",
	{ id: Schema.String },
) {}
export class WorkflowConflict extends Schema.TaggedError<WorkflowConflict>()(
	"WorkflowConflict",
	{ message: Schema.String },
) {}
export class WorkflowInvalid extends Schema.TaggedError<WorkflowInvalid>()(
	"WorkflowInvalid",
	{ message: Schema.String },
) {}
export class WorkflowStorageUnavailable extends Schema.TaggedError<WorkflowStorageUnavailable>()(
	"WorkflowStorageUnavailable",
	{},
) {}
/** The webhook secret is wrong, or the Workflow has no webhook. */
export class WorkflowHookDenied extends Schema.TaggedError<WorkflowHookDenied>()(
	"WorkflowHookDenied",
	{},
) {}

/** The handlers check permissions on Workflows themselves, so these errors are listed here too. */
export const WorkflowErrors = [
	...PermissionErrors,
	WorkflowNotFound.pipe(HttpApiSchema.status(404)),
	WorkflowConflict.pipe(HttpApiSchema.status(409)),
	WorkflowInvalid.pipe(HttpApiSchema.status(400)),
	WorkflowStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const

const workflowParams = { workflowId: WorkflowId }
const runParams = { runId: RunId }
const accepted = Run.pipe(HttpApiSchema.status(202))

export class WorkflowsApi extends HttpApiGroup.make("workflows")
	.add(
		HttpApiEndpoint.get("listWorkflows", "/v1/workflows", {
			query: {
				archived: Schema.optionalKey(Schema.Literals(["true", "false"])),
				owner: Schema.optionalKey(AgentId),
				planned: Schema.optionalKey(Schema.Literals(["true", "false"])),
			},
			success: Schema.Array(Workflow),
			error: WorkflowErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the Workflows that the caller can read: their own and the shared ones. With `owner`, it lists the Workflows of that Agent. With `planned`, it lists only planned Workflows, or only the others.",
		),
		HttpApiEndpoint.post("createWorkflow", "/v1/workflows", {
			payload: CreateWorkflowRequest,
			success: Workflow.pipe(HttpApiSchema.status(201)),
			error: WorkflowErrors,
		}),
		HttpApiEndpoint.get("getWorkflow", "/v1/workflows/:workflowId", {
			params: workflowParams,
			success: Workflow,
			error: WorkflowErrors,
		}),
		HttpApiEndpoint.patch("updateWorkflow", "/v1/workflows/:workflowId", {
			params: workflowParams,
			payload: UpdateWorkflowRequest,
			success: Workflow,
			error: WorkflowErrors,
		}).annotate(
			OpenApi.Description,
			"Changes a Workflow. A change to the schedule makes the caller the actor of the Workflow.",
		),
		HttpApiEndpoint.post("startRun", "/v1/workflows/:workflowId/runs", {
			params: workflowParams,
			payload: StartRunRequest,
			success: accepted,
			error: WorkflowErrors,
		}).annotate(
			OpenApi.Description,
			"Starts a Run of the Workflow. The Run goes on in the background. Read it at /v1/workflow-runs/{runId}.",
		),
		HttpApiEndpoint.put("setWebhook", "/v1/workflows/:workflowId/webhook", {
			params: workflowParams,
			success: WebhookSecret,
			error: WorkflowErrors,
		}).annotate(
			OpenApi.Description,
			"Makes a new webhook secret. The old secret stops working. The caller becomes the actor of the Workflow.",
		),
		HttpApiEndpoint.delete(
			"removeWebhook",
			"/v1/workflows/:workflowId/webhook",
			{
				params: workflowParams,
				success: HttpApiSchema.NoContent,
				error: WorkflowErrors,
			},
		),
		HttpApiEndpoint.get(
			"listRecordings",
			"/v1/workflows/:workflowId/recordings",
			{
				params: workflowParams,
				success: Schema.Array(Recording),
				error: WorkflowErrors,
			},
		),
		HttpApiEndpoint.delete(
			"clearRecordings",
			"/v1/workflows/:workflowId/recordings",
			{
				params: workflowParams,
				success: HttpApiSchema.NoContent,
				error: WorkflowErrors,
			},
		).annotate(
			OpenApi.Description,
			"Removes the recorded tool calls, so the next Run does every Task node live.",
		),
	)
	.add(
		HttpApiEndpoint.get("listRuns", "/v1/workflow-runs", {
			query: {
				workflow: Schema.optionalKey(WorkflowId),
				status: Schema.optionalKey(RunStatus),
			},
			success: Schema.Array(Run),
			error: WorkflowErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the Runs of the caller, newest first, at most 100. With `workflow` or `status`, it lists only those Runs.",
		),
		HttpApiEndpoint.get("getRun", "/v1/workflow-runs/:runId", {
			params: runParams,
			success: Run,
			error: WorkflowErrors,
		}),
		HttpApiEndpoint.post("cancelRun", "/v1/workflow-runs/:runId/cancel", {
			params: runParams,
			success: Run,
			error: WorkflowErrors,
		}),
		HttpApiEndpoint.post("reviseRun", "/v1/workflow-runs/:runId/revise", {
			params: runParams,
			payload: ReviseRunRequest,
			success: Run,
			error: WorkflowErrors,
		}).annotate(
			OpenApi.Description,
			"Moves a Run that goes on to another revision of its Workflow. Nodes that passed and did not change keep their results. Running nodes that changed stop and start again.",
		),
		HttpApiEndpoint.get(
			"runReportMarkdown",
			"/v1/workflow-runs/:runId/report/markdown",
			{
				params: runParams,
				success: Schema.String.pipe(
					HttpApiSchema.asText({ contentType: "text/markdown" }),
				),
				error: WorkflowErrors,
			},
		).annotate(
			OpenApi.Description,
			"A short report of the Run in Markdown, for people and coding agents.",
		),
		HttpApiEndpoint.get(
			"runReportJunit",
			"/v1/workflow-runs/:runId/report/junit",
			{
				params: runParams,
				success: Schema.String.pipe(
					HttpApiSchema.asText({ contentType: "application/xml" }),
				),
				error: WorkflowErrors,
			},
		).annotate(
			OpenApi.Description,
			"The Run as JUnit XML, for CI systems. Each node is one test case.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	// The resource key of a Workflow depends on its owner, which the path does not show.
	// So the handlers check the workflows permissions themselves.
	.annotate(GroupRequired, { read: [], write: [] })
	.middleware(Authorize)
	.middleware(AgentAuth) {}

/** Starts a Run from another system. The secret of the webhook is the only credential. */
export class WorkflowHooksApi extends HttpApiGroup.make("workflowHooks").add(
	HttpApiEndpoint.post("triggerWorkflow", "/v1/hooks/workflows/:workflowId", {
		params: workflowParams,
		headers: { authorization: Schema.String },
		payload: Schema.JsonObject,
		success: Schema.Struct({ run: RunId }).pipe(HttpApiSchema.status(202)),
		error: [
			WorkflowHookDenied.pipe(HttpApiSchema.status(401)),
			WorkflowStorageUnavailable.pipe(HttpApiSchema.status(503)),
		],
	}).annotate(
		OpenApi.Description,
		"Starts a Run. Send `Authorization: Bearer <webhook secret>`. The JSON body is the input of the Run. The Run works for the actor of the Workflow.",
	),
) {}
