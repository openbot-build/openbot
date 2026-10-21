import {
	pgTable,
	text,
	integer,
	primaryKey,
	index,
	boolean,
	bigint,
	bigserial,
} from "drizzle-orm/pg-core"
import { openbot_auth_user } from "./AuthSchema.ts"
const table = pgTable
export const developerRecords = table(
	"openbot_developer_records",
	{
		kind: text().notNull(),
		id: text().notNull(),
		owner: text().notNull(),
		scope: text().notNull(),
		body: text().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.kind, t.id] }),
		index("openbot_developer_records_owner").on(t.kind, t.owner),
		index("openbot_developer_records_scope").on(t.kind, t.scope),
	],
)
export const appInvocations = table(
	"openbot_app_invocations",
	{
		owner: text().notNull(),
		id: text().notNull(),
		session: text().notNull(),
		status: text().notNull(),
		body: text().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.owner, t.id] }),
		index("openbot_app_invocations_session").on(t.owner, t.session),
	],
)
export const appAuthorizations = table("openbot_app_authorizations", {
	id: text().primaryKey(),
	owner: text().notNull(),
	connectionId: text("connection_id").notNull(),
	revision: integer().notNull(),
	expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
	returnTo: text("return_to").notNull(),
	status: text().notNull(),
	callback: text(),
	reason: text(),
	issuer: text().notNull(),
	resource: text().notNull(),
	scopes: text().notNull(),
})
export const appIndexJobs = table(
	"openbot_app_index_jobs",
	{
		namespace: text().notNull().default("public"),
		cardUrl: text("card_url").notNull(),
		nextCheckAt: bigint("next_check_at", { mode: "number" }).notNull(),
		leaseUntil: bigint("lease_until", { mode: "number" }).notNull().default(0),
		claim: text(),
		check: text(),
		generation: text().notNull().default(""),
		completedGeneration: text("completed_generation"),
		sources: text().notNull().default("[]"),
		requestedAt: bigint("requested_at", { mode: "number" })
			.notNull()
			.default(0),
		startedAt: bigint("started_at", { mode: "number" }).notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.namespace, t.cardUrl] })],
)
export const appIndexResults = table(
	"openbot_app_index_results",
	{
		namespace: text().notNull(),
		cardUrl: text("card_url").notNull(),
		generation: text().notNull(),
		check: text().notNull(),
		finishedAt: bigint("finished_at", { mode: "number" }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.namespace, t.cardUrl, t.generation] })],
)
export const appSecrets = table(
	"openbot_app_secrets",
	{
		owner: text().notNull(),
		kind: text().notNull(),
		id: text().notNull(),
		connectionId: text("connection_id").notNull(),
		body: text().notNull(),
		consumed: boolean().notNull().default(false),
	},
	(t) => [primaryKey({ columns: [t.owner, t.kind, t.id] })],
)
export const appRecords = table(
	"openbot_app_records",
	{
		owner: text().notNull(),
		cardUrl: text("card_url").notNull(),
		body: text().notNull(),
	},
	(t) => [primaryKey({ columns: [t.owner, t.cardUrl] })],
)
export const appDrafts = table(
	"openbot_app_drafts",
	{
		owner: text().notNull(),
		id: text().notNull(),
		body: text().notNull(),
	},
	(t) => [primaryKey({ columns: [t.owner, t.id] })],
)
export const appConnections = table(
	"openbot_app_connections",
	{
		owner: text().notNull(),
		id: text().notNull(),
		name: text().notNull(),
		revision: integer().notNull(),
		body: text().notNull(),
		verification: text(),
	},
	(t) => [primaryKey({ columns: [t.owner, t.id] })],
)
export const appIndexEntries = table(
	"openbot_app_index_entries",
	{
		namespace: text().notNull().default("public"),
		cardUrl: text("card_url").notNull(),
		body: text().notNull(),
	},
	(t) => [primaryKey({ columns: [t.namespace, t.cardUrl] })],
)

export const versions = table(
	"openbot_timeline_versions",
	{
		namespace: text().notNull(),
		id: text().notNull(),
		schemaVersion: text("schema_version").notNull(),
		parents: text().notNull(),
		format: integer("snapshot_format").notNull(),
		value: text().notNull(),
		history: text().notNull(),
	},
	(t) => [primaryKey({ columns: [t.namespace, t.id] })],
)
export const contents = table(
	"openbot_timeline_contents",
	{
		namespace: text().notNull(),
		id: text().notNull(),
		message: text().notNull(),
		content: text().notNull(),
	},
	(t) => [primaryKey({ columns: [t.namespace, t.id] })],
)
export const refs = table(
	"openbot_session_references",
	{
		namespace: text().notNull(),
		id: text().notNull(),
		body: text().notNull(),
		head: text().notNull(),
		archived: integer().notNull(),
		status: text().notNull(),
		turn: text(),
		response: text(),
		responseSummary: text("response_summary"),
		revision: integer().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.id] }),
		index("openbot_session_references_list").on(t.namespace, t.archived, t.id),
	],
)

/** One deployment has one organization. Lists are JSON text. */
export const organizations = table("openbot_organizations", {
	id: text().primaryKey(),
	name: text().notNull(),
	allowedEmailDomains: text("allowed_email_domains").notNull(),
	defaultRoles: text("default_roles").notNull(),
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
})

/** Roles and policies are JSON text. */
export const members = table(
	"openbot_members",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => openbot_auth_user.id, { onDelete: "cascade" }),
		email: text(),
		name: text(),
		status: text().notNull(),
		roles: text().notNull(),
		policies: text().notNull(),
		joinedAt: bigint("joined_at", { mode: "number" }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.organizationId, t.userId] })],
)

/** User tokens store only a SHA-256 hash of their long random secret. */
export const tokens = table(
	"openbot_tokens",
	{
		id: text().primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => openbot_auth_user.id, { onDelete: "cascade" }),
		name: text().notNull(),
		prefix: text().notNull(),
		hash: text().notNull().unique(),
		policies: text().notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		expiresAt: bigint("expires_at", { mode: "number" }),
		lastUsedAt: bigint("last_used_at", { mode: "number" }),
	},
	(t) => [index("openbot_tokens_owner").on(t.organizationId, t.userId)],
)

/** The audit log only grows. The sequence gives a stable order. */
export const auditLogs = table(
	"openbot_audit_logs",
	{
		sequence: bigserial({ mode: "number" }).primaryKey(),
		organizationId: text("organization_id").notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		action: text().notNull(),
		actorUserId: text("actor_user_id").notNull(),
		actor: text().notNull(),
		resource: text().notNull(),
		details: text().notNull(),
	},
	(t) => [
		index("openbot_audit_logs_list").on(t.organizationId, t.sequence),
		index("openbot_audit_logs_actor").on(
			t.organizationId,
			t.actorUserId,
			t.sequence,
		),
	],
)

/**
 * Records of Agents, their memory, delegations, Grants, Rules and requests.
 * `owner` and `scope` are the two keys that lists filter by. `status` helps recovery find open work.
 */
export const agentRecords = table(
	"openbot_agent_records",
	{
		kind: text().notNull(),
		organizationId: text("organization_id").notNull(),
		id: text().notNull(),
		owner: text().notNull(),
		scope: text().notNull(),
		status: text().notNull(),
		body: text().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.kind, t.organizationId, t.id] }),
		index("openbot_agent_records_owner").on(t.kind, t.organizationId, t.owner),
		index("openbot_agent_records_scope").on(t.kind, t.organizationId, t.scope),
		index("openbot_agent_records_status").on(t.kind, t.status),
	],
)
