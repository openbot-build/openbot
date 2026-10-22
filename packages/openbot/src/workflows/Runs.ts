import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import { Config, Session } from "@openbot-build/core"
import { AgentsApi, WorkflowsApi } from "@openbot-build/api"
import { and, desc, eq, inArray } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { workflowRuns, workflowWaits } from "../database/Schema.ts"
import { unavailable } from "./Workflows.ts"

/** Tool calls that one `Task` node made. A later check confirms them before they are recorded. */
export const Calls = Schema.Array(
	Schema.Struct({ tool: Schema.String, arguments: Schema.JsonObject }),
)
export type Calls = typeof Calls.Type

/**
 * Where a node is in its work.
 * `idle`: it waits for its `needs`, or for its next start. `planning`: an Agent writes a plan.
 * `running`: its child Run goes on. `checking`: an Agent checks the result of a Goal.
 * `done`: it has ended.
 */
export const Phase = Schema.Literals([
	"idle",
	"planning",
	"running",
	"checking",
	"done",
])
export type Phase = typeof Phase.Type

/** One node of a Run, with its result and the state of its work. */
export const NodeState = Schema.Struct({
	spec: WorkflowsApi.Node,
	/** How many times a node execution started. Each start has its own durable execution. */
	attempt: Schema.Natural,
	/** True while the execution of the current attempt goes on. */
	active: Schema.Boolean,
	phase: Phase,
	/**
	 * Why the node was skipped. `when`: its condition was false, so the nodes after it still run.
	 * `blocked`: a node before it failed, or the Run stopped.
	 */
	skip: Schema.NullOr(Schema.Literals(["when", "blocked"])),
	/** The planned Workflow of a Plan or Goal node, at the revision of the current round. */
	plan: Schema.NullOr(
		Schema.Struct({
			workflow: WorkflowsApi.WorkflowId,
			revision: Schema.Natural,
		}),
	),
	/** The child Run of the current round. */
	child: Schema.NullOr(WorkflowsApi.RunId),
	/** What the Agent must know when it plans again: why the last round did not reach the goal. */
	feedback: Schema.NullOr(Schema.String),
	/** The tokens that a Goal node may use. Each approval to go on adds its budget again. */
	allowed: Schema.NullOr(Schema.Natural),
	result: WorkflowsApi.NodeResult,
})
export type NodeState = typeof NodeState.Type

/** What a Run keeps while it goes on. The `body` column holds it as JSON. */
export const Body = Schema.Struct({
	name: Schema.String,
	revision: Schema.Natural,
	cache: WorkflowsApi.CacheMode,
	agent: AgentsApi.AgentId,
	judge: Schema.optionalKey(Config.Selection),
	input: Schema.JsonObject,
	/** The round of the scheduler of the Run. A change wakes it with the deferred of this round. */
	round: Schema.Natural,
	/** The nodes that the scheduler started in this round. A retry of the round starts the same nodes. */
	started: Schema.Array(
		Schema.Struct({ node: WorkflowsApi.NodeId, attempt: Schema.Natural }),
	),
	nodes: Schema.Array(NodeState),
	findings: Schema.Array(WorkflowsApi.Finding),
	/** The Sessions of the Run. `node` is the node that works in the Session now. */
	sessions: Schema.Array(
		Schema.Struct({
			agent: AgentsApi.AgentId,
			session: Session.Id,
			node: Schema.NullOr(WorkflowsApi.NodeId),
		}),
	),
	/** Tool calls of passed `Task` nodes that no check has confirmed yet. */
	pending: Schema.Record(
		Schema.String,
		Schema.Struct({ key: Schema.String, calls: Calls }),
	),
	/** The Turn that each task of the Run started. A task that runs again finds its Turn here. */
	turns: Schema.Record(Schema.String, WorkflowsApi.TurnRef),
	/**
	 * Starts of nodes that a new revision changed while they ran. The scheduler stops them:
	 * their executions, their Turns in these Sessions, and their child Runs.
	 */
	stale: Schema.Array(
		Schema.Struct({
			node: WorkflowsApi.NodeId,
			attempt: Schema.Natural,
			active: Schema.Boolean,
			child: Schema.NullOr(WorkflowsApi.RunId),
			sessions: Schema.Array(Session.Id),
		}),
	),
	/** Set when a node with `onFail: replan` failed. The parent Plan or Goal node reads it. */
	replan: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String),
	startedAt: Schema.NullOr(Schema.Finite),
})
export type Body = typeof Body.Type
const bodyCodec = Schema.fromJsonString(Schema.toCodecJson(Body))

/**
 * Who started a Run. The end of the Run goes back there.
 * `Session`: a tool call of an Agent, which gets the end as a new message.
 * `Run`: a node of another Run. `key` names the node, its attempt and its round.
 */
export type Parent =
	| {
			readonly _tag: "Session"
			readonly session: Session.Id
			readonly toolCallId: string
	  }
	| {
			readonly _tag: "Run"
			readonly run: WorkflowsApi.RunId
			readonly node: WorkflowsApi.NodeId
			readonly key: string
	  }

/** A Turn that the durable execution of a Run waits for, and the token that wakes it. */
export interface Wait {
	readonly organizationId: string
	readonly run: WorkflowsApi.RunId
	readonly task: string
	readonly session: Session.Id
	readonly turn: string
	readonly token: string
}

export interface Stored {
	readonly organizationId: string
	readonly id: WorkflowsApi.RunId
	readonly workflowId: WorkflowsApi.WorkflowId
	readonly userId: string
	readonly trigger: WorkflowsApi.RunTrigger
	readonly status: WorkflowsApi.RunStatus
	readonly body: Body
	readonly parent: Parent | null
	readonly createdAt: number
	readonly finishedAt: number | null
}

export const terminal = (status: WorkflowsApi.RunStatus) =>
	status === "passed" || status === "failed" || status === "cancelled"

/** The counts of a Run, from its node results. */
export const summarize = (
	results: ReadonlyArray<WorkflowsApi.NodeResult>,
): WorkflowsApi.RunSummary => {
	const count = (test: (result: WorkflowsApi.NodeResult) => boolean) =>
		results.filter(test).length
	return {
		passed: count((result) => result.status === "passed"),
		failed: count((result) => result.status === "failed"),
		skipped: count((result) => result.status === "skipped"),
		deterministic: count((result) => result.mode === "deterministic"),
		live: count((result) => result.mode === "live"),
		replayed: count((result) => result.mode === "replayed"),
		handedOff: count((result) => result.mode === "handed_off"),
	}
}

/** The API value of a Run. */
export const view = (stored: Stored): WorkflowsApi.Run => {
	const results = stored.body.nodes.map((node) => node.result)
	return {
		id: stored.id,
		workflow: stored.workflowId,
		revision: stored.body.revision,
		name: stored.body.name,
		trigger: stored.trigger,
		status: stored.status,
		cache: stored.body.cache,
		userId: stored.userId,
		agent: stored.body.agent,
		input: stored.body.input,
		nodes: results,
		findings: stored.body.findings,
		summary: summarize(results),
		usage: {
			tokens: results.reduce((all, result) => all + result.tokens, 0),
		},
		parent:
			stored.parent?._tag === "Run"
				? { run: stored.parent.run, node: stored.parent.node }
				: null,
		sessions: stored.body.sessions.map(({ agent, session }) => ({
			agent,
			session,
		})),
		error: stored.body.error,
		createdAt: stored.createdAt,
		startedAt: stored.body.startedAt,
		finishedAt: stored.finishedAt,
	}
}

/** A pending result for a node. */
export const initialResult = (
	node: WorkflowsApi.Node,
): WorkflowsApi.NodeResult => ({
	id: node.id,
	kind: node._tag,
	needs: node.needs ?? [],
	status: "pending",
	mode: null,
	attempts: 0,
	round: 0,
	turns: [],
	output: null,
	message: null,
	tokens: 0,
	children: [],
	startedAt: null,
	finishedAt: null,
})

/** A node that has not started. */
export const initialNode = (node: WorkflowsApi.Node): NodeState => ({
	spec: node,
	attempt: 0,
	active: false,
	phase: "idle",
	skip: null,
	plan: null,
	child: null,
	feedback: null,
	allowed:
		node._tag === "Goal" && node.budget !== undefined
			? node.budget.tokens
			: null,
	result: initialResult(node),
})

/** Two nodes are the same when their definitions are the same. */
const sameSpec = (left: WorkflowsApi.Node, right: WorkflowsApi.Node) =>
	JSON.stringify(left) === JSON.stringify(right)

/**
 * The nodes of a Run after it moves to another revision.
 * A node that did not change keeps its state, even while it runs.
 * A node that changed starts again later. Its attempt goes up, so its old execution is ignored.
 * It returns the new nodes and the ids of the changed nodes that were running.
 */
// It is a plain function of two values. A pipeable form does not help here.
// @effect-diagnostics-next-line missingPipeableSignature:off
export const revise = (
	current: ReadonlyArray<NodeState>,
	graph: WorkflowsApi.Graph,
): {
	readonly nodes: ReadonlyArray<NodeState>
	readonly stopped: ReadonlyArray<NodeState>
} => {
	const byId = new Map(current.map((node) => [node.spec.id, node]))
	const stopped: Array<NodeState> = []
	const nodes = graph.nodes.map((spec) => {
		const old = byId.get(spec.id)
		if (old === undefined) return initialNode(spec)
		if (sameSpec(old.spec, spec)) return old
		if (old.result.status === "running") stopped.push(old)
		return { ...initialNode(spec), attempt: old.attempt }
	})
	return { nodes, stopped }
}

export interface CreateInput {
	readonly organizationId: string
	readonly workflowId: WorkflowsApi.WorkflowId
	readonly userId: string
	readonly trigger: WorkflowsApi.RunTrigger
	readonly name: string
	readonly revision: number
	readonly cache: WorkflowsApi.CacheMode
	readonly agent: AgentsApi.AgentId
	readonly judge?: Config.Selection
	readonly graph: WorkflowsApi.Graph
	readonly input: Schema.JsonObject
	readonly parent?: Parent
	/** Nodes of an earlier Run of the same plan. Nodes that passed and did not change keep their results. */
	readonly carry?: ReadonlyArray<NodeState>
}

/** The stored Runs of Workflows, and the Turns that they wait for. */
export class Runs extends Context.Service<
	Runs,
	{
		/** Makes a queued Run. A second call for the same parent returns the first Run. */
		readonly create: (
			input: CreateInput,
		) => Effect.Effect<Stored, WorkflowsApi.WorkflowStorageUnavailable>
		readonly find: (
			organizationId: string,
			id: string,
		) => Effect.Effect<
			Option.Option<Stored>,
			WorkflowsApi.WorkflowStorageUnavailable
		>
		/** The newest Runs first, at most 100. */
		readonly list: (
			organizationId: string,
			filter: {
				readonly userId?: string
				readonly workflowId?: string
				readonly status?: WorkflowsApi.RunStatus
			},
		) => Effect.Effect<
			ReadonlyArray<Stored>,
			WorkflowsApi.WorkflowStorageUnavailable
		>
		/** The child Runs that the nodes of a Run started. */
		readonly children: (
			organizationId: string,
			id: string,
		) => Effect.Effect<
			ReadonlyArray<Stored>,
			WorkflowsApi.WorkflowStorageUnavailable
		>
		/**
		 * Changes a Run with its row locked. `update` returns the new Run, or None for no change.
		 * It returns the Run after the change.
		 */
		readonly change: <E, R>(
			organizationId: string,
			id: string,
			update: (stored: Stored) => Effect.Effect<Option.Option<Stored>, E, R>,
		) => Effect.Effect<
			Option.Option<Stored>,
			E | WorkflowsApi.WorkflowStorageUnavailable,
			R
		>
		/** Saves the Turn that a task waits for. A second save of the same task replaces the first. */
		readonly wait: (
			wait: Wait,
		) => Effect.Effect<void, WorkflowsApi.WorkflowStorageUnavailable>
		/** Removes a wait. It returns true when this call removed it. */
		readonly unwait: (
			wait: Pick<Wait, "organizationId" | "run" | "task" | "token">,
		) => Effect.Effect<boolean, WorkflowsApi.WorkflowStorageUnavailable>
		/** The waits for the Turns of this Session. */
		readonly waitsOn: (
			session: Session.Id,
		) => Effect.Effect<
			ReadonlyArray<Wait>,
			WorkflowsApi.WorkflowStorageUnavailable
		>
		/** The waits of one Run. */
		readonly waitsOf: (
			organizationId: string,
			run: string,
		) => Effect.Effect<
			ReadonlyArray<Wait>,
			WorkflowsApi.WorkflowStorageUnavailable
		>
		/** The Runs that have not ended, in every organization. Recovery uses it after a restart. */
		readonly open: Effect.Effect<
			ReadonlyArray<Stored>,
			WorkflowsApi.WorkflowStorageUnavailable
		>
	}
>()("@openbot-build/openbot/workflows/Runs") {}

type Row = typeof workflowRuns.$inferSelect
type WaitRow = typeof workflowWaits.$inferSelect

const parentOf = (row: Row): Parent | null =>
	row.parentSession !== null && row.parentToolCall !== null
		? {
				_tag: "Session",
				session: Session.Id.make(row.parentSession),
				toolCallId: row.parentToolCall,
			}
		: row.parentRun !== null &&
			  row.parentNode !== null &&
			  row.parentKey !== null
			? {
					_tag: "Run",
					run: WorkflowsApi.RunId.make(row.parentRun),
					node: row.parentNode as WorkflowsApi.NodeId,
					key: row.parentKey,
				}
			: null

const waitOf = (row: WaitRow): Wait => ({
	organizationId: row.organizationId,
	run: WorkflowsApi.RunId.make(row.runId),
	task: row.task,
	session: Session.Id.make(row.session),
	turn: row.turn,
	token: row.token,
})

export const make: Effect.Effect<
	typeof Runs.Service,
	never,
	PgClient.PgClient
> = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
	const sql = yield* PgClient.PgClient
	const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.mapError(unavailable))
	const fromRow = (row: Row) =>
		Schema.decodeEffect(bodyCodec)(row.body).pipe(
			Effect.mapError(unavailable),
			Effect.map((body): Stored => ({
				organizationId: row.organizationId,
				id: WorkflowsApi.RunId.make(row.id),
				workflowId: WorkflowsApi.WorkflowId.make(row.workflowId),
				userId: row.userId,
				trigger: row.trigger as WorkflowsApi.RunTrigger,
				status: row.status as WorkflowsApi.RunStatus,
				body,
				parent: parentOf(row),
				createdAt: row.createdAt,
				finishedAt: row.finishedAt,
			})),
		)
	const columns = (run: Stored) =>
		Schema.encodeEffect(bodyCodec)(run.body).pipe(
			Effect.mapError(unavailable),
			Effect.map((body) => ({
				status: run.status,
				body,
				finishedAt: run.finishedAt,
			})),
		)
	const where = (organizationId: string, id: string) =>
		and(
			eq(workflowRuns.organizationId, organizationId),
			eq(workflowRuns.id, id),
		)
	const find: typeof Runs.Service.find = (organizationId, id) =>
		stored(
			db.select().from(workflowRuns).where(where(organizationId, id)),
		).pipe(
			Effect.flatMap((rows) =>
				rows[0] === undefined
					? Effect.succeedNone
					: Effect.asSome(fromRow(rows[0])),
			),
		)
	const byParent = (organizationId: string, parent: Parent) =>
		stored(
			db
				.select()
				.from(workflowRuns)
				.where(
					parent._tag === "Session"
						? and(
								eq(workflowRuns.organizationId, organizationId),
								eq(workflowRuns.parentSession, parent.session),
								eq(workflowRuns.parentToolCall, parent.toolCallId),
							)
						: and(
								eq(workflowRuns.organizationId, organizationId),
								eq(workflowRuns.parentRun, parent.run),
								eq(workflowRuns.parentKey, parent.key),
							),
				),
		).pipe(Effect.flatMap((rows) => Effect.forEach(rows, fromRow)))
	const manyRows = (rows: ReadonlyArray<Row>) => Effect.forEach(rows, fromRow)
	return Runs.of({
		create: (input) =>
			Effect.gen(function* () {
				if (input.parent !== undefined) {
					const existing = yield* byParent(input.organizationId, input.parent)
					if (existing[0] !== undefined) return existing[0]
				}
				const now = yield* Clock.currentTimeMillis
				const carried = revise(
					(input.carry ?? []).filter((node) => node.result.status === "passed"),
					input.graph,
				).nodes
				const run: Stored = {
					organizationId: input.organizationId,
					id: WorkflowsApi.RunId.make(
						"run_" + randomUUID().replaceAll("-", ""),
					),
					workflowId: input.workflowId,
					userId: input.userId,
					trigger: input.trigger,
					status: "queued",
					body: {
						name: input.name,
						revision: input.revision,
						cache: input.cache,
						agent: input.agent,
						...(input.judge === undefined ? {} : { judge: input.judge }),
						input: input.input,
						round: 0,
						started: [],
						nodes: carried,
						findings: [],
						sessions: [],
						pending: {},
						turns: {},
						stale: [],
						replan: null,
						error: null,
						startedAt: null,
					},
					parent: input.parent ?? null,
					createdAt: now,
					finishedAt: null,
				}
				const values = yield* columns(run)
				const parent = run.parent
				const inserted = yield* stored(
					db
						.insert(workflowRuns)
						.values({
							...values,
							organizationId: run.organizationId,
							id: run.id,
							workflowId: run.workflowId,
							userId: run.userId,
							trigger: run.trigger,
							parentSession: parent?._tag === "Session" ? parent.session : null,
							parentToolCall:
								parent?._tag === "Session" ? parent.toolCallId : null,
							parentRun: parent?._tag === "Run" ? parent.run : null,
							parentNode: parent?._tag === "Run" ? parent.node : null,
							parentKey: parent?._tag === "Run" ? parent.key : null,
							createdAt: run.createdAt,
						})
						.onConflictDoNothing()
						.returning({ id: workflowRuns.id }),
				)
				if (inserted.length > 0 || input.parent === undefined) return run
				// Another call for the same parent made the Run first.
				const first = yield* byParent(input.organizationId, input.parent)
				return first[0] ?? run
			}),
		find,
		list: (organizationId, filter) =>
			stored(
				db
					.select()
					.from(workflowRuns)
					.where(
						and(
							eq(workflowRuns.organizationId, organizationId),
							filter.userId === undefined
								? undefined
								: eq(workflowRuns.userId, filter.userId),
							filter.workflowId === undefined
								? undefined
								: eq(workflowRuns.workflowId, filter.workflowId),
							filter.status === undefined
								? undefined
								: eq(workflowRuns.status, filter.status),
						),
					)
					.orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
					.limit(100),
			).pipe(Effect.flatMap(manyRows)),
		children: (organizationId, id) =>
			stored(
				db
					.select()
					.from(workflowRuns)
					.where(
						and(
							eq(workflowRuns.organizationId, organizationId),
							eq(workflowRuns.parentRun, id),
						),
					),
			).pipe(Effect.flatMap(manyRows)),
		change: (organizationId, id, update) =>
			sql
				.withTransaction(
					Effect.gen(function* () {
						const rows = yield* stored(
							db
								.select()
								.from(workflowRuns)
								.where(where(organizationId, id))
								.for("update"),
						)
						if (rows[0] === undefined) return Option.none()
						const current = yield* fromRow(rows[0])
						const next = yield* update(current)
						if (Option.isNone(next)) return Option.some(current)
						const values = yield* columns(next.value)
						yield* stored(
							db
								.update(workflowRuns)
								.set(values)
								.where(where(organizationId, id)),
						)
						return next
					}),
				)
				.pipe(Effect.catchTag("SqlError", () => Effect.fail(unavailable()))),
		wait: (wait) =>
			stored(
				db
					.insert(workflowWaits)
					.values({
						organizationId: wait.organizationId,
						runId: wait.run,
						task: wait.task,
						session: wait.session,
						turn: wait.turn,
						token: wait.token,
					})
					.onConflictDoUpdate({
						target: [
							workflowWaits.organizationId,
							workflowWaits.runId,
							workflowWaits.task,
						],
						set: { session: wait.session, turn: wait.turn, token: wait.token },
					}),
			).pipe(Effect.asVoid),
		unwait: (wait) =>
			stored(
				db
					.delete(workflowWaits)
					.where(
						and(
							eq(workflowWaits.organizationId, wait.organizationId),
							eq(workflowWaits.runId, wait.run),
							eq(workflowWaits.task, wait.task),
							eq(workflowWaits.token, wait.token),
						),
					)
					.returning({ task: workflowWaits.task }),
			).pipe(Effect.map((rows) => rows.length > 0)),
		waitsOn: (session) =>
			stored(
				db
					.select()
					.from(workflowWaits)
					.where(eq(workflowWaits.session, session)),
			).pipe(Effect.map((rows) => rows.map(waitOf))),
		waitsOf: (organizationId, run) =>
			stored(
				db
					.select()
					.from(workflowWaits)
					.where(
						and(
							eq(workflowWaits.organizationId, organizationId),
							eq(workflowWaits.runId, run),
						),
					),
			).pipe(Effect.map((rows) => rows.map(waitOf))),
		open: stored(
			db
				.select()
				.from(workflowRuns)
				.where(inArray(workflowRuns.status, ["queued", "running"])),
		).pipe(Effect.flatMap(manyRows)),
	})
})
export const layer = Layer.effect(Runs, make)
