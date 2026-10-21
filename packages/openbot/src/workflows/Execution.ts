import { type AgentsApi, WorkflowsApi } from "@openbot-build/api"
import { Context, Effect, Layer, Schema } from "effect"
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow"
import { Agents } from "../agents/Agents.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { type Parent, Runs, type Stored } from "./Runs.ts"

/**
 * The durable execution of one Run. Its id is the Run id, so a second start of the
 * same Run joins the first one. The steps live in Engine.ts.
 */
export const RunWorkflow = Workflow.make("openbot.workflow.run", {
	payload: { organizationId: Schema.String, run: Schema.String },
	idempotencyKey: ({ organizationId, run }) => organizationId + "/" + run,
})

/** The status of a Turn that ended. A Run waits for it. */
export const TurnEnded = Schema.Literals(["Completed", "Failed", "Interrupted"])
export type TurnEnded = typeof TurnEnded.Type

/** The deferred that wakes a Run when the Turn of one task ends. */
export const turnEnded = (task: string) =>
	DurableDeferred.make(task, { success: TurnEnded })

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
	readonly source:
		| { readonly _tag: "Workflow"; readonly workflow: WorkflowsApi.Workflow }
		| {
				readonly _tag: "Explore"
				readonly goal: string
				readonly agent?: AgentsApi.AgentId
		  }
}

/** Starts and stops the durable execution of Runs. */
export class Launcher extends Context.Service<
	Launcher,
	{
		/** Makes a queued Run and starts it in the background. */
		readonly start: (
			input: StartInput,
		) => Effect.Effect<Stored, WorkflowsApi.WorkflowStorageUnavailable>
		/** Starts a Run again after a restart. It does nothing when the Run already goes on. */
		readonly resume: (run: Stored) => Effect.Effect<void>
		/** Stops the durable execution of a Run. */
		readonly interrupt: (run: Stored) => Effect.Effect<void>
	}
>()("@openbot-build/openbot/workflows/Execution/Launcher") {}

export const make = Effect.gen(function* () {
	const engine = yield* WorkflowEngine.WorkflowEngine
	const runs = yield* Runs
	const agents = yield* Agents
	const audit = yield* AuditLog
	const execute = (run: Stored) =>
		RunWorkflow.execute(payloadOf(run), { discard: true }).pipe(
			Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
			Effect.asVoid,
		)
	return Launcher.of({
		start: (input) =>
			Effect.gen(function* () {
				const member = {
					organizationId: input.organizationId,
					userId: input.userId,
				}
				const source = input.source
				const chosen =
					source._tag === "Workflow" ? source.workflow.agent : source.agent
				// Without its own Agent, a Run uses the Main Agent of its member.
				const agent =
					chosen === null || chosen === undefined
						? (yield* agents
								.ensureMain(member)
								.pipe(
									Effect.mapError(() =>
										WorkflowsApi.WorkflowStorageUnavailable.make({}),
									),
								)).id
						: chosen
				const run = yield* runs.create({
					organizationId: input.organizationId,
					userId: input.userId,
					trigger: input.trigger,
					cache: input.cache,
					agent,
					input: input.input ?? {},
					...(input.parent === undefined ? {} : { parent: input.parent }),
					...(source._tag === "Workflow"
						? {
								workflowId: source.workflow.id,
								name: source.workflow.name,
								revision: source.workflow.revision,
								steps: source.workflow.steps,
								...(source.workflow.judge === undefined
									? {}
									: { judge: source.workflow.judge }),
							}
						: {
								workflowId: null,
								name: "Explore: " + source.goal.slice(0, 80),
								revision: 0,
								steps: [
									{
										_tag: "Explore",
										id: WorkflowsApi.StepId.make("explore"),
										goal: source.goal,
									},
								],
							}),
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
				yield* execute(run)
				return run
			}),
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
	})
})
export const layer = Layer.effect(Launcher, make)
