import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import { Config, type Item, Session, Turn } from "@openbot-build/core"
import { AgentsApi, type Identity, WorkflowsApi } from "@openbot-build/api"
import {
	Cause,
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	Predicate,
	Ref,
	Result,
	Schema,
} from "effect"
import type { Prompt } from "effect/ai"
import { DurableDeferred, WorkflowEngine } from "effect/workflow"
import { Backend } from "../app/Backend.ts"
import { ownerKey } from "../apps/StoredConnections.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { can } from "../authorization/Check.ts"
import { workflowKey } from "../authorization/Policy.ts"
import { Agents } from "../agents/Agents.ts"
import { hash } from "../capabilities/Capability.ts"
import { names as agentNames } from "../plugins/agents/AgentPlugin.ts"
import {
	CheckInput,
	FindingInput,
	NodeResultInput,
	PlanInput,
	names,
} from "../plugins/workflows/WorkflowPlugin.ts"
import {
	Launcher,
	type NodePayload,
	TurnEnded,
	turnEnded,
} from "./Execution.ts"
import { keyOf, Recordings } from "./Recordings.ts"
import {
	type Body,
	type Calls,
	type NodeState,
	Runs,
	type Stored,
	terminal,
	type Wait,
} from "./Runs.ts"
import * as Templates from "./Templates.ts"
import { outputSchema, Workflows } from "./Workflows.ts"

/** A task of a Run could not finish. The node, or the Run, ends as failed with this message. */
export class TaskFailed extends Schema.TaggedError<TaskFailed>()("TaskFailed", {
	message: Schema.String,
}) {}

/** Where a Run is. The scheduler gets it. */
export const Payload = Schema.Struct({
	organizationId: Schema.String,
	run: Schema.String,
})
export type Payload = typeof Payload.Type

/** How a task starts a Turn: with a message to the Agent, or with one exact tool call. */
export const Start = Schema.TaggedUnion({
	Message: {
		agent: AgentsApi.AgentId,
		text: Schema.String,
		model: Schema.optionalKey(Config.Selection),
	},
	Action: {
		agent: AgentsApi.AgentId,
		tool: Schema.String,
		arguments: Schema.JsonObject,
	},
})
export type Start = typeof Start.Type

/**
 * The Turns that an Agent does for a node.
 * `task`: work on a goal. `check`: look at a condition. `plan`: write a Workflow graph.
 * `accept`: check whether a Goal is reached. `budget`: ask to go on after the token budget.
 */
export const TurnKind = Schema.Literals([
	"task",
	"check",
	"plan",
	"accept",
	"budget",
])
export type TurnKind = typeof TurnKind.Type

/** What one start of a node does. The durable execution of the node follows it. */
export const Plan = Schema.TaggedUnion({
	/** The node has ended already, for example an `Expect` node, or this start is old. */
	Done: {},
	/** One exact tool call. */
	Call: { start: Start },
	/** Replay the recorded tool calls of a `Task` node. */
	Replay: {
		agent: AgentsApi.AgentId,
		calls: Schema.Array(
			Schema.Struct({ tool: Schema.String, arguments: Schema.JsonObject }),
		),
	},
	/** One Turn of an Agent. */
	Turn: { kind: TurnKind, start: Start },
	/** Turns that check again and again, with a pause between them. */
	Wait: {
		start: Start,
		attempts: Schema.Int,
		intervalSeconds: Schema.Int,
	},
	/** A `Wait` node. */
	Sleep: { seconds: Schema.Int },
	/** Start a child Run: a `Workflow` node, or a plan that passed before. */
	Child: {},
})
export type Plan = typeof Plan.Type

/** What comes after the work of a `Task` node: the end, or the Turn that checks it. */
export const Next = Schema.TaggedUnion({
	Done: {},
	Check: { start: Start },
})
export type Next = typeof Next.Type

/** The answer after one replayed call: go on, or let the Agent finish the goal. */
export const ReplayCheck = Schema.TaggedUnion({
	Ok: {},
	Handoff: { text: Schema.String },
})
export type ReplayCheck = typeof ReplayCheck.Type

/** OpenBot tools are not part of a recording. A replay calls only the tools that change things. */
const own = new Set<string>([
	...Object.values(names),
	...Object.values(agentNames),
])

const messagesOf = (
	history: ReadonlyArray<Item.Record>,
	turn: Turn.Id,
): ReadonlyArray<Prompt.Message> =>
	history
		.filter((entry) => entry.origin?.turn === turn)
		.flatMap((entry) => entry.content.content)

const toolCalls = (messages: ReadonlyArray<Prompt.Message>) =>
	messages.flatMap((message) =>
		message.role === "assistant" && typeof message.content !== "string"
			? message.content.filter((part) => part.type === "tool-call")
			: [],
	)
const toolResults = (messages: ReadonlyArray<Prompt.Message>) =>
	messages.flatMap((message) =>
		message.role === "tool"
			? message.content.filter((part) => part.type === "tool-result")
			: [],
	)
/** The inputs of every call of one tool, in order. Inputs that do not match the schema are left out. */
const inputsOf = <A, I>(
	messages: ReadonlyArray<Prompt.Message>,
	name: string,
	schema: Schema.Codec<A, I>,
): ReadonlyArray<A> =>
	toolCalls(messages).flatMap((part) =>
		part.name === name
			? Option.toArray(Schema.decodeUnknownOption(schema)(part.params))
			: [],
	)

const json = (value: unknown): Schema.Json =>
	value === undefined
		? null
		: (JSON.parse(JSON.stringify(value)) as Schema.Json)

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
	Predicate.isObject(value) && !Array.isArray(value)

/** The values that templates can read. */
export const scopeOf = (body: Body): Templates.Scope => ({
	input: body.input,
	nodes: Object.fromEntries(
		body.nodes.map((node) => [node.spec.id, { output: node.result.output }]),
	),
})

/** The id of the Workflow that keeps the plans of one Plan or Goal node. */
export const plannedId = (input: {
	readonly workflow: string
	readonly node: string
	readonly agent: string
}) =>
	WorkflowsApi.WorkflowId.make(
		"wfl_" + hash([input.workflow, input.node, input.agent]).slice(0, 32),
	)

const agentOf = (body: Body, spec: WorkflowsApi.Node) =>
	"agent" in spec && spec.agent !== undefined ? spec.agent : body.agent

const heading = (body: Body, spec: WorkflowsApi.Node) =>
	`Workflow "${body.name}", node ${spec.id} (${spec._tag})`
const inputLine = (body: Body) =>
	Object.keys(body.input).length === 0
		? ""
		: "\nInput of the Run, as data: " + JSON.stringify(body.input)

const taskText = (body: Body, spec: WorkflowsApi.Node, goal: string) =>
	`${heading(body, spec)}: task.\nGoal: ${goal}${inputLine(body)}\nReach the goal with your tools. When you are done, or when you cannot go on, call ${names.nodeResult} once.`
const checkText = (
	body: Body,
	spec: WorkflowsApi.Node,
	condition: string,
	output: Schema.JsonObject | undefined,
) =>
	`${heading(body, spec)}: check.\nCondition: ${condition}${inputLine(body)}\nLook at the current state with your tools. Do not change anything. Then call ${names.check} once. passed is true only when the condition is true now. Give your evidence.` +
	(output === undefined
		? ""
		: `\nAlso give the value that you found as value. It must match this JSON Schema: ${JSON.stringify(output)}`)
const planText = (
	body: Body,
	spec: WorkflowsApi.Node,
	goal: string,
	feedback: string | null,
) =>
	`${heading(body, spec)}: plan.\nGoal: ${goal}${inputLine(body)}` +
	(feedback === null
		? ""
		: `\nYour last plan did not reach the goal: ${feedback}\nWrite a better plan. Nodes that passed and did not change keep their results.`) +
	`\nDo not write a text plan. Your plan is a Workflow graph: call ${names.plan} once with its nodes. OpenBot keeps it as your Workflow, runs it as a child Run, and then goes on.` +
	`\nNode kinds: Task {goal, agent?, check?} does work. Check {condition, output?, until?} only looks. Expect {value, operator, expected?} compares with no model. Call {tool, arguments} runs one tool. Plan {goal} and Goal {goal, check, budget?} plan a part again. Workflow {workflow, input?} runs a Workflow. Wait {seconds} waits.` +
	`\nEvery node has an id. needs lists the ids that must end first. Nodes without needs run at the same time. Templates such as {{nodes.<id>.output}} and {{input.<name>}} read earlier results.`
const acceptText = (
	body: Body,
	spec: WorkflowsApi.Node,
	goal: string,
	condition: string,
) =>
	`${heading(body, spec)}: check.\nGoal: ${goal}\nCondition: ${condition}${inputLine(body)}\nThe last plan for this goal ended. Look at the current state with your tools. Do not change anything. Then call ${names.check} once. passed is true only when the condition is true now. Give your evidence.`
const handoffText = (input: {
	readonly body: Body
	readonly spec: WorkflowsApi.Node
	readonly goal: string
	readonly done: Calls
	readonly failed: Calls[number]
	readonly error: string
}) =>
	`${taskText(input.body, input.spec, input.goal)}\nOpenBot replayed tool calls that worked for this goal before. These calls ran: ${JSON.stringify(input.done)}. This call did not work: ${JSON.stringify(input.failed)}, with this result: ${input.error}. Look at the current state, and finish the goal from there.`

/** A failed node stops the Run, unless it says `onFail: continue`. */
const stops = (node: NodeState) =>
	node.result.status === "failed" && (node.spec.onFail ?? "fail") !== "continue"
/** A node after this one may run. */
const satisfied = (node: NodeState) =>
	node.result.status === "passed" ||
	(node.result.status === "failed" && node.spec.onFail === "continue") ||
	(node.result.status === "skipped" && node.skip === "when")
/** A node after this one never runs. */
const blocking = (node: NodeState) =>
	stops(node) || (node.result.status === "skipped" && node.skip !== "when")
const finished = (node: NodeState) =>
	node.result.status === "passed" ||
	node.result.status === "failed" ||
	node.result.status === "skipped"

/** The text that tells the Agent who started a Run how the Run ended. */
const endText = (run: Stored) => {
	const counts = run.body.nodes.reduce(
		(all, node) => ({
			...all,
			[node.result.status]: (all[node.result.status] ?? 0) + 1,
		}),
		{} as Record<string, number>,
	)
	return [
		`The Workflow Run ${run.id} ("${run.body.name}") ended with the status ${run.status}.`,
		`Nodes: ${Object.entries(counts)
			.map(([status, count]) => `${count} ${status}`)
			.join(", ")}.`,
		run.body.error === null ? "" : `Error: ${run.body.error}`,
		run.body.findings.length === 0
			? ""
			: `Findings: ${run.body.findings.map((finding) => `[${finding.severity}] ${finding.title}`).join("; ")}`,
		`Read the whole Run at /v1/workflow-runs/${run.id}.`,
	]
		.filter((line) => line.length > 0)
		.join("\n")
}

/** A short text of the end of a child Run, as the output of its node. */
const childSummary = (run: Stored) => ({
	run: run.id,
	status: run.status,
	nodes: Object.fromEntries(
		run.body.nodes.map((node) => [node.spec.id, node.result.output]),
	),
})

type ResultPatch = Partial<WorkflowsApi.NodeResult>

/** The work behind each task of the durable executions of Runs and nodes. */
export class Tasks extends Context.Service<
	Tasks,
	{
		/** Checks the Run and marks it as running. It returns false when the Run must not go on. */
		readonly prepare: (payload: Payload) => Effect.Effect<boolean, TaskFailed>
		/**
		 * One round of the scheduler: it skips nodes that cannot run, starts the nodes that can,
		 * and returns true when every node has ended.
		 */
		readonly tick: (
			payload: Payload,
			round: number,
		) => Effect.Effect<boolean, TaskFailed>
		readonly finish: (payload: Payload) => Effect.Effect<void, TaskFailed>
		/** Ends the Run as failed after a task could not finish. */
		readonly abort: (payload: Payload, message: string) => Effect.Effect<void>
		readonly plan: (payload: NodePayload) => Effect.Effect<Plan, TaskFailed>
		/**
		 * Starts the Turn of a task, once. It returns true when the Turn has ended already,
		 * so the execution does not wait for it.
		 */
		readonly start: (
			payload: NodePayload,
			task: string,
			start: Start,
			token: DurableDeferred.Token,
		) => Effect.Effect<boolean, TaskFailed>
		readonly collectCall: (
			payload: NodePayload,
			task: string,
		) => Effect.Effect<void, TaskFailed>
		readonly checkReplay: (
			payload: NodePayload,
			task: string,
			call: number,
			calls: Calls,
		) => Effect.Effect<ReplayCheck, TaskFailed>
		readonly replayed: (
			payload: NodePayload,
			calls: number,
		) => Effect.Effect<Next, TaskFailed>
		/** Reads the answer of the Agent for a `Task` node. */
		readonly collectTask: (
			payload: NodePayload,
			task: string,
			mode: "live" | "handed_off",
			replayed: Calls,
		) => Effect.Effect<Next, TaskFailed>
		/** Reads the check after a `Task` node. */
		readonly collectTaskCheck: (
			payload: NodePayload,
			task: string,
		) => Effect.Effect<void, TaskFailed>
		readonly collectCheck: (
			payload: NodePayload,
			task: string,
		) => Effect.Effect<void, TaskFailed>
		readonly collectWait: (
			payload: NodePayload,
			task: string,
			last: boolean,
		) => Effect.Effect<boolean, TaskFailed>
		/** Reads the plan of a Plan or Goal node, keeps it as a Workflow, and starts it. */
		readonly collectPlan: (
			payload: NodePayload,
			task: string,
		) => Effect.Effect<void, TaskFailed>
		readonly collectAccept: (
			payload: NodePayload,
			task: string,
		) => Effect.Effect<void, TaskFailed>
		readonly collectBudget: (
			payload: NodePayload,
			task: string,
		) => Effect.Effect<void, TaskFailed>
		readonly slept: (payload: NodePayload) => Effect.Effect<void, TaskFailed>
		readonly startChild: (
			payload: NodePayload,
		) => Effect.Effect<void, TaskFailed>
		/** Ends a node as failed after its execution could not finish. */
		readonly crash: (
			payload: NodePayload,
			message: string,
		) => Effect.Effect<void>
		/** Wakes the execution of a node when the Turn that it waits for has ended. */
		readonly wake: (wait: Wait) => Effect.Effect<void>
		/** Stops a Run, its executions, the Turns that it started and its child Runs. */
		readonly cancel: (
			organizationId: string,
			id: string,
		) => Effect.Effect<
			Option.Option<Stored>,
			WorkflowsApi.WorkflowStorageUnavailable
		>
		/** Starts again the executions of a Run that was open when the server stopped. */
		readonly recover: (run: Stored) => Effect.Effect<void>
	}
>()("@openbot-build/openbot/workflows/Tasks") {}

export const make: Effect.Effect<
	typeof Tasks.Service,
	never,
	| Launcher
	| Backend
	| Agents
	| Runs
	| Recordings
	| Workflows
	| AuditLog
	| WorkflowEngine.WorkflowEngine
	| AuthorizationServices
> = Effect.gen(function* () {
	const launcher = yield* Launcher
	const backend = yield* Backend
	const agents = yield* Agents
	const runs = yield* Runs
	const recordings = yield* Recordings
	const workflows = yield* Workflows
	const audit = yield* AuditLog
	const engine = yield* WorkflowEngine.WorkflowEngine
	const services = yield* Effect.context<AuthorizationServices>()

	const fail = (message: string) => TaskFailed.make({ message })
	/** Every failure of a task becomes TaskFailed with a short message. Interruption stays. */
	const task = <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	): Effect.Effect<A, TaskFailed, R> =>
		effect.pipe(
			Effect.catchCause((cause) => {
				if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
				const error = Cause.squash(cause)
				const message =
					Predicate.hasProperty(error, "message") &&
					typeof error.message === "string" &&
					error.message.length > 0
						? error.message
						: "OpenBot could not do a task of the Run."
				return Effect.logWarning("A task of a Workflow Run failed", cause).pipe(
					Effect.andThen(Effect.fail(fail(message))),
				)
			}),
		)
	const memberOf = (run: Stored): typeof Identity.Service => ({
		kind: "member",
		organizationId: run.organizationId,
		userId: run.userId,
	})
	const sessionsFor = (run: Stored) =>
		backend.get(ownerKey(memberOf(run)), memberOf(run))
	const now = Effect.clockWith((clock) => clock.currentTimeMillis)
	const load = (payload: Payload) =>
		runs.find(payload.organizationId, payload.run).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.fail(fail("The Run does not exist any more.")),
					onSome: Effect.succeed,
				}),
			),
		)
	const nodeOf = (run: Stored, id: string) =>
		run.body.nodes.find((node) => node.spec.id === id)
	/** The node of this start, while this start still owns it. */
	const ownOf = (run: Stored, payload: NodePayload) => {
		const node = nodeOf(run, payload.node)
		return node !== undefined && node.active && node.attempt === payload.attempt
			? node
			: undefined
	}
	const loadNode = (payload: NodePayload) =>
		Effect.gen(function* () {
			const run = yield* load(payload)
			const node = nodeOf(run, payload.node)
			if (node === undefined)
				return yield* fail("The node does not exist any more.")
			return { run, node }
		})
	const patchNode = (
		body: Body,
		id: string,
		change: (node: NodeState) => NodeState,
	): Body => ({
		...body,
		nodes: body.nodes.map((node) =>
			node.spec.id === id ? change(node) : node,
		),
	})
	/** The Sessions of a node are free again for other nodes. */
	const release = (body: Body, id: string): Body => ({
		...body,
		sessions: body.sessions.map((entry) =>
			entry.node === id ? { ...entry, node: null } : entry,
		),
	})
	/**
	 * Changes the Run with its row locked. With `wake`, the scheduler wakes in the round that
	 * the change saw, after the change is saved. It returns the Run after the change, and
	 * whether `update` changed it.
	 */
	const change = (
		payload: Payload,
		update: (run: Stored) => Option.Option<Stored>,
		wake = false,
	) =>
		Effect.gen(function* () {
			const changed = yield* Ref.make(false)
			const run = yield* runs
				.change(payload.organizationId, payload.run, (run) => {
					const next = update(run)
					return Option.isSome(next)
						? Ref.set(changed, true).pipe(Effect.as(next))
						: Effect.succeedNone
				})
				.pipe(
					Effect.flatMap(
						Option.match({
							onNone: () =>
								Effect.fail(fail("The Run does not exist any more.")),
							onSome: Effect.succeed,
						}),
					),
				)
			const done = yield* Ref.get(changed)
			if (done && wake) yield* launcher.wake(run, run.body.round)
			return { run, changed: done }
		})

	/** The model tokens of the Turns of a node and of its child Runs. */
	const tokensOf = (run: Stored, node: NodeState) =>
		Effect.gen(function* () {
			const sessions = yield* sessionsFor(run)
			let total = 0
			for (const ref of node.result.turns) {
				const found = yield* sessions
					.turn(ref.session, ref.turn)
					.pipe(Effect.option)
				if (Option.isNone(found)) continue
				for (const usage of found.value.turn.usage ?? [])
					total +=
						(usage.inputTokens.total ?? 0) + (usage.outputTokens.total ?? 0)
			}
			for (const child of node.result.children) {
				const found = yield* runs.find(run.organizationId, child)
				if (Option.isSome(found))
					total += found.value.body.nodes.reduce(
						(all, entry) => all + entry.result.tokens,
						0,
					)
			}
			return total
		})

	/** The state of a node after it ended. A failed node with attempts left waits to start again. */
	const ended = (
		node: NodeState,
		patch: ResultPatch & { readonly status: "passed" | "failed" },
		at: number,
	): NodeState => {
		const retry =
			patch.status === "failed" &&
			node.result.attempts < (node.spec.attempts ?? 1)
		return {
			...node,
			active: false,
			phase: retry ? "idle" : "done",
			result: {
				...node.result,
				...patch,
				status: retry ? "pending" : patch.status,
				finishedAt: retry ? null : at,
			},
		}
	}
	/** Ends the node of this start, and wakes the scheduler. An old start changes nothing. */
	const settle = (
		payload: NodePayload,
		patch: ResultPatch & { readonly status: "passed" | "failed" },
		body?: (body: Body) => Body,
	) =>
		Effect.gen(function* () {
			const at = yield* now
			const current = yield* load(payload)
			const node = ownOf(current, payload)
			if (node === undefined) return
			const tokens = yield* tokensOf(current, node)
			yield* change(
				payload,
				(run) => {
					if (ownOf(run, payload) === undefined) return Option.none()
					const next = patchNode(
						release((body ?? ((same) => same))(run.body), payload.node),
						payload.node,
						(node) => ended(node, { ...patch, tokens }, at),
					)
					return Option.some({ ...run, body: next })
				},
				true,
			)
		})
	/** The start of a node ends, and the node goes on in another phase later. */
	const handoff = (
		payload: NodePayload,
		update: (node: NodeState) => NodeState,
		body?: (body: Body) => Body,
	) =>
		Effect.gen(function* () {
			const current = yield* load(payload)
			const node = ownOf(current, payload)
			if (node === undefined) return
			const tokens = yield* tokensOf(current, node)
			yield* change(
				payload,
				(run) => {
					if (ownOf(run, payload) === undefined) return Option.none()
					const next = patchNode(
						release((body ?? ((same) => same))(run.body), payload.node),
						payload.node,
						(node) => {
							const updated = update(node)
							return {
								...updated,
								active: false,
								result: { ...updated.result, tokens },
							}
						},
					)
					return Option.some({ ...run, body: next })
				},
				true,
			)
		})
	/** Saves a patch of the result while the node goes on. */
	const note = (payload: NodePayload, patch: ResultPatch) =>
		change(payload, (run) =>
			ownOf(run, payload) === undefined
				? Option.none()
				: Option.some({
						...run,
						body: patchNode(run.body, payload.node, (node) => ({
							...node,
							result: { ...node.result, ...patch },
						})),
					}),
		)

	/** The nodes that a node needs, and the nodes that they need, and so on. */
	const closure = (body: Body, id: string) => {
		const found = new Set<string>([id])
		const visit = (current: string) => {
			const node = body.nodes.find((entry) => entry.spec.id === current)
			for (const need of node?.spec.needs ?? [])
				if (!found.has(need)) {
					found.add(need)
					visit(need)
				}
		}
		visit(id)
		return found
	}
	/**
	 * Writes the recordings that a passed check confirms: those of the nodes before the check.
	 * A `read` Run only forgets them. It returns the change of the body.
	 */
	const confirm = (run: Stored, id: string) =>
		Effect.gen(function* () {
			const before = closure(run.body, id)
			const entries = Object.entries(run.body.pending).filter(([node]) =>
				before.has(node),
			)
			if (run.body.cache === "use") {
				const at = yield* now
				for (const [node, pending] of entries)
					yield* recordings.put(run.organizationId, run.workflowId, {
						key: pending.key,
						node: node as WorkflowsApi.NodeId,
						calls: pending.calls,
						verifiedAt: at,
					})
			}
			return (body: Body): Body => ({
				...body,
				pending: Object.fromEntries(
					Object.entries(body.pending).filter(([node]) => !before.has(node)),
				),
			})
		})
	const findingsOf =
		(messages: ReadonlyArray<Prompt.Message>, node: WorkflowsApi.NodeId) =>
		(body: Body): Body => ({
			...body,
			findings: [
				...body.findings,
				...inputsOf(messages, names.finding, FindingInput).map(
					(finding): WorkflowsApi.Finding => ({ node, ...finding }),
				),
			],
		})
	const both =
		(...changes: ReadonlyArray<(body: Body) => Body>) =>
		(body: Body) =>
			changes.reduce((all, next) => next(all), body)

	/**
	 * A Session of an Agent for a node. The node keeps the Session while it works.
	 * Nodes that run at the same time get different Sessions, and a free Session is used again.
	 */
	const claim = (payload: NodePayload, agentId: AgentsApi.AgentId) =>
		Effect.gen(function* () {
			// The update runs inside the locked step, so it keeps its choice in a local variable.
			let picked: Session.Id | undefined
			const { run } = yield* change(payload, (run) => {
				const held = run.body.sessions.find(
					(entry) => entry.agent === agentId && entry.node === payload.node,
				)
				if (held !== undefined) {
					picked = held.session
					return Option.none()
				}
				const free = run.body.sessions.find(
					(entry) => entry.agent === agentId && entry.node === null,
				)
				if (free === undefined) return Option.none()
				picked = free.session
				return Option.some({
					...run,
					body: {
						...run.body,
						sessions: run.body.sessions.map((entry) =>
							entry === free
								? { ...entry, node: payload.node as WorkflowsApi.NodeId }
								: entry,
						),
					},
				})
			})
			if (picked !== undefined) return picked
			const agent = yield* agents.find(run.organizationId, agentId)
			if (Option.isNone(agent) || agent.value.archived)
				return yield* fail(`The Agent ${agentId} does not exist any more.`)
			const sessions = yield* sessionsFor(run)
			const view = yield* sessions.create({
				agent: agent.value,
				kind: "workflow",
				run: run.id,
				chain: {
					organizationId: run.organizationId,
					userId: run.userId,
					agents: [agent.value.id],
					sessions: [],
				},
				title: run.body.name.slice(0, 100),
			})
			yield* change(payload, (run) =>
				Option.some({
					...run,
					body: {
						...run.body,
						sessions: [
							...run.body.sessions,
							{
								agent: agentId,
								session: view.session.id,
								node: payload.node as WorkflowsApi.NodeId,
							},
						],
					},
				}),
			)
			return view.session.id
		})

	/** The Turn of a task, with the messages that it added to the history. */
	const turnOf = (payload: NodePayload, name: string) =>
		Effect.gen(function* () {
			const run = yield* load(payload)
			const ref = run.body.turns[name]
			if (ref === undefined) return yield* fail("The task has no Turn.")
			const sessions = yield* sessionsFor(run)
			const view = yield* sessions.get(ref.session)
			const { turn } = yield* sessions.turn(ref.session, ref.turn)
			const node = nodeOf(run, payload.node)
			if (node === undefined)
				return yield* fail("The node does not exist any more.")
			return {
				run,
				node,
				turn,
				messages: messagesOf(view.state.value.conversation.history, turn.id),
			}
		})
	const failureOf = (turn: Turn.Record) =>
		turn.status._tag === "Failed"
			? "The Turn failed: " + turn.status.message
			: turn.status._tag === "Interrupted"
				? "The Turn was stopped."
				: null
	/** The result of the one tool of a call Turn. */
	const callResult = (
		turn: Turn.Record,
		messages: ReadonlyArray<Prompt.Message>,
		tool: string,
	): Result.Result<Schema.Json, string> => {
		const failure = failureOf(turn)
		if (failure !== null) return Result.fail(failure)
		const result = toolResults(messages)
			.filter((part) => part.name === tool)
			.at(-1)
		if (result === undefined)
			return Result.fail(`The tool ${tool} gave no result.`)
		return result.isFailure
			? Result.fail(JSON.stringify(result.result))
			: Result.succeed(json(result.result))
	}
	/** Sends the end of a Run to the Agent that started it. */
	const tell = (run: Stored) =>
		Effect.gen(function* () {
			if (run.parent?._tag !== "Session") return
			const sessions = yield* sessionsFor(run)
			const view = yield* sessions.get(run.parent.session)
			const current = Session.currentTurn(view.session)
			const busy =
				current !== undefined &&
				(current.status._tag === "Running" || current.status._tag === "Waiting")
			const input = endText(run)
			if (busy) yield* sessions.enqueue(view.session.id, { input })
			else
				yield* sessions.send(view.session.id, {
					expected: view.session.revision,
					input,
				})
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("The end of a Workflow Run could not be sent", cause),
			),
		)

	/** Gives the end of a child Run to the node that started it. */
	const childEnded = (child: Stored) =>
		Effect.gen(function* () {
			if (child.parent?._tag !== "Run") return
			const parent = {
				organizationId: child.organizationId,
				run: child.parent.run,
			}
			const parentNode = child.parent.node
			const current = yield* load(parent)
			const node = nodeOf(current, parentNode)
			if (
				node === undefined ||
				node.child !== child.id ||
				node.phase !== "running"
			)
				return
			const tokens = yield* tokensOf(current, node)
			const at = yield* now
			const output = childSummary(child)
			const passed = child.status === "passed"
			yield* change(
				parent,
				(run) => {
					const entry = nodeOf(run, parentNode)
					if (
						entry === undefined ||
						entry.child !== child.id ||
						entry.phase !== "running"
					)
						return Option.none()
					const result = { ...entry.result, tokens, output }
					const failure =
						child.body.error ??
						child.body.replan ??
						`The child Run ${child.id} ended with the status ${child.status}.`
					const next = ((): NodeState => {
						const spec = entry.spec
						if (spec._tag === "Goal") {
							if (passed) return { ...entry, phase: "checking", result }
							return replan(entry, result, failure, at)
						}
						if (spec._tag === "Plan" && !passed && child.body.replan !== null)
							return replan(entry, result, child.body.replan, at)
						return ended(
							{ ...entry, result },
							passed
								? { status: "passed", message: null }
								: { status: "failed", message: failure },
							at,
						)
					})()
					return Option.some({
						...run,
						body: patchNode(run.body, entry.spec.id, () => next),
					})
				},
				true,
			)
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning(
					"The end of a child Run could not reach its node",
					cause,
				),
			),
		)
	/** A Plan or Goal node plans again, unless it used all its rounds. */
	const replan = (
		node: NodeState,
		result: WorkflowsApi.NodeResult,
		feedback: string,
		at: number,
	): NodeState => {
		const limit = node.spec.attempts
		if (limit !== undefined && result.round + 1 >= limit)
			return ended(
				{ ...node, result },
				{ status: "failed", message: feedback },
				at,
			)
		return {
			...node,
			phase: "planning",
			feedback,
			result: { ...result, round: result.round + 1, message: feedback },
		}
	}

	const ending = (run: Stored) =>
		audit
			.record({
				organizationId: run.organizationId,
				action: "workflow.run_finished",
				actor: memberOf(run),
				resource: run.id,
				details: { workflow: run.workflowId, status: run.status },
			})
			.pipe(
				Effect.ignore,
				Effect.andThen(tell(run)),
				Effect.andThen(childEnded(run)),
			)

	const prepare: typeof Tasks.Service.prepare = (payload) =>
		task(
			Effect.gen(function* () {
				const run = yield* load(payload)
				if (terminal(run.status)) return false
				// A scheduled Run or a webhook Run works for the actor, who must still be allowed to run it.
				if (run.trigger === "schedule" || run.trigger === "webhook") {
					const workflow = yield* workflows.find(
						run.organizationId,
						run.workflowId,
					)
					if (Option.isNone(workflow))
						return yield* fail("The Workflow does not exist any more.")
					const allowed = yield* can({
						caller: memberOf(run),
						permission: "workflows.run",
						key: workflowKey({
							...workflow.value,
							organizationId: run.organizationId,
						}),
					}).pipe(Effect.provideContext(services))
					if (!allowed)
						return yield* fail(
							"The actor of the Workflow may not run it any more.",
						)
				}
				const at = yield* now
				yield* change(payload, (current) =>
					Option.some({
						...current,
						status: "running",
						body: { ...current.body, startedAt: current.body.startedAt ?? at },
					}),
				)
				return true
			}),
		)

	/** The nodes after one round of the scheduler, and the nodes that it starts. */
	const schedule = (body: Body, at: number) => {
		const scope = scopeOf(body)
		let nodes = [...body.nodes]
		const starts: Array<{ node: WorkflowsApi.NodeId; attempt: number }> = []
		const byId = () => new Map(nodes.map((node) => [node.spec.id, node]))
		const set = (next: NodeState) => {
			nodes = nodes.map((node) => (node.spec.id === next.spec.id ? next : node))
		}
		let moved = true
		while (moved) {
			moved = false
			const all = byId()
			const stopping = nodes.some(stops)
			for (const node of nodes) {
				if (finished(node) || node.active || node.phase === "running") continue
				if (stopping) {
					set({
						...node,
						phase: "done",
						skip: "blocked",
						result: {
							...node.result,
							status: "skipped",
							message: node.result.message ?? "A node before it failed.",
						},
					})
					moved = true
					continue
				}
				const needs = (node.spec.needs ?? []).map((id) => all.get(id)!)
				if (needs.some(blocking)) {
					set({
						...node,
						phase: "done",
						skip: "blocked",
						result: {
							...node.result,
							status: "skipped",
							message: "A node that it needs did not pass.",
						},
					})
					moved = true
					continue
				}
				if (!needs.every(satisfied)) continue
				if (node.phase === "idle" && node.spec.when !== undefined) {
					const checked = Templates.condition(node.spec.when, scope)
					// A condition that cannot be checked is a mistake in the Workflow, so the node fails.
					if (Result.isFailure(checked)) {
						set(
							ended(
								{ ...node, result: { ...node.result, attempts: 1 } },
								{
									status: "failed",
									mode: "deterministic",
									message: checked.failure,
								},
								at,
							),
						)
						moved = true
						continue
					}
					if (!checked.success.passed) {
						set({
							...node,
							phase: "done",
							skip: "when",
							result: {
								...node.result,
								status: "skipped",
								message: "Its condition is not true: " + checked.success.reason,
								finishedAt: at,
							},
						})
						moved = true
						continue
					}
				}
				const attempt = node.attempt + 1
				set({
					...node,
					attempt,
					active: true,
					result: {
						...node.result,
						status: "running",
						attempts: node.result.attempts + (node.phase === "idle" ? 1 : 0),
						startedAt: node.result.startedAt ?? at,
					},
				})
				starts.push({ node: node.spec.id, attempt })
				moved = true
			}
		}
		const done =
			nodes.every(finished) ||
			(starts.length === 0 &&
				!nodes.some((node) => node.active || node.phase === "running"))
		return { nodes, starts, done }
	}

	const tick: typeof Tasks.Service.tick = (payload, round) =>
		task(
			Effect.gen(function* () {
				const at = yield* now
				// The update runs inside the locked step, so it keeps its answer in a local variable.
				let result: {
					readonly done: boolean
					readonly starts: ReadonlyArray<{
						readonly node: string
						readonly attempt: number
					}>
				} = { done: true, starts: [] }
				yield* change(payload, (run) => {
					if (terminal(run.status)) return Option.none()
					// A retry of the same round starts the same nodes again. That does nothing new.
					if (run.body.round === round && run.body.started.length > 0) {
						result = {
							done: run.body.nodes.every(finished),
							starts: run.body.started,
						}
						return Option.none()
					}
					const next = schedule(run.body, at)
					result = { done: next.done, starts: next.starts }
					return Option.some({
						...run,
						body: {
							...run.body,
							round,
							started: next.starts,
							nodes: next.nodes,
						},
					})
				})
				const { done, starts } = result
				// A new revision changed these nodes while they ran, so their old starts stop.
				const current = yield* load(payload)
				if (current.body.stale.length > 0) {
					yield* stopNodes(current, current.body.stale)
					const handled = new Set(
						current.body.stale.map((entry) => entry.node + "/" + entry.attempt),
					)
					yield* change(payload, (run) =>
						Option.some({
							...run,
							body: {
								...run.body,
								stale: run.body.stale.filter(
									(entry) => !handled.has(entry.node + "/" + entry.attempt),
								),
							},
						}),
					)
				}
				for (const start of starts)
					yield* launcher.startNode({
						organizationId: payload.organizationId,
						run: payload.run,
						node: start.node,
						attempt: start.attempt,
					})
				return done
			}),
		)

	/** Ends a Run. It fails when a node failed or when `error` says why it stopped. */
	const close = (payload: Payload, error: string | null) =>
		Effect.gen(function* () {
			const at = yield* now
			const { run, changed: closed } = yield* change(payload, (run) => {
				if (terminal(run.status)) return Option.none()
				const failed =
					error !== null || run.body.nodes.some((node) => stops(node))
				const replan = run.body.nodes.find(
					(node) =>
						node.result.status === "failed" && node.spec.onFail === "replan",
				)
				return Option.some<Stored>({
					...run,
					status: failed ? "failed" : "passed",
					finishedAt: at,
					body: {
						...run.body,
						error,
						replan:
							replan === undefined
								? null
								: `The node ${replan.spec.id} failed: ${replan.result.message ?? "no message"}`,
						nodes: run.body.nodes.map((node) =>
							finished(node)
								? node
								: {
										...node,
										active: false,
										phase: "done",
										skip: "blocked",
										result: {
											...node.result,
											status:
												node.result.status === "running" ? "failed" : "skipped",
											message: error ?? node.result.message,
											finishedAt: at,
										},
									},
						),
					},
				})
			})
			if (!closed) return
			if (run.status === "passed")
				yield* workflows
					.passed(run.organizationId, run.workflowId, run.body.revision)
					.pipe(Effect.ignore)
			yield* ending(run)
		})

	const finish: typeof Tasks.Service.finish = (payload) =>
		task(close(payload, null))
	const abort: typeof Tasks.Service.abort = (payload, message) =>
		close(payload, message).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("A failed Workflow Run could not be closed", cause),
			),
		)

	const plan: typeof Tasks.Service.plan = (payload) =>
		task(
			Effect.gen(function* () {
				const run = yield* load(payload)
				const node = ownOf(run, payload)
				if (node === undefined) return { _tag: "Done" } as const
				const body = run.body
				const spec = node.spec
				const scope = scopeOf(body)
				const agent = agentOf(body, spec)
				const model = body.judge === undefined ? {} : { model: body.judge }
				const broken = (message: string) =>
					settle(payload, {
						status: "failed",
						mode: "deterministic",
						message,
					}).pipe(Effect.as<Plan>({ _tag: "Done" }))
				const rendered = (template: string) => Templates.text(template, scope)
				const message = (
					kind: TurnKind,
					text: string,
					judged = false,
				): Plan => ({
					_tag: "Turn",
					kind,
					start: {
						_tag: "Message",
						agent,
						text,
						...(judged ? model : {}),
					},
				})
				switch (spec._tag) {
					case "Expect": {
						const checked = Templates.expect(spec, scope)
						if (Result.isFailure(checked)) return yield* broken(checked.failure)
						const confirmed = yield* confirm(run, spec.id)
						yield* settle(
							payload,
							{
								status: "passed",
								mode: "deterministic",
								output: checked.success,
							},
							confirmed,
						)
						return { _tag: "Done" } as const
					}
					case "Call": {
						const args = Templates.json(spec.arguments, scope)
						if (Result.isFailure(args)) return yield* broken(args.failure)
						if (!isJsonObject(args.success))
							return yield* broken("The arguments must be a JSON object.")
						return {
							_tag: "Call",
							start: {
								_tag: "Action",
								agent,
								tool: spec.tool,
								arguments: args.success,
							},
						} as const
					}
					case "Wait":
						return { _tag: "Sleep", seconds: spec.seconds } as const
					case "Workflow":
						return { _tag: "Child" } as const
					case "Task": {
						const goal = rendered(spec.goal)
						if (Result.isFailure(goal)) return yield* broken(goal.failure)
						if (body.cache !== "off") {
							const recorded = yield* recordings.find(
								run.organizationId,
								run.workflowId,
								keyOf({ node: spec.id, goal: goal.success, agent }),
							)
							if (Option.isSome(recorded) && recorded.value.length > 0)
								return { _tag: "Replay", agent, calls: recorded.value } as const
						}
						return message("task", taskText(body, spec, goal.success))
					}
					case "Check": {
						const condition = rendered(spec.condition)
						if (Result.isFailure(condition))
							return yield* broken(condition.failure)
						const text = checkText(body, spec, condition.success, spec.output)
						if (spec.until === undefined) return message("check", text, true)
						return {
							_tag: "Wait",
							start: { _tag: "Message", agent, text, ...model },
							attempts:
								Math.floor(
									spec.until.timeoutSeconds / spec.until.intervalSeconds,
								) + 1,
							intervalSeconds: spec.until.intervalSeconds,
						} as const
					}
					case "Plan":
					case "Goal": {
						const goal = rendered(spec.goal)
						if (Result.isFailure(goal)) return yield* broken(goal.failure)
						if (spec._tag === "Goal" && node.phase === "checking") {
							const condition = rendered(spec.check)
							if (Result.isFailure(condition))
								return yield* broken(condition.failure)
							return message(
								"accept",
								acceptText(body, spec, goal.success, condition.success),
								true,
							)
						}
						if (spec._tag === "Goal" && node.allowed !== null) {
							const tokens = yield* tokensOf(run, node)
							if (tokens >= node.allowed)
								return {
									_tag: "Turn",
									kind: "budget",
									start: {
										_tag: "Action",
										agent,
										tool: names.proceed,
										arguments: {
											workflow: run.workflowId,
											reason: `The Goal node ${spec.id} used ${tokens} model tokens. Its budget is ${node.allowed}. It has not reached its goal yet: ${node.feedback ?? goal.success}`,
										},
									},
								} as const
						}
						// The first round uses a plan that passed before, with no model.
						if (body.cache !== "off" && node.phase === "idle") {
							const planned = yield* workflows.find(
								run.organizationId,
								plannedId({
									workflow: run.workflowId,
									node: spec.id,
									agent,
								}),
							)
							if (
								Option.isSome(planned) &&
								planned.value.passedRevision !== null
							) {
								yield* change(payload, (current) =>
									ownOf(current, payload) === undefined
										? Option.none()
										: Option.some({
												...current,
												body: patchNode(current.body, spec.id, (entry) => ({
													...entry,
													plan: {
														workflow: planned.value.id,
														revision: planned.value.passedRevision!,
													},
													result: { ...entry.result, mode: "replayed" },
												})),
											}),
								)
								return { _tag: "Child" } as const
							}
						}
						return message(
							"plan",
							planText(body, spec, goal.success, node.feedback),
						)
					}
				}
			}),
		)

	/** The status of a Turn, when the Turn has ended. */
	const endedStatus = (run: Stored, session: Session.Id, turn: string) =>
		sessionsFor(run).pipe(
			Effect.flatMap((sessions) => sessions.turn(session, Turn.Id.make(turn))),
			Effect.map(({ turn }) =>
				Option.filter(
					Option.some(turn.status._tag),
					(status): status is TurnEnded => Schema.is(TurnEnded)(status),
				),
			),
		)

	const start: typeof Tasks.Service.start = (payload, name, start, token) =>
		task(
			Effect.gen(function* () {
				let run = yield* load(payload)
				let ref = run.body.turns[name]
				if (ref === undefined) {
					if (ownOf(run, payload) === undefined)
						return yield* fail("This start of the node is old.")
					const session = yield* claim(payload, start.agent)
					const sessions = yield* sessionsFor(run)
					const view = yield* sessions.get(session)
					const turn =
						start._tag === "Message"
							? (yield* sessions.send(session, {
									expected: view.session.revision,
									input: start.text,
									...(start.model === undefined
										? {}
										: { overrides: { model: start.model } }),
								})).id
							: (yield* sessions.startAction(session, {
									expected: view.session.revision,
									action: { name: start.tool, arguments: start.arguments },
								})).turn
					const started = { session, turn }
					ref = started
					run = (yield* change(payload, (current) => {
						const body = patchNode(current.body, payload.node, (node) => ({
							...node,
							result: {
								...node.result,
								turns: [...node.result.turns, started],
							},
						}))
						return Option.some({
							...current,
							body: { ...body, turns: { ...body.turns, [name]: started } },
						})
					})).run
				}
				const wait = {
					organizationId: run.organizationId,
					run: run.id,
					task: name,
					session: ref.session,
					turn: ref.turn,
					token,
				}
				yield* runs.wait(wait)
				// The Turn may have ended before the wait was saved. Then nobody else wakes the execution.
				const status = yield* endedStatus(run, ref.session, ref.turn)
				if (Option.isNone(status)) return false
				return yield* runs.unwait(wait)
			}),
		)

	const collectCall: typeof Tasks.Service.collectCall = (payload, name) =>
		task(
			Effect.gen(function* () {
				const { node, turn, messages } = yield* turnOf(payload, name)
				if (node.spec._tag !== "Call")
					return yield* fail("The node is not a call.")
				const result = callResult(turn, messages, node.spec.tool)
				yield* settle(
					payload,
					Result.isSuccess(result)
						? {
								status: "passed",
								mode: "deterministic",
								output: result.success,
							}
						: {
								status: "failed",
								mode: "deterministic",
								message: result.failure,
							},
				)
			}),
		)

	const goalOf = (run: Stored, spec: WorkflowsApi.Node) =>
		spec._tag === "Task"
			? Result.getOrElse(
					Templates.text(spec.goal, scopeOf(run.body)),
					() => spec.goal,
				)
			: ""

	const checkReplay: typeof Tasks.Service.checkReplay = (
		payload,
		name,
		call,
		calls,
	) =>
		task(
			Effect.gen(function* () {
				const { run, node, turn, messages } = yield* turnOf(payload, name)
				const recorded = calls[call]!
				const result = callResult(turn, messages, recorded.tool)
				if (Result.isSuccess(result)) return { _tag: "Ok" } as const
				return {
					_tag: "Handoff",
					text: handoffText({
						body: run.body,
						spec: node.spec,
						goal: goalOf(run, node.spec),
						done: calls.slice(0, call),
						failed: recorded,
						error: result.failure,
					}),
				} as const
			}),
		)

	/** After a `Task` node did its work: the end, or a check of its own. */
	const afterTask = (
		payload: NodePayload,
		run: Stored,
		node: NodeState,
		patch: Omit<ResultPatch, "status">,
		body: (body: Body) => Body,
	) =>
		Effect.gen(function* () {
			if (node.spec._tag !== "Task" || node.spec.check === undefined) {
				yield* settle(payload, { status: "passed", ...patch }, body)
				return { _tag: "Done" } as const
			}
			const condition = Result.getOrElse(
				Templates.text(node.spec.check, scopeOf(run.body)),
				() => (node.spec as { readonly check: string }).check,
			)
			yield* change(payload, (current) =>
				ownOf(current, payload) === undefined
					? Option.none()
					: Option.some({
							...current,
							body: patchNode(body(current.body), payload.node, (entry) => ({
								...entry,
								result: { ...entry.result, ...patch },
							})),
						}),
			)
			return {
				_tag: "Check",
				start: {
					_tag: "Message",
					agent: agentOf(run.body, node.spec),
					text: checkText(run.body, node.spec, condition, undefined),
					...(run.body.judge === undefined ? {} : { model: run.body.judge }),
				},
			} as const
		})

	const replayed: typeof Tasks.Service.replayed = (payload, calls) =>
		task(
			Effect.gen(function* () {
				const { run, node } = yield* loadNode(payload)
				return yield* afterTask(
					payload,
					run,
					node,
					{
						mode: "replayed",
						message: `OpenBot replayed ${calls} recorded tool calls.`,
					},
					(body) => body,
				)
			}),
		)

	const collectTask: typeof Tasks.Service.collectTask = (
		payload,
		name,
		mode,
		done,
	) =>
		task(
			Effect.gen(function* () {
				const { run, node, turn, messages } = yield* turnOf(payload, name)
				const spec = node.spec
				if (spec._tag !== "Task") return yield* fail("The node is not a task.")
				const findings = findingsOf(messages, spec.id)
				const failure = failureOf(turn)
				if (failure !== null) {
					yield* settle(
						payload,
						{ status: "failed", mode, message: failure },
						findings,
					)
					return { _tag: "Done" } as const
				}
				const text =
					turn.status._tag === "Completed" ? turn.status.result.text : ""
				const report = inputsOf(messages, names.nodeResult, NodeResultInput).at(
					-1,
				)
				const passed = report === undefined || report.status === "done"
				if (!passed) {
					yield* settle(
						payload,
						{
							status: "failed",
							mode,
							output: report?.summary ?? text,
							message: report?.summary ?? null,
						},
						findings,
					)
					return { _tag: "Done" } as const
				}
				const results = toolResults(messages)
				const calls: Calls = [
					...done,
					...toolCalls(messages).flatMap((part) =>
						!own.has(part.name) &&
						isJsonObject(json(part.params)) &&
						results.some((result) => result.id === part.id && !result.isFailure)
							? [
									{
										tool: part.name,
										arguments: json(part.params) as Schema.JsonObject,
									},
								]
							: [],
					),
				]
				const key = keyOf({
					node: spec.id,
					goal: goalOf(run, spec),
					agent: agentOf(run.body, spec),
				})
				const pending = (body: Body): Body =>
					body.cache === "use" && calls.length > 0
						? {
								...body,
								pending: { ...body.pending, [spec.id]: { key, calls } },
							}
						: body
				return yield* afterTask(
					payload,
					run,
					node,
					{
						mode,
						output: report?.summary ?? text,
						message: report?.summary ?? null,
					},
					both(findings, pending),
				)
			}),
		)

	/** The answer of a check Turn: whether it passed, its evidence, and a value. */
	const checkOf = (
		turn: Turn.Record,
		messages: ReadonlyArray<Prompt.Message>,
	) => {
		const check = inputsOf(messages, names.check, CheckInput).at(-1)
		const failure = failureOf(turn)
		return {
			check,
			passed: failure === null && check?.passed === true,
			evidence:
				failure ?? check?.evidence ?? `The Agent did not call ${names.check}.`,
		}
	}

	const collectTaskCheck: typeof Tasks.Service.collectTaskCheck = (
		payload,
		name,
	) =>
		task(
			Effect.gen(function* () {
				const { run, node, turn, messages } = yield* turnOf(payload, name)
				const { passed, evidence } = checkOf(turn, messages)
				const findings = findingsOf(messages, node.spec.id)
				if (!passed) {
					yield* settle(
						payload,
						{ status: "failed", message: evidence },
						both(findings, (body) => ({
							...body,
							pending: Object.fromEntries(
								Object.entries(body.pending).filter(
									([id]) => id !== node.spec.id,
								),
							),
						})),
					)
					return
				}
				const confirmed = yield* confirm(run, node.spec.id)
				yield* settle(payload, { status: "passed" }, both(findings, confirmed))
			}),
		)

	const collectCheck: typeof Tasks.Service.collectCheck = (payload, name) =>
		task(
			Effect.gen(function* () {
				const { run, node, turn, messages } = yield* turnOf(payload, name)
				const spec = node.spec
				if (spec._tag !== "Check")
					return yield* fail("The node is not a check.")
				const findings = findingsOf(messages, spec.id)
				const { check, passed, evidence } = checkOf(turn, messages)
				if (spec.output !== undefined && passed) {
					const schema = outputSchema(spec.output)
					const valid = Result.isSuccess(schema)
						? Schema.decodeOption(schema.success as Schema.Decoder<unknown>)(
								check?.value,
							)
						: Option.none()
					if (Option.isNone(valid)) {
						yield* settle(
							payload,
							{
								status: "failed",
								mode: "live",
								output: check?.value ?? null,
								message:
									"The value does not match the output schema of the node.",
							},
							findings,
						)
						return
					}
				}
				const confirmed = passed
					? yield* confirm(run, spec.id)
					: (body: Body) => body
				yield* settle(
					payload,
					{
						status: passed ? "passed" : "failed",
						mode: "live",
						output:
							spec.output === undefined ? evidence : (check?.value ?? null),
						message: evidence,
					},
					both(findings, confirmed),
				)
			}),
		)

	const collectWait: typeof Tasks.Service.collectWait = (payload, name, last) =>
		task(
			Effect.gen(function* () {
				const { run, node, turn, messages } = yield* turnOf(payload, name)
				const spec = node.spec
				const { passed, evidence } = checkOf(turn, messages)
				if (passed) {
					const confirmed = yield* confirm(run, spec.id)
					yield* settle(
						payload,
						{
							status: "passed",
							mode: "live",
							output: evidence,
							message: evidence,
						},
						confirmed,
					)
					return true
				}
				if (last) {
					yield* settle(payload, {
						status: "failed",
						mode: "live",
						message: `The condition was not true within ${spec._tag === "Check" && spec.until !== undefined ? spec.until.timeoutSeconds : 0} seconds. Last evidence: ${evidence}`,
					})
					return false
				}
				yield* note(payload, { mode: "live", message: evidence })
				return false
			}),
		)

	const slept: typeof Tasks.Service.slept = (payload) =>
		task(settle(payload, { status: "passed", mode: "deterministic" }))

	/**
	 * Starts the child Run of a node: its Workflow, or the plan of its round. The node saves the
	 * child before the child starts, so the end of the child always finds its node.
	 */
	const startChild: typeof Tasks.Service.startChild = (payload) =>
		task(
			Effect.gen(function* () {
				const { run, node } = yield* loadNode(payload)
				const spec = node.spec
				const key = `${spec.id}/${payload.attempt}/${node.result.round}`
				const existing = node.child
				const target =
					spec._tag === "Workflow"
						? { workflow: spec.workflow, revision: undefined }
						: node.plan === null
							? undefined
							: { workflow: node.plan.workflow, revision: node.plan.revision }
				if (target === undefined)
					return yield* fail("The node has no plan to run.")
				const found = yield* workflows.find(run.organizationId, target.workflow)
				if (Option.isNone(found) || found.value.archived)
					return yield* settle(payload, {
						status: "failed",
						mode: "deterministic",
						message: `The Workflow ${target.workflow} does not exist, or it is archived.`,
					})
				const workflow = found.value
				if (spec._tag === "Workflow") {
					const allowed = yield* can({
						caller: memberOf(run),
						permission: "workflows.run",
						key: workflowKey({
							...workflow,
							organizationId: run.organizationId,
						}),
					}).pipe(Effect.provideContext(services))
					if (!allowed)
						return yield* settle(payload, {
							status: "failed",
							mode: "deterministic",
							message: `The member of the Run may not run the Workflow ${workflow.id}.`,
						})
				}
				const definition =
					target.revision === undefined || target.revision === workflow.revision
						? undefined
						: yield* workflows.revision(
								run.organizationId,
								workflow.id,
								target.revision,
							)
				if (definition !== undefined && Option.isNone(definition))
					return yield* fail("The revision of the plan does not exist.")
				const input =
					spec._tag === "Workflow" && spec.input !== undefined
						? Templates.json(spec.input, scopeOf(run.body))
						: Result.succeed(run.body.input as Schema.Json)
				if (Result.isFailure(input) || !isJsonObject(input.success))
					return yield* settle(payload, {
						status: "failed",
						mode: "deterministic",
						message: Result.isFailure(input)
							? input.failure
							: "The input must be a JSON object.",
					})
				// The child of the last round gives its passed nodes to the new child.
				const previous =
					existing === null
						? Option.none<Stored>()
						: yield* runs.find(run.organizationId, existing)
				const child = yield* launcher.create({
					organizationId: run.organizationId,
					userId: run.userId,
					trigger: spec._tag === "Workflow" ? "workflow" : "plan",
					input: input.success,
					cache: run.body.cache,
					workflow,
					...(definition === undefined
						? {}
						: {
								revision: {
									revision: target.revision!,
									definition: definition.value,
								},
							}),
					parent: {
						_tag: "Run",
						run: run.id,
						node: spec.id,
						key,
					},
					...(Option.isSome(previous) &&
					previous.value.workflowId === workflow.id
						? { carry: previous.value.body.nodes }
						: {}),
				})
				yield* handoff(payload, (entry) => ({
					...entry,
					phase: "running",
					child: child.id,
					result: {
						...entry.result,
						mode: entry.result.mode ?? "live",
						children: entry.result.children.includes(child.id)
							? entry.result.children
							: [...entry.result.children, child.id],
					},
				}))
				yield* launcher.resume(child)
			}),
		)

	const collectPlan: typeof Tasks.Service.collectPlan = (payload, name) =>
		task(
			Effect.gen(function* () {
				const { run, node, turn, messages } = yield* turnOf(payload, name)
				const spec = node.spec
				const findings = findingsOf(messages, spec.id)
				const failure = failureOf(turn)
				const planned = inputsOf(messages, names.plan, PlanInput).at(-1)
				if (failure !== null || planned === undefined) {
					yield* settle(
						payload,
						{
							status: "failed",
							mode: "live",
							message:
								failure ?? `The Agent did not write a plan with ${names.plan}.`,
						},
						findings,
					)
					return
				}
				const agentId = agentOf(run.body, spec)
				const agent = yield* agents.find(run.organizationId, agentId)
				if (Option.isNone(agent))
					return yield* fail(`The Agent ${agentId} does not exist any more.`)
				const saved = yield* workflows
					.savePlan({
						organizationId: run.organizationId,
						id: plannedId({
							workflow: run.workflowId,
							node: spec.id,
							agent: agentId,
						}),
						agent: agent.value,
						name: planned.name,
						description: planned.description ?? "",
						graph: { nodes: planned.nodes },
						origin: {
							_tag: "Plan",
							workflow: run.workflowId,
							run: run.id,
							node: spec.id,
						},
						...(run.body.judge === undefined ? {} : { judge: run.body.judge }),
					})
					.pipe(Effect.result)
				if (Result.isFailure(saved)) {
					yield* settle(
						payload,
						{
							status: "failed",
							mode: "live",
							message:
								saved.failure._tag === "WorkflowInvalid"
									? "The plan is not a valid graph: " + saved.failure.message
									: "OpenBot could not save the plan.",
						},
						findings,
					)
					return
				}
				yield* change(payload, (current) =>
					ownOf(current, payload) === undefined
						? Option.none()
						: Option.some({
								...current,
								body: patchNode(findings(current.body), spec.id, (entry) => ({
									...entry,
									plan: {
										workflow: saved.success.id,
										revision: saved.success.revision,
									},
									result: {
										...entry.result,
										output: {
											workflow: saved.success.id,
											revision: saved.success.revision,
										},
									},
								})),
							}),
				)
				yield* startChild(payload)
			}),
		)

	const collectAccept: typeof Tasks.Service.collectAccept = (payload, name) =>
		task(
			Effect.gen(function* () {
				const { node, turn, messages } = yield* turnOf(payload, name)
				const findings = findingsOf(messages, node.spec.id)
				const { passed, evidence } = checkOf(turn, messages)
				if (passed) {
					yield* settle(
						payload,
						{ status: "passed", message: evidence },
						findings,
					)
					return
				}
				const at = yield* now
				yield* handoff(
					payload,
					(entry) => replan(entry, entry.result, evidence, at),
					findings,
				)
			}),
		)

	const collectBudget: typeof Tasks.Service.collectBudget = (payload, name) =>
		task(
			Effect.gen(function* () {
				const { run, node, turn, messages } = yield* turnOf(payload, name)
				const result = callResult(turn, messages, names.proceed)
				if (Result.isFailure(result)) {
					yield* settle(payload, {
						status: "failed",
						message: "The Goal may not use more tokens: " + result.failure,
					})
					return
				}
				// The approval gives one more budget, counted from the tokens used so far.
				const budget =
					node.spec._tag === "Goal" ? (node.spec.budget?.tokens ?? 0) : 0
				const used = yield* tokensOf(run, node)
				yield* handoff(payload, (entry) => ({
					...entry,
					allowed: Math.max(entry.allowed ?? 0, used) + budget,
				}))
			}),
		)

	const crash: typeof Tasks.Service.crash = (payload, message) =>
		settle(payload, { status: "failed", message }).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("A failed node could not be closed", cause),
			),
		)

	const wake: typeof Tasks.Service.wake = (wait) =>
		Effect.gen(function* () {
			const run = yield* runs.find(wait.organizationId, wait.run)
			if (Option.isNone(run)) return
			const status = yield* endedStatus(run.value, wait.session, wait.turn)
			if (Option.isNone(status)) return
			if (!(yield* runs.unwait(wait))) return
			yield* DurableDeferred.done(turnEnded(wait.task), {
				token: DurableDeferred.Token.make(wait.token),
				exit: Exit.succeed(status.value),
			}).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine))
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("A Workflow node could not be woken", cause),
			),
		)

	/** Stops the current Turns of these Sessions. */
	const stopTurns = (run: Stored, list: ReadonlyArray<Session.Id>) =>
		Effect.gen(function* () {
			const sessions = yield* sessionsFor(run).pipe(Effect.option)
			if (Option.isNone(sessions)) return
			for (const session of list) {
				const view = yield* sessions.value.get(session).pipe(Effect.option)
				const current = Option.flatMap(view, (view) =>
					Option.fromNullishOr(Session.currentTurn(view.session)),
				)
				if (
					Option.isSome(current) &&
					(current.value.status._tag === "Running" ||
						current.value.status._tag === "Waiting")
				)
					yield* sessions.value
						.interrupt(session, current.value.id)
						.pipe(Effect.ignore)
			}
		})
	/** Stops starts of nodes: their executions, their waits, their Turns and their child Runs. */
	const stopNodes = (
		run: Stored,
		stale: Body["stale"],
	): Effect.Effect<void, WorkflowsApi.WorkflowStorageUnavailable> =>
		Effect.gen(function* () {
			const starts = new Set(
				stale.map((entry) => entry.node + "/" + entry.attempt + "/"),
			)
			for (const entry of stale)
				if (entry.active)
					yield* launcher.interruptNode({
						organizationId: run.organizationId,
						run: run.id,
						node: entry.node,
						attempt: entry.attempt,
					})
			for (const wait of yield* runs.waitsOf(run.organizationId, run.id))
				if ([...starts].some((start) => wait.task.startsWith(start)))
					yield* runs.unwait(wait)
			yield* stopTurns(
				run,
				stale.flatMap((entry) => entry.sessions),
			)
			for (const entry of stale)
				if (entry.child !== null) yield* cancel(run.organizationId, entry.child)
		})

	const cancel: typeof Tasks.Service.cancel = (organizationId, id) =>
		Effect.gen(function* () {
			const at = yield* now
			const closed = yield* Ref.make(false)
			const before = yield* runs.find(organizationId, id)
			const run = yield* runs.change(organizationId, id, (run) =>
				terminal(run.status)
					? Effect.succeedNone
					: Ref.set(closed, true).pipe(
							Effect.as(
								Option.some<Stored>({
									...run,
									status: "cancelled",
									finishedAt: at,
									body: {
										...run.body,
										nodes: run.body.nodes.map((node) =>
											finished(node)
												? node
												: {
														...node,
														active: false,
														phase: "done",
														skip: "blocked",
														result: {
															...node.result,
															status: "skipped",
															message: "The Run was cancelled.",
														},
													},
										),
									},
								}),
							),
						),
			)
			if (Option.isNone(run) || !(yield* Ref.get(closed))) return run
			yield* launcher.interrupt(run.value)
			if (Option.isSome(before))
				yield* stopNodes(run.value, [
					...before.value.body.stale,
					...before.value.body.nodes
						.filter((node) => node.active || node.phase === "running")
						.map((node) => ({
							node: node.spec.id,
							attempt: node.attempt,
							active: node.active,
							child: node.phase === "running" ? node.child : null,
							sessions: [],
						})),
				])
			yield* stopTurns(
				run.value,
				run.value.body.sessions.map((entry) => entry.session),
			)
			yield* ending(run.value)
			return run
		})

	const recover: typeof Tasks.Service.recover = (run) =>
		Effect.gen(function* () {
			yield* launcher.resume(run)
			for (const node of run.body.nodes)
				if (node.active)
					yield* launcher.startNode({
						organizationId: run.organizationId,
						run: run.id,
						node: node.spec.id,
						attempt: node.attempt,
					})
			for (const wait of yield* runs.waitsOf(run.organizationId, run.id))
				yield* wake(wait)
			// A change may have been saved just before the server stopped, before it woke the scheduler.
			yield* launcher.wake(run, run.body.round)
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("An open Workflow Run could not go on", cause),
			),
		)

	return Tasks.of({
		prepare,
		tick,
		finish,
		abort,
		plan,
		start,
		collectCall,
		checkReplay,
		replayed,
		collectTask,
		collectTaskCheck,
		collectCheck,
		collectWait,
		collectPlan,
		collectAccept,
		collectBudget,
		slept,
		startChild,
		crash,
		wake,
		cancel,
		recover,
	})
})

export const layer = Layer.effect(Tasks, make)
