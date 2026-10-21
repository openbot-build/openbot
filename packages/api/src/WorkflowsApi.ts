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

/** The name of a step. Later steps use it in templates, such as `{{steps.login.output}}`. */
export const StepId = Schema.String.check(
	Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/),
)
export type StepId = typeof StepId.Type

const Text = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(20000),
)
const Seconds = Schema.Int.check(
	Schema.isBetween({ minimum: 1, maximum: 86400 }),
)

/**
 * One step of a Workflow. The steps run from the first to the last.
 * Text fields can use templates: `{{input.name}}`, `{{vars.name}}` and `{{steps.id.output}}`.
 *
 * - `Call` runs one tool with exact arguments. No model takes part.
 * - `Act` gives a goal to the Agent. OpenBot records the tool calls when a later check passes,
 *   and replays them in later Runs without a model.
 * - `Assert` asks the Agent to look and say whether a condition is true. It never changes anything.
 * - `WaitFor` repeats the check of `Assert` until the condition is true or the time is over.
 * - `Extract` asks the Agent for a value that matches a JSON Schema, and keeps it as `vars.<name>`.
 * - `Expect` compares a value with no model, for example `{{vars.total}}` equals `42`.
 * - `Explore` gives the Agent a goal and lets it plan its own steps. It reports what it finds.
 */
export const Step = Schema.TaggedUnion({
	Call: {
		id: StepId,
		tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
		arguments: Schema.JsonObject,
	},
	Act: {
		id: StepId,
		goal: Text,
		/** Another Agent for this step. Without it, the Agent of the Workflow works. */
		agent: Schema.optionalKey(AgentId),
	},
	Assert: {
		id: StepId,
		condition: Text,
		agent: Schema.optionalKey(AgentId),
	},
	WaitFor: {
		id: StepId,
		condition: Text,
		timeoutSeconds: Seconds,
		intervalSeconds: Seconds,
		agent: Schema.optionalKey(AgentId),
	},
	Extract: {
		id: StepId,
		/** The value goes into `vars.<name>`. */
		name: StepId,
		instruction: Text,
		/** A JSON Schema for the value. */
		schema: Schema.JsonObject,
		agent: Schema.optionalKey(AgentId),
	},
	Expect: {
		id: StepId,
		value: Schema.String.check(Schema.isMaxLength(20000)),
		operator: Schema.Literals(["equals", "contains", "matches", "not_empty"]),
		expected: Schema.optionalKey(
			Schema.String.check(Schema.isMaxLength(20000)),
		),
	},
	Explore: {
		id: StepId,
		goal: Text,
		agent: Schema.optionalKey(AgentId),
	},
})
export type Step = typeof Step.Type
export type StepKind = Step["_tag"]

export const Steps = Schema.Array(Step).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(100),
)

/** When OpenBot starts a Run by itself. `cron` has five fields, such as `0 9 * * 1-5`. */
export const Schedule = Schema.Struct({
	cron: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	/** An IANA time zone, such as `Europe/Berlin`. Without it, the time zone is UTC. */
	timeZone: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
})
export type Schedule = typeof Schedule.Type

export const Workflow = Schema.Struct({
	id: WorkflowId,
	owner: WorkflowOwner,
	name: Schema.String,
	description: Schema.String,
	/**
	 * The Agent that runs the steps. With `null`, the Main Agent of the member
	 * that the Run works for runs them.
	 */
	agent: Schema.NullOr(AgentId),
	/** The model for the check steps: Assert, WaitFor and Extract. Without it, the model of the Agent works. */
	judge: Schema.optionalKey(Config.Selection),
	steps: Steps,
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
	/** Without it, the Main Agent of the member that a Run works for runs the steps. */
	agent: Schema.optionalKey(AgentId),
	judge: Schema.optionalKey(Config.Selection),
	steps: Steps,
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
	steps: Schema.optionalKey(Steps),
	schedule: Schema.optionalKey(Schema.NullOr(Schedule)),
	archived: Schema.optionalKey(Schema.Boolean),
})
export type UpdateWorkflowRequest = typeof UpdateWorkflowRequest.Type

/** What started a Run. */
export const RunTrigger = Schema.Literals([
	"manual",
	"schedule",
	"webhook",
	"agent",
	"explore",
])
export type RunTrigger = typeof RunTrigger.Type

/**
 * How a Run uses recorded steps.
 * `use` replays and records. `read` replays but never records, for CI. `off` runs every step live.
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

export const StepStatus = Schema.Literals([
	"pending",
	"running",
	"passed",
	"failed",
	"skipped",
])
export type StepStatus = typeof StepStatus.Type

/**
 * How a step ran.
 * `deterministic`: with no model. `live`: the Agent did it. `replayed`: recorded tool calls ran again.
 * `handed_off`: a replay did not work, so the Agent went on from where the replay stopped.
 */
export const StepMode = Schema.Literals([
	"deterministic",
	"live",
	"replayed",
	"handed_off",
])
export type StepMode = typeof StepMode.Type

export const TurnRef = Schema.Struct({ session: Session.Id, turn: Turn.Id })
export type TurnRef = typeof TurnRef.Type

export const StepResult = Schema.Struct({
	id: StepId,
	kind: Schema.Literals(Object.keys(Step.cases) as ReadonlyArray<StepKind>),
	status: StepStatus,
	mode: Schema.NullOr(StepMode),
	attempts: Schema.Natural,
	/** The Turns that did the step. */
	turns: Schema.Array(TurnRef),
	output: Schema.NullOr(Schema.Json),
	/** Why the step failed, or what the Agent said about it. */
	message: Schema.NullOr(Schema.String),
	startedAt: Schema.NullOr(Schema.Finite),
	finishedAt: Schema.NullOr(Schema.Finite),
})
export type StepResult = typeof StepResult.Type

export const Severity = Schema.Literals(["low", "medium", "high", "critical"])
export type Severity = typeof Severity.Type

/** Something that an Agent found while it explored. */
export const Finding = Schema.Struct({
	step: StepId,
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
	/** `null` for an exploration, which has no stored Workflow. */
	workflow: Schema.NullOr(WorkflowId),
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
	variables: Schema.JsonObject,
	steps: Schema.Array(StepResult),
	findings: Schema.Array(Finding),
	summary: RunSummary,
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

export const ExploreRequest = Schema.Struct({
	goal: Text,
	/** Without it, the Main Agent of the caller explores. */
	agent: Schema.optionalKey(AgentId),
	input: Schema.optionalKey(Schema.JsonObject),
})
export type ExploreRequest = typeof ExploreRequest.Type

/** The secret of a webhook. OpenBot shows it only once. */
export const WebhookSecret = Schema.Struct({
	url: Schema.String,
	secret: Schema.String,
})
export type WebhookSecret = typeof WebhookSecret.Type

/** Tool calls that OpenBot replays for one `Act` step. */
export const Recording = Schema.Struct({
	step: StepId,
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
			},
			success: Schema.Array(Workflow),
			error: WorkflowErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the Workflows that the caller can read: their own and the shared ones. With `owner`, it lists the Workflows of that Agent.",
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
			"Removes the recorded steps, so the next Run does every step live.",
		),
		HttpApiEndpoint.post("explore", "/v1/explorations", {
			payload: ExploreRequest,
			success: accepted,
			error: WorkflowErrors,
		}).annotate(
			OpenApi.Description,
			"Starts a Run with one Explore step. The Agent plans its own steps and reports findings.",
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
			"The Run as JUnit XML, for CI systems. Each step is one test case.",
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
