import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto"
import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import { PgClient } from "@effect/sql-pg"
import { Config } from "@openbot-build/core"
import {
	type AgentsApi,
	type Caller,
	Permissions,
	WorkflowsApi,
} from "@openbot-build/api"
import { and, eq, isNotNull, lte, or } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import {
	Clock,
	Context,
	Cron,
	Effect,
	JsonSchema,
	Layer,
	Option,
	Result,
	Schema,
	SchemaRepresentation,
} from "effect"
import { can } from "../authorization/Check.ts"
import { rootOf, workflowKey } from "../authorization/Policy.ts"
import { Agents } from "../agents/Agents.ts"
import { workflows } from "../database/Schema.ts"

type Workflow = WorkflowsApi.Workflow

export type Failure =
	| WorkflowsApi.WorkflowNotFound
	| WorkflowsApi.WorkflowConflict
	| WorkflowsApi.WorkflowInvalid
	| WorkflowsApi.WorkflowStorageUnavailable
	| Permissions.PermissionDenied
	| Permissions.AuthorizationUnavailable

/** A Workflow and the organization it belongs to. */
export interface Stored {
	readonly organizationId: string
	readonly workflow: Workflow
}

export const unavailable = () =>
	WorkflowsApi.WorkflowStorageUnavailable.make({})
const invalid = (message: string) =>
	WorkflowsApi.WorkflowInvalid.make({ message })
const notFound = (id: string) => WorkflowsApi.WorkflowNotFound.make({ id })

/** The steps and the judge model, as the `definition` column keeps them. */
const Definition = Schema.Struct({
	steps: WorkflowsApi.Steps,
	judge: Schema.optionalKey(Config.Selection),
})
const definitionCodec = Schema.fromJsonString(Schema.toCodecJson(Definition))

/**
 * A runtime schema for the JSON Schema of an `Extract` step.
 * Patterns are ignored, because a pattern from a client could take a very long time to check.
 */
export const extractSchema = (schema: Schema.JsonObject) =>
	Result.try({
		try: () =>
			SchemaRepresentation.fromJsonSchemaDocument(
				JsonSchema.fromSchemaDraft2020_12(schema as JsonSchema.JsonSchema),
				{ patterns: "ignore" },
			),
		catch: (error) =>
			"The schema of the Extract step cannot be used: " +
			(error instanceof Error ? error.message : String(error)),
	})

/** The next time after `now` that a schedule starts a Run. */
export const nextRun = ({
	schedule,
	now,
}: {
	readonly schedule: WorkflowsApi.Schedule
	readonly now: number
}) =>
	Cron.parse(schedule.cron, schedule.timeZone ?? "UTC").pipe(
		Result.map((cron) => Cron.next(cron, now).getTime()),
		Result.mapError(
			() =>
				`The schedule ${JSON.stringify(schedule.cron)} is not a valid cron text with this time zone.`,
		),
	)

const hashSecret = (secret: string) =>
	createHash("sha256").update(secret).digest("hex")

/** The Workflows of an organization: their definitions, schedules and webhooks. */
export class Workflows extends Context.Service<
	Workflows,
	{
		readonly find: (
			organizationId: string,
			id: string,
		) => Effect.Effect<
			Option.Option<Workflow>,
			WorkflowsApi.WorkflowStorageUnavailable
		>
		/** Reads a Workflow and checks that the caller has the permission on it. */
		readonly access: (
			caller: Caller,
			id: string,
			permission: Permissions.PermissionGroupId,
		) => Effect.Effect<Workflow, Failure, AuthorizationServices>
		readonly list: (
			caller: Caller,
			input: {
				readonly archived?: boolean
				readonly owner?: AgentsApi.AgentId
			},
		) => Effect.Effect<ReadonlyArray<Workflow>, Failure, AuthorizationServices>
		readonly create: (
			caller: Caller,
			input: WorkflowsApi.CreateWorkflowRequest,
		) => Effect.Effect<Workflow, Failure, AuthorizationServices>
		readonly update: (
			caller: Caller,
			id: string,
			input: WorkflowsApi.UpdateWorkflowRequest,
		) => Effect.Effect<Workflow, Failure, AuthorizationServices>
		/** Makes a new webhook secret. It returns the secret once. Only its hash is kept. */
		readonly setWebhook: (
			caller: Caller,
			id: string,
		) => Effect.Effect<
			{ readonly workflow: Workflow; readonly secret: string },
			Failure,
			AuthorizationServices
		>
		readonly removeWebhook: (
			caller: Caller,
			id: string,
		) => Effect.Effect<Workflow, Failure, AuthorizationServices>
		/** The Workflow of a webhook, when the secret is right. */
		readonly verifyHook: (
			id: string,
			secret: string,
		) => Effect.Effect<
			Option.Option<Stored>,
			WorkflowsApi.WorkflowStorageUnavailable
		>
		/**
		 * The scheduled Workflows that must start a Run now, in every organization.
		 * Each one gets its next time in the same step, so two workers never start the same Run.
		 */
		readonly due: Effect.Effect<
			ReadonlyArray<Stored>,
			WorkflowsApi.WorkflowStorageUnavailable
		>
	}
>()("@openbot-build/openbot/workflows/Workflows") {}

type Row = typeof workflows.$inferSelect

export const make: Effect.Effect<
	typeof Workflows.Service,
	never,
	PgClient.PgClient | Agents
> = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
	const sql = yield* PgClient.PgClient
	const agents = yield* Agents
	const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.mapError(unavailable))
	const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		sql
			.withTransaction(effect)
			.pipe(Effect.catchTag("SqlError", () => Effect.fail(unavailable())))

	const fromRow = (row: Row) =>
		Effect.gen(function* () {
			const definition = yield* Schema.decodeEffect(definitionCodec)(
				row.definition,
			).pipe(Effect.mapError(unavailable))
			const owner: WorkflowsApi.WorkflowOwner =
				row.ownerKind === "Organization"
					? { _tag: "Organization" }
					: row.ownerKind === "Agent"
						? {
								_tag: "Agent",
								agent: row.ownerAgent as AgentsApi.AgentId,
								userId: row.ownerUserId,
							}
						: { _tag: "Member", userId: row.ownerUserId ?? "" }
			const workflow: Workflow = {
				id: WorkflowsApi.WorkflowId.make(row.id),
				owner,
				name: row.name,
				description: row.description,
				agent: row.agent === null ? null : (row.agent as AgentsApi.AgentId),
				...(definition.judge === undefined ? {} : { judge: definition.judge }),
				steps: definition.steps,
				schedule:
					row.scheduleCron === null
						? null
						: {
								cron: row.scheduleCron,
								...(row.scheduleTimeZone === null
									? {}
									: { timeZone: row.scheduleTimeZone }),
							},
				webhook: row.hookSecretHash !== null,
				actor: row.actor,
				archived: row.archived,
				revision: row.revision,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
			}
			return workflow
		})
	/** The row columns of a Workflow. The hash of the webhook secret is not part of the API value. */
	const toRow = (organizationId: string, workflow: Workflow, now: number) =>
		Effect.gen(function* () {
			const definition = yield* Schema.encodeEffect(definitionCodec)({
				steps: workflow.steps,
				...(workflow.judge === undefined ? {} : { judge: workflow.judge }),
			}).pipe(Effect.mapError(unavailable))
			const next =
				workflow.schedule === null || workflow.archived
					? null
					: Result.getOrNull(nextRun({ schedule: workflow.schedule, now }))
			return {
				organizationId,
				id: workflow.id,
				ownerKind: workflow.owner._tag,
				ownerUserId:
					workflow.owner._tag === "Organization" ? null : workflow.owner.userId,
				ownerAgent:
					workflow.owner._tag === "Agent" ? workflow.owner.agent : null,
				name: workflow.name,
				description: workflow.description,
				agent: workflow.agent,
				definition,
				scheduleCron: workflow.schedule?.cron ?? null,
				scheduleTimeZone: workflow.schedule?.timeZone ?? null,
				nextRunAt: next,
				actor: workflow.actor,
				revision: workflow.revision,
				archived: workflow.archived,
				createdAt: workflow.createdAt,
				updatedAt: workflow.updatedAt,
			}
		})
	const where = (organizationId: string, id: string) =>
		and(eq(workflows.organizationId, organizationId), eq(workflows.id, id))
	const findRow = (organizationId: string, id: string, lock = false) =>
		stored(
			lock
				? db
						.select()
						.from(workflows)
						.where(where(organizationId, id))
						.for("update")
				: db.select().from(workflows).where(where(organizationId, id)),
		).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))
	const find: typeof Workflows.Service.find = (organizationId, id) =>
		findRow(organizationId, id).pipe(
			Effect.flatMap((row) =>
				Option.match(row, {
					onNone: () => Effect.succeedNone,
					onSome: (row) => Effect.asSome(fromRow(row)),
				}),
			),
		)
	const keyOf = (caller: Caller, workflow: Pick<Workflow, "id" | "owner">) =>
		workflowKey({ ...workflow, organizationId: caller.organizationId })
	const check = (
		caller: Caller,
		workflow: Workflow,
		permission: Permissions.PermissionGroupId,
	) =>
		Effect.gen(function* () {
			const key = keyOf(caller, workflow)
			// A caller who cannot read the Workflow does not learn that it exists.
			if (!(yield* can({ caller, permission: "workflows.read", key })))
				return yield* notFound(workflow.id)
			if (
				permission !== "workflows.read" &&
				!(yield* can({ caller, permission, key }))
			)
				return yield* Permissions.PermissionDenied.make({
					permission,
					resource: key,
				})
			return workflow
		})
	const access: typeof Workflows.Service.access = (caller, id, permission) =>
		find(caller.organizationId, id).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.fail(notFound(id)),
					onSome: (workflow) => check(caller, workflow, permission),
				}),
			),
		)
	/** Checks the steps, the schedule and the Agents of a Workflow before it is saved. */
	const validate = (caller: Caller, workflow: Workflow, now: number) =>
		Effect.gen(function* () {
			const ids = workflow.steps.map((step) => step.id)
			const repeated = ids.find((id, index) => ids.indexOf(id) !== index)
			if (repeated !== undefined)
				return yield* invalid(`Two steps have the id ${repeated}.`)
			for (const step of workflow.steps) {
				if (step._tag === "Extract") {
					const schema = extractSchema(step.schema)
					if (Result.isFailure(schema)) return yield* invalid(schema.failure)
				}
				if (
					step._tag === "WaitFor" &&
					step.intervalSeconds > step.timeoutSeconds
				)
					return yield* invalid(
						`In step ${step.id}, intervalSeconds must not be more than timeoutSeconds.`,
					)
			}
			if (workflow.schedule !== null) {
				const next = nextRun({ schedule: workflow.schedule, now })
				if (Result.isFailure(next)) return yield* invalid(next.failure)
			}
			// The caller must be able to give work to every Agent of the Workflow.
			const used = [
				...(workflow.agent === null ? [] : [workflow.agent]),
				...workflow.steps.flatMap((step) =>
					"agent" in step && step.agent !== undefined ? [step.agent] : [],
				),
			]
			for (const agent of new Set(used))
				yield* agents.access(caller, agent, "agents.delegate").pipe(
					Effect.catchTags({
						AgentNotFound: () =>
							Effect.fail(invalid(`There is no Agent ${agent}.`)),
						AgentConflict: () => Effect.fail(unavailable()),
						AgentInvalid: () => Effect.fail(unavailable()),
						AgentStorageUnavailable: () => Effect.fail(unavailable()),
					}),
				)
		})
	const put = (organizationId: string, workflow: Workflow, now: number) =>
		toRow(organizationId, workflow, now).pipe(
			Effect.flatMap(({ organizationId: _organization, id: _id, ...set }) =>
				stored(
					db
						.insert(workflows)
						.values({ organizationId, id: workflow.id, ...set })
						.onConflictDoUpdate({
							target: [workflows.organizationId, workflows.id],
							set,
						}),
				),
			),
			Effect.as(workflow),
		)
	/** Reads, checks and changes a Workflow in one transaction, with its row locked. */
	const change = <E, R>(
		caller: Caller,
		id: string,
		permission: Permissions.PermissionGroupId,
		update: (
			workflow: Workflow,
			now: number,
		) => Effect.Effect<
			{ readonly workflow: Workflow; readonly hash?: string | null },
			E,
			R
		>,
	) =>
		transaction(
			Effect.gen(function* () {
				const row = yield* findRow(caller.organizationId, id, true)
				if (Option.isNone(row)) return yield* notFound(id)
				const current = yield* check(
					caller,
					yield* fromRow(row.value),
					permission,
				)
				const now = yield* Clock.currentTimeMillis
				const next = yield* update(current, now)
				const workflow = {
					...next.workflow,
					revision: current.revision + 1,
					updatedAt: now,
				}
				yield* put(caller.organizationId, workflow, now)
				if (next.hash !== undefined)
					yield* stored(
						db
							.update(workflows)
							.set({ hookSecretHash: next.hash })
							.where(where(caller.organizationId, id)),
					)
				return {
					...workflow,
					webhook:
						next.hash === undefined ? workflow.webhook : next.hash !== null,
				}
			}),
		)
	const visible = (caller: Caller, rows: ReadonlyArray<Row>) =>
		Effect.forEach(rows, fromRow).pipe(
			Effect.flatMap((list) =>
				Effect.filter(list, (workflow) =>
					can({
						caller,
						permission: "workflows.read",
						key: keyOf(caller, workflow),
					}),
				),
			),
		)
	return Workflows.of({
		find,
		access,
		list: (caller, input) =>
			Effect.gen(function* () {
				const rows = yield* stored(
					db
						.select()
						.from(workflows)
						.where(
							and(
								eq(workflows.organizationId, caller.organizationId),
								input.owner !== undefined
									? eq(workflows.ownerAgent, input.owner)
									: or(
											eq(workflows.ownerUserId, caller.userId),
											eq(workflows.ownerKind, "Organization"),
										),
								input.archived === undefined
									? undefined
									: eq(workflows.archived, input.archived),
							),
						)
						.orderBy(workflows.createdAt, workflows.id),
				)
				return yield* visible(caller, rows)
			}),
		create: (caller, input) =>
			Effect.gen(function* () {
				if (input.shared === true && input.owner !== undefined)
					return yield* invalid("A shared Workflow cannot have an owner Agent.")
				const owner: WorkflowsApi.WorkflowOwner =
					input.owner !== undefined
						? yield* agents.access(caller, input.owner, "agents.read").pipe(
								Effect.map((agent): WorkflowsApi.WorkflowOwner => ({
									_tag: "Agent",
									agent: agent.id,
									userId: rootOf(agent.owner),
								})),
								Effect.catchTags({
									AgentNotFound: () =>
										Effect.fail(invalid(`There is no Agent ${input.owner}.`)),
									AgentConflict: () => Effect.fail(unavailable()),
									AgentInvalid: () => Effect.fail(unavailable()),
									AgentStorageUnavailable: () => Effect.fail(unavailable()),
								}),
							)
						: input.shared === true
							? { _tag: "Organization" }
							: { _tag: "Member", userId: caller.userId }
				const now = yield* Clock.currentTimeMillis
				const workflow: Workflow = {
					id: WorkflowsApi.WorkflowId.make(
						"wfl_" + randomUUID().replaceAll("-", ""),
					),
					owner,
					name: input.name,
					description: input.description ?? "",
					agent: input.agent ?? null,
					...(input.judge === undefined ? {} : { judge: input.judge }),
					steps: input.steps,
					schedule: input.schedule ?? null,
					webhook: false,
					actor: input.schedule === undefined ? null : caller.userId,
					archived: false,
					revision: 0,
					createdAt: now,
					updatedAt: now,
				}
				const key = keyOf(caller, workflow)
				if (!(yield* can({ caller, permission: "workflows.write", key })))
					return yield* Permissions.PermissionDenied.make({
						permission: "workflows.write",
						resource: key,
					})
				yield* validate(caller, workflow, now)
				return yield* put(caller.organizationId, workflow, now)
			}),
		update: (caller, id, input) =>
			change(caller, id, "workflows.write", (current, now) =>
				Effect.gen(function* () {
					if (current.revision !== input.expected)
						return yield* WorkflowsApi.WorkflowConflict.make({
							message: "The Workflow changed. Read it again and retry.",
						})
					const { judge: _judge, ...rest } = current
					const judge =
						input.judge === undefined
							? current.judge
							: (input.judge ?? undefined)
					const workflow: Workflow = {
						...rest,
						...(judge === undefined ? {} : { judge }),
						...(input.name === undefined ? {} : { name: input.name }),
						...(input.description === undefined
							? {}
							: { description: input.description }),
						...(input.agent === undefined ? {} : { agent: input.agent }),
						...(input.steps === undefined ? {} : { steps: input.steps }),
						...(input.schedule === undefined
							? {}
							: { schedule: input.schedule, actor: caller.userId }),
						...(input.archived === undefined
							? {}
							: { archived: input.archived }),
					}
					yield* validate(caller, workflow, now)
					return { workflow }
				}),
			),
		setWebhook: (caller, id) =>
			Effect.gen(function* () {
				const secret = "owh_" + randomBytes(32).toString("base64url")
				const workflow = yield* change(
					caller,
					id,
					"workflows.write",
					(current) =>
						Effect.succeed({
							workflow: { ...current, actor: caller.userId },
							hash: hashSecret(secret),
						}),
				)
				return { workflow, secret }
			}),
		removeWebhook: (caller, id) =>
			change(caller, id, "workflows.write", (current) =>
				Effect.succeed({ workflow: current, hash: null }),
			),
		verifyHook: (id, secret) =>
			Effect.gen(function* () {
				const row = (yield* stored(
					db.select().from(workflows).where(eq(workflows.id, id)),
				))[0]
				if (row === undefined || row.hookSecretHash === null || row.archived)
					return Option.none()
				const expected = Buffer.from(row.hookSecretHash, "hex")
				const given = Buffer.from(hashSecret(secret), "hex")
				if (!timingSafeEqual(expected, given)) return Option.none()
				return Option.some({
					organizationId: row.organizationId,
					workflow: yield* fromRow(row),
				})
			}),
		due: transaction(
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const rows = yield* stored(
					db
						.select()
						.from(workflows)
						.where(
							and(
								isNotNull(workflows.scheduleCron),
								eq(workflows.archived, false),
								lte(workflows.nextRunAt, now),
							),
						)
						.limit(100)
						.for("update", { skipLocked: true }),
				)
				const list = yield* Effect.forEach(rows, (row) =>
					Effect.gen(function* () {
						const workflow = yield* fromRow(row)
						const next =
							workflow.schedule === null
								? null
								: Result.getOrNull(
										nextRun({ schedule: workflow.schedule, now }),
									)
						yield* stored(
							db
								.update(workflows)
								.set({ nextRunAt: next })
								.where(where(row.organizationId, row.id)),
						)
						return { organizationId: row.organizationId, workflow }
					}),
				)
				return list
			}),
		),
	})
})
export const layer = Layer.effect(Workflows, make)
