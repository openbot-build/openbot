import type { Services as AuthorizationServices } from "../../authorization/Authorize.ts"
import {
	Agent,
	Plugin,
	type Session,
	type SessionStore,
} from "@openbot-build/core"
import { WorkflowsApi } from "@openbot-build/api"
import {
	Context,
	Effect,
	type JsonSchema,
	Layer,
	Option,
	Record,
	Schema,
	Stream,
} from "effect"
import { Prompt, Tool, Toolkit } from "effect/ai"
import { Agents } from "../../agents/Agents.ts"
import { hash } from "../../capabilities/Capability.ts"
import { Gate } from "../../capabilities/Gate.ts"
import { Work } from "../../capabilities/Work.ts"
import * as SessionHost from "../../sessions/SessionHost.ts"
import { Launcher } from "../../workflows/Execution.ts"
import { Runs, terminal, view } from "../../workflows/Runs.ts"
import { agentsOf, graphProblem, Workflows } from "../../workflows/Workflows.ts"

export const pluginId = Plugin.Id.make("@openbot-build/openbot/workflows")

/** The tools of this plugin. Their parameters are JSON Schema, like App tools. */
export type Tools = Record<
	string,
	Tool.Dynamic<
		string,
		{
			readonly parameters: JsonSchema.JsonSchema
			readonly success: typeof Schema.Json
			readonly failure: typeof Schema.Never
			readonly failureMode: "error"
		}
	>
>

/** The tool names of this plugin. A Run finds the answers of a node by these names. */
export const names = {
	list: "openbot_list_workflows",
	run: "openbot_run_workflow",
	plan: "openbot_plan",
	getRun: "openbot_get_run",
	nodeResult: "openbot_node_result",
	check: "openbot_check",
	finding: "openbot_report_finding",
	/** Only OpenBot calls it, when a Goal node used its token budget. */
	proceed: "openbot_continue",
} as const

export const NodeResultInput = Schema.Struct({
	status: Schema.Literals(["done", "failed"]),
	summary: Schema.String,
})
export const CheckInput = Schema.Struct({
	passed: Schema.Boolean,
	evidence: Schema.String,
	value: Schema.optionalKey(Schema.Json),
})
export const FindingInput = Schema.Struct({
	severity: WorkflowsApi.Severity,
	title: Schema.String,
	expected: Schema.String,
	observed: Schema.String,
	reproduction: Schema.Array(Schema.String),
})
/** A plan: a Workflow graph that an Agent writes. */
export const PlanInput = Schema.Struct({
	/** A Workflow to change with a new revision. Without it, the plan makes a new Workflow. */
	workflow: Schema.optionalKey(Schema.String),
	name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	description: Schema.optionalKey(
		Schema.String.check(Schema.isMaxLength(4000)),
	),
	nodes: WorkflowsApi.Graph.fields.nodes,
	/** The input of the Run of the plan. */
	input: Schema.optionalKey(Schema.JsonObject),
	reason: Schema.optionalKey(Schema.String),
})
export type PlanInput = typeof PlanInput.Type
const RunInput = Schema.Struct({
	workflow: Schema.String,
	reason: Schema.String,
	input: Schema.optionalKey(Schema.JsonObject),
})
const GetRunInput = Schema.Struct({ run: Schema.String })
const ProceedInput = Schema.Struct({
	workflow: Schema.String,
	reason: Schema.String,
})

/** The JSON Schema of a Schema, as the parameters of a tool. */
const parametersOf = (schema: Schema.Top): JsonSchema.JsonSchema => {
	const document = Schema.toJsonSchemaDocument(schema)
	return Object.keys(document.definitions).length === 0
		? document.schema
		: { ...document.schema, $defs: document.definitions }
}

interface Entry {
	readonly tool: Tools[string]
	readonly handle: (input: unknown) => Effect.Effect<Schema.Json>
}

const text = { type: "string" } as const
const json = (value: unknown): Schema.Json =>
	JSON.parse(JSON.stringify(value)) as Schema.Json

/** The words that a workflow Session reads with every node. */
const runInstructions = `You work in a Workflow Run. Each message is one node of the Run. Do only that node.
- A task node: use your tools to reach the goal. Then call ${names.nodeResult} once.
- A check node: look at the current state with your tools, but never change anything. Then call ${names.check} once.
- A plan node: do not answer with a text plan. Write the plan as a Workflow graph and call ${names.plan} once.
- In every node, call ${names.finding} for each problem that you find.`

/** The words for other Sessions: a plan is a Workflow graph, not text. */
const planInstructions = `When work needs a plan, do not write the plan as text. Call ${names.plan} with a Workflow graph: nodes, their kinds and their needs. OpenBot keeps the plan as your Workflow and runs it in the background, and the result comes to this Session as a new message. To change a plan, call ${names.plan} again with its workflow id. To set a goal that OpenBot keeps working on, make a plan with a Goal node.`

type Services =
	Workflows | Runs | Agents | Launcher | Gate | AuthorizationServices

/** What the Sessions of one member give to the Workflow plugin. */
interface ForOwnerInput {
	readonly read: (
		session: Session.Id,
	) => Effect.Effect<
		Session.View<SessionHost.Values>,
		Session.SessionNotFound | SessionStore.SessionStoreError
	>
}

/** Builds the Workflow plugin for the Sessions of one member. It runs inside the Agent plugin. */
export class WorkflowPlugin extends Context.Service<
	WorkflowPlugin,
	{ readonly forOwner: (input: ForOwnerInput) => Plugin.Plugin<Tools> }
>()("@openbot-build/openbot/plugins/workflows/WorkflowPlugin") {}

export const make: Effect.Effect<
	typeof WorkflowPlugin.Service,
	never,
	Services
> = Effect.gen(function* () {
	const services = yield* Effect.context<AuthorizationServices>()
	const workflows = yield* Workflows
	const runs = yield* Runs
	const agents = yield* Agents
	const launcher = yield* Launcher
	const gate = yield* Gate
	const work = Effect.serviceOption(Work).pipe(
		Effect.flatMap(Effect.fromOption),
	)
	/** The model step of the Turn. With the Turn, it names one tool call. */
	const modelStep = Effect.serviceOption(Agent.Context).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.succeed(0),
				onSome: (context) => context.step,
			}),
		),
	)
	const entry = (
		name: string,
		description: string,
		parameters: JsonSchema.JsonSchema,
		handle: (input: unknown) => Effect.Effect<Schema.Json, unknown>,
		needsApproval?: (
			input: unknown,
			context: Tool.NeedsApprovalContext,
		) => Effect.Effect<boolean>,
	): Entry => ({
		tool: Tool.dynamic(name, {
			description,
			parameters,
			success: Schema.Json,
			...(needsApproval === undefined ? {} : { needsApproval }),
		}) as Tools[string],
		handle: (input) =>
			handle(input).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("A Workflow tool failed", cause).pipe(
						Effect.as(
							json({ error: "The tool could not finish. Try another way." }),
						),
					),
				),
			),
	})
	/** A tool whose answer the Run reads from the history. The tool only checks the input. */
	const answer = <A, I>(
		name: string,
		description: string,
		parameters: JsonSchema.JsonSchema,
		schema: Schema.Codec<A, I>,
	) =>
		entry(name, description, parameters, (input) =>
			Schema.decodeUnknownEffect(schema)(input).pipe(
				Effect.as(json({ received: true })),
			),
		)
	const visible = Effect.gen(function* () {
		const current = yield* work
		return yield* workflows
			.list(current.caller, { archived: false })
			.pipe(Effect.provideContext(services))
	})
	/** Asks for each capability in turn. True when one of them must wait for a decision. */
	const anyPause = (checks: ReadonlyArray<Effect.Effect<"allow" | "pause">>) =>
		Effect.gen(function* () {
			for (const check of checks) if ((yield* check) === "pause") return true
			return false
		})
	const listEntry = entry(
		names.list,
		"List the Workflows that you can run, with their ids and nodes.",
		{ type: "object", properties: {} },
		() =>
			visible.pipe(
				Effect.map((list) =>
					json(
						list.map((workflow) => ({
							id: workflow.id,
							name: workflow.name,
							description: workflow.description,
							nodes: workflow.graph.nodes.map(
								(node) => node._tag + " " + node.id,
							),
						})),
					),
				),
			),
	)
	const runEntry = entry(
		names.run,
		`Start a Run of a Workflow. Use an id from ${names.list}. The Run goes on in the background, and its result comes to this Session as a new message.`,
		{
			type: "object",
			properties: {
				workflow: text,
				reason: {
					type: "string",
					description:
						"Why you need this. The decider above you reads it when it must agree first.",
				},
				input: {
					type: "object",
					description: "The input of the Run. Nodes read it as {{input.name}}.",
				},
			},
			required: ["workflow", "reason"],
		},
		(input) =>
			Effect.gen(function* () {
				const current = yield* work
				const request = yield* Schema.decodeUnknownEffect(RunInput)(input)
				const found = (yield* visible).find(
					(workflow) => workflow.id === request.workflow,
				)
				if (found === undefined)
					return json({
						error: `There is no Workflow with this id. Use ${names.list}.`,
					})
				// A handler does not know its tool call id. The Turn, the model step and the
				// Workflow name the call, so a second run of the same call finds the first Run.
				const step = yield* modelStep
				const run = yield* launcher.start({
					organizationId: current.caller.organizationId,
					userId: current.caller.userId,
					trigger: "agent",
					input: request.input ?? {},
					cache: "use",
					workflow: found,
					parent: {
						_tag: "Session",
						session: current.session,
						toolCallId: current.turn + "/" + step + "/" + found.id,
					},
				})
				return json({
					run: run.id,
					status: run.status,
					note: "The Run goes on. Its result comes as a new message.",
				})
			}),
		(input, context) =>
			Effect.gen(function* () {
				const request = yield* Schema.decodeUnknownEffect(RunInput)(input)
				const current = yield* work
				const found = (yield* visible).find(
					(workflow) => workflow.id === request.workflow,
				)
				// The handler explains a wrong id, so no decision is needed for it.
				if (found === undefined) return false
				const answer = yield* gate.check({
					capability: { action: "workflows.run", target: found.id },
					reason: request.reason,
					toolCallId: context.toolCallId,
					workflow: found,
					// An Agent may always run the Workflows that it owns.
					implicit:
						found.owner._tag === "Agent" &&
						found.owner.agent === current.agent.id,
				})
				return answer === "pause"
			}).pipe(Effect.orElseSucceed(() => true)),
	)
	const getRunEntry = entry(
		names.getRun,
		"Read a Workflow Run: its status and the result of each node.",
		{ type: "object", properties: { run: text }, required: ["run"] },
		(input) =>
			Effect.gen(function* () {
				const current = yield* work
				const request = yield* Schema.decodeUnknownEffect(GetRunInput)(input)
				const found = yield* runs.find(
					current.caller.organizationId,
					request.run,
				)
				// A member reads only their own Runs.
				if (
					Option.isNone(found) ||
					found.value.userId !== current.caller.userId
				)
					return json({ error: "There is no Run with this id." })
				const run = view(found.value)
				return json({
					id: run.id,
					workflow: run.workflow,
					revision: run.revision,
					status: run.status,
					error: run.error,
					nodes: run.nodes.map((node) => ({
						id: node.id,
						kind: node.kind,
						status: node.status,
						output: node.output,
						message: node.message,
					})),
					findings: run.findings,
				})
			}),
	)
	/**
	 * The capabilities that a plan needs: other Agents in its graph, and a Workflow that the
	 * Agent does not own. A plan of its own needs nothing more, like a Workflow that it owns.
	 */
	const planChecks = (request: PlanInput, toolCallId: string) =>
		Effect.gen(function* () {
			const current = yield* work
			const reason = request.reason ?? "To run the plan " + request.name + "."
			const checks: Array<Effect.Effect<"allow" | "pause">> = []
			for (const id of agentsOf(null, { nodes: request.nodes })) {
				if (id === current.agent.id) continue
				const target = yield* agents.find(current.caller.organizationId, id)
				checks.push(
					gate.check({
						capability: { action: "agents.delegate", target: id },
						reason,
						toolCallId,
						...(Option.isSome(target) ? { target: target.value } : {}),
					}),
				)
			}
			if (request.workflow !== undefined) {
				const found = yield* workflows.find(
					current.caller.organizationId,
					request.workflow,
				)
				const owned = Option.exists(
					found,
					(workflow) =>
						workflow.owner._tag === "Agent" &&
						workflow.owner.agent === current.agent.id,
				)
				if (Option.isSome(found) && !owned)
					checks.push(
						gate.check({
							capability: { action: "workflows.edit", target: found.value.id },
							reason,
							toolCallId,
							workflow: found.value,
						}),
						gate.check({
							capability: { action: "workflows.run", target: found.value.id },
							reason,
							toolCallId,
							workflow: found.value,
						}),
					)
			}
			return yield* anyPause(checks)
		})
	/** In a workflow Session, the node reads the plan from the history when the Turn ends. */
	const planInRun = entry(
		names.plan,
		"Write the plan of the current node as a Workflow graph. Call it once. OpenBot keeps it as your Workflow and runs it.",
		parametersOf(PlanInput),
		(input) =>
			Effect.gen(function* () {
				const request = yield* Schema.decodeUnknownEffect(PlanInput)(input)
				const problem = graphProblem({ nodes: request.nodes })
				if (problem !== undefined)
					return json({ error: problem + " Fix the plan and call again." })
				return json({
					received: true,
					note: "OpenBot runs the plan after this Turn.",
				})
			}),
		(input, context) =>
			Schema.decodeUnknownEffect(PlanInput)(input).pipe(
				Effect.flatMap((request) => planChecks(request, context.toolCallId)),
				Effect.orElseSucceed(() => true),
			),
	)
	/** In other Sessions, a plan becomes a Workflow of the Agent, and it runs at once. */
	const planInSession = entry(
		names.plan,
		`Plan work as a Workflow graph, not as text. OpenBot keeps the plan as your Workflow, runs it in the background, and sends the result to this Session as a new message. To change a plan, call again with its workflow id: a Run of it that goes on moves to the new revision.`,
		parametersOf(PlanInput),
		(input) =>
			Effect.gen(function* () {
				const current = yield* work
				const request = yield* Schema.decodeUnknownEffect(PlanInput)(input)
				const graph = { nodes: request.nodes }
				const problem = graphProblem(graph)
				if (problem !== undefined)
					return json({ error: problem + " Fix the plan and call again." })
				const organizationId = current.caller.organizationId
				if (
					request.workflow !== undefined &&
					Option.isNone(yield* workflows.find(organizationId, request.workflow))
				)
					return json({
						error:
							"There is no Workflow with this id. Leave out workflow to make a new plan.",
					})
				const step = yield* modelStep
				const callKey = current.turn + "/" + step + "/plan"
				const id = WorkflowsApi.WorkflowId.make(
					request.workflow ??
						"wfl_" + hash([current.session, callKey]).slice(0, 32),
				)
				const saved = yield* workflows.savePlan({
					organizationId,
					id,
					agent: current.agent,
					name: request.name,
					description: request.description ?? "",
					graph,
					origin: { _tag: "Session", session: current.session },
				})
				const earlier = yield* runs.list(organizationId, { workflowId: id })
				const open = earlier.find(
					(run) =>
						!terminal(run.status) &&
						run.parent?._tag === "Session" &&
						run.parent.session === current.session,
				)
				if (open !== undefined) {
					const revised = yield* launcher.revise(
						organizationId,
						open.id,
						saved.revision,
					)
					return json({
						workflow: saved.id,
						revision: saved.revision,
						run: revised.id,
						note: "The Run goes on with the new revision. Its result comes as a new message.",
					})
				}
				const run = yield* launcher.start({
					organizationId,
					userId: current.caller.userId,
					trigger: "agent",
					input: request.input ?? {},
					cache: "use",
					workflow: saved,
					parent: {
						_tag: "Session",
						session: current.session,
						toolCallId: callKey,
					},
					...(earlier[0] === undefined ? {} : { carry: earlier[0].body.nodes }),
				})
				return json({
					workflow: saved.id,
					revision: saved.revision,
					run: run.id,
					note: "The plan runs in the background. Its result comes as a new message.",
				})
			}),
		(input, context) =>
			Schema.decodeUnknownEffect(PlanInput)(input).pipe(
				Effect.flatMap((request) => planChecks(request, context.toolCallId)),
				Effect.orElseSucceed(() => true),
			),
	)
	const proceedEntry = entry(
		names.proceed,
		"OpenBot calls this tool when a Goal node used its token budget. Do not call it yourself.",
		{
			type: "object",
			properties: { workflow: text, reason: text },
			required: ["workflow", "reason"],
		},
		(input) =>
			Schema.decodeUnknownEffect(ProceedInput)(input).pipe(
				Effect.as(json({ approved: true })),
			),
		(input, context) =>
			Effect.gen(function* () {
				const request = yield* Schema.decodeUnknownEffect(ProceedInput)(input)
				const current = yield* work
				const found = yield* workflows.find(
					current.caller.organizationId,
					request.workflow,
				)
				const answer = yield* gate.check({
					capability: { action: "workflows.budget", target: request.workflow },
					reason: request.reason,
					toolCallId: context.toolCallId,
					...(Option.isSome(found) ? { workflow: found.value } : {}),
				})
				return answer === "pause"
			}).pipe(Effect.orElseSucceed(() => true)),
	)
	const runEntries: ReadonlyArray<Entry> = [
		answer(
			names.nodeResult,
			"Say that the current task node is done, or that it failed. Call it once.",
			{
				type: "object",
				properties: {
					status: { type: "string", enum: ["done", "failed"] },
					summary: text,
				},
				required: ["status", "summary"],
			},
			NodeResultInput,
		),
		answer(
			names.check,
			"Give the answer of the current check node. passed is true only when the condition is true now. When the node asks for a value, give it as value.",
			{
				type: "object",
				properties: {
					passed: { type: "boolean" },
					evidence: text,
					value: {},
				},
				required: ["passed", "evidence"],
			},
			CheckInput,
		),
		answer(
			names.finding,
			"Report one problem that you found while you worked on the node.",
			{
				type: "object",
				properties: {
					severity: { type: "string", enum: WorkflowsApi.Severity.literals },
					title: text,
					expected: text,
					observed: text,
					reproduction: { type: "array", items: text },
				},
				required: ["severity", "title", "expected", "observed", "reproduction"],
			},
			FindingInput,
		),
		proceedEntry,
	]
	return WorkflowPlugin.of({
		forOwner: (input) =>
			Plugin.make({ id: pluginId })<Tools>(() =>
				Effect.succeed((next, options) =>
					Stream.unwrap(
						Effect.gen(function* () {
							const context = yield* Agent.Context
							const at = yield* context.at
							const view = yield* input.read(at.session)
							const state = SessionHost.hostState(view.session)
							// A review decides one request, so it gets no Workflow tools.
							if (state.kind === "review") return next(options)
							const inRun = state.kind === "workflow"
							const entries = [
								listEntry,
								runEntry,
								getRunEntry,
								...(inRun ? [planInRun, ...runEntries] : [planInSession]),
							]
							const incoming = yield* options.toolkit
							const own = Toolkit.make(...entries.map((entry) => entry.tool))
							const handlers = yield* own.toHandlers(
								Record.fromEntries(
									entries.map((entry) => [entry.tool.name, entry.handle]),
								),
							)
							return next({
								...options,
								instructions: Prompt.concat(
									options.instructions,
									Prompt.make([
										{
											role: "system",
											content: inRun ? runInstructions : planInstructions,
										},
									]),
								),
								toolkit: Effect.succeed(Toolkit.merge(incoming, own)),
							}).pipe(Stream.provideContext(handlers))
							// Without its Session, a Turn cannot run, so it fails.
						}).pipe(Effect.orDie),
					),
				),
			),
	})
})
export const layer = Layer.effect(WorkflowPlugin, make)
