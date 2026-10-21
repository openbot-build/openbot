import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import { Config, Session } from "@openbot-build/core"
import { AgentsApi, WorkflowsApi } from "@openbot-build/api"
import { and, desc, eq, inArray } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { workflowRuns } from "../database/Schema.ts"
import { unavailable } from "./Workflows.ts"

/** Tool calls that one `Act` step made. A later check confirms them before they are recorded. */
export const Calls = Schema.Array(
	Schema.Struct({ tool: Schema.String, arguments: Schema.JsonObject }),
)
export type Calls = typeof Calls.Type

/** What a Run keeps while it goes on. The `body` column holds it as JSON. */
export const Body = Schema.Struct({
	name: Schema.String,
	revision: Schema.Natural,
	cache: WorkflowsApi.CacheMode,
	agent: AgentsApi.AgentId,
	judge: Schema.optionalKey(Config.Selection),
	steps: Schema.Array(WorkflowsApi.Step),
	input: Schema.JsonObject,
	variables: Schema.JsonObject,
	results: Schema.Array(WorkflowsApi.StepResult),
	findings: Schema.Array(WorkflowsApi.Finding),
	sessions: Schema.Array(
		Schema.Struct({ agent: AgentsApi.AgentId, session: Session.Id }),
	),
	/** Tool calls of passed `Act` steps that no check has confirmed yet. */
	pending: Schema.Array(
		Schema.Struct({
			step: WorkflowsApi.StepId,
			key: Schema.String,
			calls: Calls,
		}),
	),
	/** The Turn that each task of the Run started. A task that runs again finds its Turn here. */
	turns: Schema.Record(Schema.String, WorkflowsApi.TurnRef),
	error: Schema.NullOr(Schema.String),
	startedAt: Schema.NullOr(Schema.Finite),
})
export type Body = typeof Body.Type
const bodyCodec = Schema.fromJsonString(Schema.toCodecJson(Body))

/**
 * The Session of the Agent that started a Run, and a key for its tool call.
 * The result goes back to that Session as a new message.
 */
export interface Parent {
	readonly session: Session.Id
	readonly toolCallId: string
}

/** The Turn that the durable execution of a Run waits for, and the token that wakes it. */
export interface Waiting {
	readonly session: Session.Id
	readonly turn: string
	readonly token: string
}

export interface Stored {
	readonly organizationId: string
	readonly id: WorkflowsApi.RunId
	readonly workflowId: WorkflowsApi.WorkflowId | null
	readonly userId: string
	readonly trigger: WorkflowsApi.RunTrigger
	readonly status: WorkflowsApi.RunStatus
	readonly body: Body
	readonly parent: Parent | null
	readonly waiting: Waiting | null
	readonly createdAt: number
	readonly finishedAt: number | null
}

export const terminal = (status: WorkflowsApi.RunStatus) =>
	status === "passed" || status === "failed" || status === "cancelled"

/** The counts of a Run, from its step results. */
export const summarize = (
	results: ReadonlyArray<WorkflowsApi.StepResult>,
): WorkflowsApi.RunSummary => {
	const count = (test: (result: WorkflowsApi.StepResult) => boolean) =>
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
export const view = (stored: Stored): WorkflowsApi.Run => ({
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
	variables: stored.body.variables,
	steps: stored.body.results,
	findings: stored.body.findings,
	summary: summarize(stored.body.results),
	sessions: stored.body.sessions,
	error: stored.body.error,
	createdAt: stored.createdAt,
	startedAt: stored.body.startedAt,
	finishedAt: stored.finishedAt,
})

/** A pending result for each step. */
export const initialResults = (
	steps: ReadonlyArray<WorkflowsApi.Step>,
): ReadonlyArray<WorkflowsApi.StepResult> =>
	steps.map((step) => ({
		id: step.id,
		kind: step._tag,
		status: "pending",
		mode: null,
		attempts: 0,
		turns: [],
		output: null,
		message: null,
		startedAt: null,
		finishedAt: null,
	}))

export interface CreateInput {
	readonly organizationId: string
	readonly workflowId: WorkflowsApi.WorkflowId | null
	readonly userId: string
	readonly trigger: WorkflowsApi.RunTrigger
	readonly name: string
	readonly revision: number
	readonly cache: WorkflowsApi.CacheMode
	readonly agent: AgentsApi.AgentId
	readonly judge?: Config.Selection
	readonly steps: ReadonlyArray<WorkflowsApi.Step>
	readonly input: Schema.JsonObject
	readonly parent?: Parent
}

/** The stored Runs of Workflows and explorations. */
export class Runs extends Context.Service<
	Runs,
	{
		/** Makes a queued Run. A second call for the same parent tool call returns the first Run. */
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
		/**
		 * Changes a Run with its row locked. `update` returns the new Run, or None for no change.
		 * It returns the Run after the step.
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
		/** The Runs that wait for a Turn of this Session. */
		readonly waitingOn: (
			session: Session.Id,
		) => Effect.Effect<
			ReadonlyArray<Stored>,
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
				workflowId:
					row.workflowId === null
						? null
						: WorkflowsApi.WorkflowId.make(row.workflowId),
				userId: row.userId,
				trigger: row.trigger as WorkflowsApi.RunTrigger,
				status: row.status as WorkflowsApi.RunStatus,
				body,
				parent:
					row.parentSession === null || row.parentToolCall === null
						? null
						: {
								session: Session.Id.make(row.parentSession),
								toolCallId: row.parentToolCall,
							},
				waiting:
					row.waitingSession === null ||
					row.waitingTurn === null ||
					row.waitingToken === null
						? null
						: {
								session: Session.Id.make(row.waitingSession),
								turn: row.waitingTurn,
								token: row.waitingToken,
							},
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
				waitingSession: run.waiting?.session ?? null,
				waitingTurn: run.waiting?.turn ?? null,
				waitingToken: run.waiting?.token ?? null,
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
					and(
						eq(workflowRuns.organizationId, organizationId),
						eq(workflowRuns.parentSession, parent.session),
						eq(workflowRuns.parentToolCall, parent.toolCallId),
					),
				),
		).pipe(Effect.flatMap((rows) => Effect.forEach(rows, fromRow)))
	return Runs.of({
		create: (input) =>
			Effect.gen(function* () {
				if (input.parent !== undefined) {
					const existing = yield* byParent(input.organizationId, input.parent)
					if (existing[0] !== undefined) return existing[0]
				}
				const now = yield* Clock.currentTimeMillis
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
						steps: input.steps,
						input: input.input,
						variables: {},
						results: initialResults(input.steps),
						findings: [],
						sessions: [],
						pending: [],
						turns: {},
						error: null,
						startedAt: null,
					},
					parent: input.parent ?? null,
					waiting: null,
					createdAt: now,
					finishedAt: null,
				}
				const values = yield* columns(run)
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
							parentSession: run.parent?.session ?? null,
							parentToolCall: run.parent?.toolCallId ?? null,
							createdAt: run.createdAt,
						})
						.onConflictDoNothing()
						.returning({ id: workflowRuns.id }),
				)
				if (inserted.length > 0 || input.parent === undefined) return run
				// Another call for the same tool call made the Run first.
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
			).pipe(Effect.flatMap((rows) => Effect.forEach(rows, fromRow))),
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
		waitingOn: (session) =>
			stored(
				db
					.select()
					.from(workflowRuns)
					.where(eq(workflowRuns.waitingSession, session)),
			).pipe(Effect.flatMap((rows) => Effect.forEach(rows, fromRow))),
		open: stored(
			db
				.select()
				.from(workflowRuns)
				.where(inArray(workflowRuns.status, ["queued", "running"])),
		).pipe(Effect.flatMap((rows) => Effect.forEach(rows, fromRow))),
	})
})
export const layer = Layer.effect(Runs, make)
