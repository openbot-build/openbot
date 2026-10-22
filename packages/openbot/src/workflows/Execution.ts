import { WorkflowsApi } from "@openbot-build/api"
import { Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow"
import { Agents } from "../agents/Agents.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import {
	type NodeState,
	type Parent,
	revise as reviseNodes,
	Runs,
	type Stored,
	terminal,
} from "./Runs.ts"
import { type Definition, Workflows } from "./Workflows.ts"

/**
 * The durable execution of one Run: the scheduler that starts its nodes. Its id is the Run id,
 * so a second start of the same Run joins the first one. The body lives in Engine.ts.
 */
export const RunWorkflow = Workflow.make("openbot.workflow.run", {
	payload: { organizationId: Schema.String, run: Schema.String },
	idempotencyKey: ({ organizationId, run }) => organizationId + "/" + run,
})

/** Where a node is: its Run, its id, and the start of its work. */
export const NodePayload = Schema.Struct({
	organizationId: Schema.String,
	run: Schema.String,
	node: Schema.String,
	attempt: Schema.Int,
})
export type NodePayload = typeof NodePayload.Type

/**
 * The durable execution of one start of one node. A node that starts again, or that goes on
 * to its next phase, gets a new attempt, so it never finds the result of an earlier start.
 */
export const NodeWorkflow = Workflow.make("openbot.workflow.node", {
	payload: NodePayload.fields,
	idempotencyKey: ({ organizationId, run, node, attempt }) =>
		organizationId + "/" + run + "/" + node + "/" + attempt,
})

/** The status of a Turn that ended. A node waits for it. */
export const TurnEnded = Schema.Literals(["Completed", "Failed", "Interrupted"])
export type TurnEnded = typeof TurnEnded.Type

/** The deferred that wakes a node when the Turn of one task ends. */
export const turnEnded = (task: string) =>
	DurableDeferred.make(task, { success: TurnEnded })

/**
 * The deferred that wakes the scheduler of a Run in one round. A node that ends, a child Run
 * that ends, or a new revision completes it. The name comes from the round, so nobody stores a token.
 */
export const changed = (round: number) =>
	DurableDeferred.make("changed/" + round)

export const payloadOf = (run: Pick<Stored, "organizationId" | "id">) => ({
	organizationId: run.organizationId,
	run: run.id,
})

export interface StartInput {
	readonly organizationId: string
	/** The member that the Run works for. */
	readonly userId: string
	readonly trigger: WorkflowsApi.RunTrigger
	readonly input: WorkflowsApi.StartRunRequest["input"]
	readonly cache: WorkflowsApi.CacheMode
	readonly parent?: Parent
	readonly workflow: WorkflowsApi.Workflow
	/** Another revision than the current one, with its definition. */
	readonly revision?: {
		readonly revision: number
		readonly definition: Definition
	}
	/** The nodes of an earlier Run of the same Workflow. Nodes that passed and did not change keep their results. */
	readonly carry?: ReadonlyArray<NodeState>
}

/** Starts and stops the durable executions of Runs and nodes. */
export class Launcher extends Context.Service<
	Launcher,
	{
		/** Makes a queued Run and starts it in the background. */
		readonly start: (
			input: StartInput,
		) => Effect.Effect<Stored, WorkflowsApi.WorkflowStorageUnavailable>
		/** Makes a queued Run, but does not start it. `resume` starts it. */
		readonly create: (
			input: StartInput,
		) => Effect.Effect<Stored, WorkflowsApi.WorkflowStorageUnavailable>
		/** Starts a Run again after a restart. It does nothing when the Run already goes on. */
		readonly resume: (run: Stored) => Effect.Effect<void>
		/** Stops the durable execution of a Run. */
		readonly interrupt: (run: Stored) => Effect.Effect<void>
		/** Starts one node in the background. A second start with the same attempt does nothing. */
		readonly startNode: (payload: NodePayload) => Effect.Effect<void>
		/** Stops the durable execution of one start of a node. */
		readonly interruptNode: (payload: NodePayload) => Effect.Effect<void>
		/** Wakes the scheduler of a Run in this round. A second call does nothing. */
		readonly wake: (
			run: Pick<Stored, "organizationId" | "id">,
			round: number,
		) => Effect.Effect<void>
		/**
		 * Moves a Run that goes on to another revision of its Workflow. Without `revision`, the newest.
		 * Nodes that did not change keep their state. The scheduler stops changed nodes that ran.
		 */
		readonly revise: (
			organizationId: string,
			id: string,
			revision?: number,
		) => Effect.Effect<
			Stored,
			| WorkflowsApi.WorkflowStorageUnavailable
			| WorkflowsApi.WorkflowNotFound
			| WorkflowsApi.WorkflowInvalid
		>
	}
>()("@openbot-build/openbot/workflows/Execution/Launcher") {}

export const make = Effect.gen(function* () {
	const engine = yield* WorkflowEngine.WorkflowEngine
	const runs = yield* Runs
	const workflows = yield* Workflows
	const agents = yield* Agents
	const audit = yield* AuditLog
	const withEngine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine))
	// Detached: a Run or node may start from inside another durable execution, but it is not its child.
	// Cancel stops each execution by itself.
	const execute = (run: Stored) =>
		RunWorkflow.execute(payloadOf(run), { discard: true, detached: true }).pipe(
			withEngine,
			Effect.asVoid,
		)
	const create = (input: StartInput) =>
		Effect.gen(function* () {
			const member = {
				organizationId: input.organizationId,
				userId: input.userId,
			}
			const workflow = input.workflow
			// Without its own Agent, a Run uses the Main Agent of its member.
			const agent =
				workflow.agent === null
					? (yield* agents
							.ensureMain(member)
							.pipe(
								Effect.mapError(() =>
									WorkflowsApi.WorkflowStorageUnavailable.make({}),
								),
							)).id
					: workflow.agent
			const definition = input.revision?.definition ?? {
				graph: workflow.graph,
				...(workflow.judge === undefined ? {} : { judge: workflow.judge }),
			}
			const run = yield* runs.create({
				organizationId: input.organizationId,
				userId: input.userId,
				trigger: input.trigger,
				cache: input.cache,
				agent,
				input: input.input ?? {},
				workflowId: workflow.id,
				name: workflow.name,
				revision: input.revision?.revision ?? workflow.revision,
				graph: definition.graph,
				...(definition.judge === undefined ? {} : { judge: definition.judge }),
				...(input.parent === undefined ? {} : { parent: input.parent }),
				...(input.carry === undefined ? {} : { carry: input.carry }),
			})
			yield* audit
				.record({
					organizationId: input.organizationId,
					action: "workflow.run_started",
					actor: { kind: "member", ...member },
					resource: run.id,
					details: {
						workflow: run.workflowId,
						trigger: run.trigger,
						cache: run.body.cache,
					},
				})
				.pipe(Effect.ignore)
			return run
		})
	const wake = (run: Pick<Stored, "organizationId" | "id">, round: number) =>
		DurableDeferred.tokenFromPayload(changed(round), {
			workflow: RunWorkflow,
			payload: payloadOf(run),
		}).pipe(
			Effect.flatMap((token) =>
				DurableDeferred.done(changed(round), { token, exit: Exit.void }),
			),
			withEngine,
			Effect.catchCause((cause) =>
				Effect.logWarning("A Workflow Run could not be woken", cause),
			),
		)
	return Launcher.of({
		start: (input) => create(input).pipe(Effect.tap((run) => execute(run))),
		create,
		resume: (run) =>
			execute(run).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("A Workflow Run could not start again", cause),
				),
			),
		interrupt: (run) =>
			RunWorkflow.executionId(payloadOf(run)).pipe(
				Effect.flatMap((id) => engine.interrupt(RunWorkflow, id)),
			),
		startNode: (payload) =>
			NodeWorkflow.execute(payload, { discard: true, detached: true }).pipe(
				withEngine,
				Effect.asVoid,
				Effect.catchCause((cause) =>
					Effect.logWarning("A node of a Workflow Run could not start", cause),
				),
			),
		interruptNode: (payload) =>
			NodeWorkflow.executionId(payload).pipe(
				Effect.flatMap((id) => engine.interrupt(NodeWorkflow, id)),
				Effect.catchCause((cause) =>
					Effect.logWarning("A node of a Workflow Run could not stop", cause),
				),
			),
		wake,
		revise: (organizationId, id, revision) =>
			Effect.gen(function* () {
				const current = yield* runs.find(organizationId, id)
				if (Option.isNone(current))
					return yield* WorkflowsApi.WorkflowNotFound.make({ id })
				const workflow = yield* workflows.find(
					organizationId,
					current.value.workflowId,
				)
				if (Option.isNone(workflow))
					return yield* WorkflowsApi.WorkflowNotFound.make({
						id: current.value.workflowId,
					})
				const target = revision ?? workflow.value.revision
				const definition = yield* workflows.revision(
					organizationId,
					workflow.value.id,
					target,
				)
				if (Option.isNone(definition))
					return yield* WorkflowsApi.WorkflowInvalid.make({
						message: `The Workflow has no revision ${target}.`,
					})
				const changed = yield* runs.change(organizationId, id, (run) => {
					if (terminal(run.status))
						return Effect.fail(
							WorkflowsApi.WorkflowInvalid.make({
								message:
									"The Run has ended, so it cannot move to another revision.",
							}),
						)
					const next = reviseNodes(run.body.nodes, definition.value.graph)
					const ids = new Set<string>(next.stopped.map((node) => node.spec.id))
					return Effect.succeedSome<Stored>({
						...run,
						body: {
							...run.body,
							revision: target,
							nodes: next.nodes,
							stale: [
								...run.body.stale,
								...next.stopped.map((node) => ({
									node: node.spec.id,
									attempt: node.attempt,
									active: node.active,
									child: node.child,
									sessions: run.body.sessions.flatMap((entry) =>
										entry.node === node.spec.id ? [entry.session] : [],
									),
								})),
							],
							sessions: run.body.sessions.map((entry) =>
								entry.node !== null && ids.has(entry.node)
									? { ...entry, node: null }
									: entry,
							),
						},
					})
				})
				if (Option.isNone(changed))
					return yield* WorkflowsApi.WorkflowNotFound.make({ id })
				yield* wake(changed.value, changed.value.body.round)
				return changed.value
			}),
	})
})
export const layer = Layer.effect(Launcher, make)
