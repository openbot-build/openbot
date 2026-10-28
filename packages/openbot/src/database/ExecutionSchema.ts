import { sql } from "drizzle-orm"
import {
	pgTable,
	text,
	uuid,
	integer,
	bigint,
	bigserial,
	serial,
	boolean,
	timestamp,
	varchar,
	primaryKey,
	foreignKey,
	index,
	uniqueIndex,
	unique,
	check,
} from "drizzle-orm/pg-core"

const time = (name: string) => bigint(name, { mode: "number" })

export const executions = pgTable(
	"openbot_executions",
	{
		namespace: text().notNull(),
		id: text().notNull(),
		workflow: text().notNull(),
		/** The execution that must wait for this work and its notices to end. */
		ownerExecutionId: text("owner_execution_id"),
		resourceKind: text("resource_kind").notNull(),
		resourceId: text("resource_id").notNull(),
		/** The resource that admits this work. This is not execution ownership. */
		contextKind: text("context_kind"),
		contextId: text("context_id"),
		organizationId: text("organization_id"),
		userId: text("user_id"),
		principalKind: text("principal_kind").notNull().default("member"),
		serviceId: text("service_id"),
		/** Identity and input are sealed. Engine messages carry only this row's ID. */
		identity: text().notNull(),
		input: text().notNull(),
		status: text().notNull(),
		generation: integer().notNull().default(0),
		cancelEpoch: integer("cancel_epoch").notNull().default(0),
		/** Keep the cancel request while an outside result is unknown. */
		cancelPending: boolean("cancel_pending").notNull().default(false),
		sequence: time("sequence").notNull().default(0),
		failure: text(),
		/** A phase failed after storage retry. Unknown call details alone do not stop a retry. */
		phaseFailed: boolean("phase_failed").notNull().default(false),
		createdAt: time("created_at").notNull(),
		updatedAt: time("updated_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.id] }),
		uniqueIndex("openbot_executions_id").on(t.id),
		check(
			"openbot_executions_principal",
			sql`(
			${t.principalKind} = 'member' and ${t.organizationId} is not null
			and ${t.userId} is not null and ${t.serviceId} is null
		) or (
			${t.principalKind} = 'service' and ${t.userId} is null
			and ${t.serviceId} is not null
		)`,
		),
		index("openbot_executions_work_owner").on(t.ownerExecutionId, t.status),
		foreignKey({ columns: [t.ownerExecutionId], foreignColumns: [t.id] }),
		index("openbot_executions_context").on(
			t.namespace,
			t.contextKind,
			t.contextId,
			t.status,
		),
		index("openbot_executions_resource").on(
			t.namespace,
			t.resourceKind,
			t.resourceId,
		),
		index("openbot_executions_owner").on(
			t.namespace,
			t.organizationId,
			t.userId,
		),
	],
)

export const executionEvents = pgTable(
	"openbot_execution_events",
	{
		namespace: text().notNull(),
		executionId: text("execution_id").notNull(),
		sequence: time("sequence").notNull(),
		/** A stable event key has no user text or secrets. */
		key: text("event_key"),
		/** Sealed with the execution ID and sequence as its binding. */
		body: text().notNull(),
		createdAt: time("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.executionId, t.sequence] }),
		uniqueIndex("openbot_execution_events_key").on(
			t.namespace,
			t.executionId,
			t.key,
		),
		foreignKey({
			columns: [t.namespace, t.executionId],
			foreignColumns: [executions.namespace, executions.id],
		}),
	],
)

export const executionCommands = pgTable(
	"openbot_execution_commands",
	{
		namespace: text().notNull(),
		id: uuid().notNull(),
		executionId: text("execution_id").notNull(),
		organizationId: text("organization_id"),
		userId: text("user_id"),
		principalKind: text("principal_kind").notNull().default("member"),
		serviceId: text("service_id"),
		key: text().notNull(),
		/** The sealed request is checked when a key is used again. */
		body: text().notNull(),
		kind: text().notNull(),
		/** Keep the original cancel signal when an outbox row is sent again. */
		cancelEpoch: integer("cancel_epoch"),
		sequence: time("sequence").notNull(),
		createdAt: time("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.id] }),
		unique("openbot_execution_commands_key")
			.on(
				t.namespace,
				t.principalKind,
				t.organizationId,
				t.userId,
				t.serviceId,
				t.key,
			)
			.nullsNotDistinct(),
		check(
			"openbot_execution_commands_principal",
			sql`(
			${t.principalKind} = 'member' and ${t.organizationId} is not null
			and ${t.userId} is not null and ${t.serviceId} is null
		) or (
			${t.principalKind} = 'service' and ${t.userId} is null
			and ${t.serviceId} is not null
		)`,
		),
		foreignKey({
			columns: [t.namespace, t.executionId],
			foreignColumns: [executions.namespace, executions.id],
		}),
	],
)

/** A row is marked sent only after the engine has stored its message. */
export const executionOutbox = pgTable(
	"openbot_execution_outbox",
	{
		namespace: text().notNull(),
		commandId: uuid("command_id").notNull(),
		executionId: text("execution_id").notNull(),
		createdAt: time("created_at").notNull(),
		sentAt: time("sent_at"),
		retryAt: time("retry_at").notNull().default(0),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.commandId] }),
		foreignKey({
			columns: [t.namespace, t.commandId],
			foreignColumns: [executionCommands.namespace, executionCommands.id],
		}),
		index("openbot_execution_outbox_pending")
			.on(t.retryAt, t.createdAt)
			.where(sql`${t.sentAt} is null`),
	],
)

/** Tool input stays in the sealed execution. These keys support Chat queries and one child per call. */
export const toolExecutions = pgTable(
	"openbot_tool_executions",
	{
		namespace: text().notNull(),
		id: text().notNull(),
		executionId: text("execution_id").notNull(),
		parentExecutionId: text("parent_execution_id").notNull(),
		chat: text().notNull(),
		turn: text().notNull(),
		item: text().notNull(),
		callId: text("call_id").notNull(),
		detached: boolean().notNull().default(false),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.id] }),
		uniqueIndex("openbot_tool_executions_execution").on(
			t.namespace,
			t.executionId,
		),
		uniqueIndex("openbot_tool_executions_call").on(
			t.namespace,
			t.parentExecutionId,
			t.item,
			t.callId,
		),
		index("openbot_tool_executions_chat").on(t.namespace, t.chat),
		foreignKey({
			columns: [t.namespace, t.executionId],
			foreignColumns: [executions.namespace, executions.id],
		}),
		foreignKey({
			columns: [t.namespace, t.parentExecutionId],
			foreignColumns: [executions.namespace, executions.id],
		}),
	],
)

/** Outside actions have a stable call ID, even when an execution changes owner. */
export const executionCalls = pgTable(
	"openbot_execution_calls",
	{
		namespace: text().notNull(),
		id: text().notNull(),
		executionId: text("execution_id").notNull(),
		step: text().notNull(),
		attempt: integer().notNull(),
		generation: integer().notNull(),
		retry: text().notNull(),
		status: text().notNull(),
		input: text().notNull(),
		result: text(),
		completionSequence: integer(),
		createdAt: time("created_at").notNull(),
		updatedAt: time("updated_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.id] }),
		uniqueIndex("openbot_execution_calls_step").on(
			t.namespace,
			t.executionId,
			t.step,
			t.attempt,
		),
		foreignKey({
			columns: [t.namespace, t.executionId],
			foreignColumns: [executions.namespace, executions.id],
		}),
	],
)

/** A decision is made once. Its answer and actor are sealed. */
export const executionDecisions = pgTable(
	"openbot_execution_decisions",
	{
		namespace: text().notNull(),
		executionId: text("execution_id").notNull(),
		id: text().notNull(),
		choices: text().notNull(),
		answer: text(),
		createdAt: time("created_at").notNull(),
		answeredAt: time("answered_at"),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.executionId, t.id] }),
		foreignKey({
			columns: [t.namespace, t.executionId],
			foreignColumns: [executions.namespace, executions.id],
		}),
	],
)

/** Full causes are sealed. Public results carry only this ID and a safe class. */
export const executionFailures = pgTable("openbot_execution_failures", {
	id: text().primaryKey(),
	executionId: text("execution_id"),
	cause: text().notNull(),
	createdAt: time("created_at").notNull(),
})

/** These four tables follow the storage format of the pinned Effect version. */
export const clusterMessages = pgTable(
	"openbot_cluster_messages",
	{
		id: bigint({ mode: "bigint" }).primaryKey(),
		rowid: bigserial({ mode: "bigint" }),
		messageId: varchar("message_id", { length: 255 }),
		shardId: varchar("shard_id", { length: 50 }).notNull(),
		entityType: varchar("entity_type", { length: 150 }).notNull(),
		entityId: varchar("entity_id", { length: 255 }).notNull(),
		kind: integer().notNull(),
		tag: varchar({ length: 50 }),
		payload: text(),
		headers: text(),
		traceId: varchar("trace_id", { length: 32 }),
		spanId: varchar("span_id", { length: 16 }),
		sampled: boolean(),
		processed: boolean().notNull().default(false),
		requestId: bigint("request_id", { mode: "bigint" }).notNull(),
		replyId: bigint("reply_id", { mode: "bigint" }),
		lastReplyId: bigint("last_reply_id", { mode: "bigint" }),
		lastRead: timestamp("last_read"),
		deliverAt: bigint("deliver_at", { mode: "bigint" }),
	},
	(t) => [
		uniqueIndex("openbot_cluster_messages_message_id").on(t.messageId),
		index("openbot_cluster_messages_shard").on(
			t.shardId,
			t.processed,
			t.lastRead,
			t.deliverAt,
		),
		index("openbot_cluster_messages_request").on(t.requestId),
		index("openbot_cluster_messages_rowid").on(t.rowid),
	],
)

export const clusterReplies = pgTable(
	"openbot_cluster_replies",
	{
		id: bigint({ mode: "bigint" }).primaryKey(),
		rowid: bigserial({ mode: "bigint" }),
		kind: integer(),
		requestId: bigint("request_id", { mode: "bigint" }).notNull(),
		payload: text().notNull(),
		sequence: integer(),
		acked: boolean().notNull().default(false),
	},
	(t) => [
		uniqueIndex("openbot_cluster_replies_exit").on(t.requestId, t.kind),
		uniqueIndex("openbot_cluster_replies_sequence").on(t.requestId, t.sequence),
		index("openbot_cluster_replies_request").on(t.requestId),
	],
)

export const clusterRunners = pgTable(
	"openbot_cluster_runners",
	{
		machineId: serial("machine_id").primaryKey(),
		address: varchar({ length: 255 }).notNull(),
		runner: text().notNull(),
		healthy: boolean().notNull().default(true),
		lastHeartbeat: timestamp("last_heartbeat").notNull().defaultNow(),
	},
	(t) => [uniqueIndex("openbot_cluster_runners_address").on(t.address)],
)

export const clusterLocks = pgTable("openbot_cluster_locks", {
	shardId: varchar("shard_id", { length: 50 }).primaryKey(),
	address: varchar({ length: 255 }).notNull(),
	acquiredAt: timestamp("acquired_at").notNull(),
})

/** The one saved tool call that used a one-use Grant. The command seals its input. */
export const grantUses = pgTable(
	"openbot_grant_uses",
	{
		namespace: text().notNull(),
		turnExecutionId: text("turn_execution_id").notNull(),
		callKey: text("call_key").notNull(),
		organizationId: text("organization_id").notNull(),
		grantId: text("grant_id").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.turnExecutionId, t.callKey] }),
		uniqueIndex("openbot_grant_uses_grant").on(t.organizationId, t.grantId),
		foreignKey({
			columns: [t.namespace, t.turnExecutionId],
			foreignColumns: [executions.namespace, executions.id],
		}),
	],
)

/** Feature work keeps the accepted tool frame and its own path inside that call. */
export const toolOrigins = pgTable(
	"openbot_tool_origins",
	{
		namespace: text().notNull(),
		executionId: text("execution_id").notNull(),
		toolExecutionId: text("tool_execution_id").notNull(),
		path: text().array().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.executionId] }),
		foreignKey({
			columns: [t.namespace, t.executionId],
			foreignColumns: [executions.namespace, executions.id],
		}),
		foreignKey({
			columns: [t.namespace, t.toolExecutionId],
			foreignColumns: [toolExecutions.namespace, toolExecutions.executionId],
		}),
	],
)

/** App records keep their business ID and source. Call results stay in the shared log. */
export const appExecutions = pgTable(
	"openbot_app_executions",
	{
		namespace: text().notNull(),
		executionId: text("execution_id").notNull(),
		id: text().notNull(),
		sourceExecutionId: text("source_execution_id").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.executionId] }),
		uniqueIndex("openbot_app_executions_id").on(t.namespace, t.id),
		index("openbot_app_executions_source").on(t.namespace, t.sourceExecutionId),
		foreignKey({
			columns: [t.namespace, t.executionId],
			foreignColumns: [executions.namespace, executions.id],
		}),
		foreignKey({
			columns: [t.namespace, t.sourceExecutionId],
			foreignColumns: [executions.namespace, executions.id],
		}),
	],
)

/** An input answer is sealed with its actor. The command and wake-up commit with it. */
export const appInputs = pgTable(
	"openbot_app_inputs",
	{
		namespace: text().notNull(),
		executionId: text("execution_id").notNull(),
		round: integer().notNull(),
		body: text().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.executionId, t.round] }),
		foreignKey({
			columns: [t.namespace, t.executionId],
			foreignColumns: [appExecutions.namespace, appExecutions.executionId],
		}),
	],
)

/** Code runs keep a business ID. Their calls and output use the common call log. */
export const codeExecutions = pgTable(
	"openbot_code_executions",
	{
		namespace: text().notNull(),
		executionId: text("execution_id").notNull(),
		id: text().notNull(),
		sourceExecutionId: text("source_execution_id").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.executionId] }),
		uniqueIndex("openbot_code_executions_id").on(t.namespace, t.id),
		index("openbot_code_executions_source").on(
			t.namespace,
			t.sourceExecutionId,
		),
		foreignKey({
			columns: [t.namespace, t.executionId],
			foreignColumns: [executions.namespace, executions.id],
		}),
		foreignKey({
			columns: [t.namespace, t.sourceExecutionId],
			foreignColumns: [executions.namespace, executions.id],
		}),
	],
)

/** Own running periods let children exclude ancestor pauses without changing child rows. */
export const delegationPeriods = pgTable(
	"openbot_delegation_periods",
	{
		namespace: text().notNull(),
		executionId: text("execution_id").notNull(),
		epoch: integer().notNull(),
		startedAt: time("started_at").notNull(),
		endedAt: time("ended_at"),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.executionId, t.epoch] }),
		foreignKey({
			columns: [t.namespace, t.executionId],
			foreignColumns: [executions.namespace, executions.id],
		}),
		uniqueIndex("openbot_delegation_periods_open")
			.on(t.namespace, t.executionId)
			.where(sql`${t.endedAt} is null`),
	],
)
