import {
	pgTable,
	text,
	integer,
	primaryKey,
	index,
	boolean,
	bigint,
	bigserial,
	uniqueIndex,
	foreignKey,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { openbot_auth_user } from "./AuthSchema.ts"
const table = pgTable
const namespace = () => text().notNull().default("public")
const time = (name: string) => bigint(name, { mode: "number" })
/** A domain or App Card claim that waits for its proof. */
export const developerClaims = table(
	"openbot_developer_claims",
	{
		namespace: namespace(),
		id: text().notNull(),
		owner: text().notNull(),
		scopeKey: text("scope_key").notNull(),
		scope: text().notNull(),
		token: text().notNull(),
		status: text().notNull(),
		createdAt: time("created_at").notNull(),
		expiresAt: time("expires_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.id] }),
		index("openbot_developer_claims_owner").on(t.namespace, t.owner),
	],
)
/** A confirmed claim. It has the ID of its claim. */
export const developerProofs = table(
	"openbot_developer_proofs",
	{
		namespace: namespace(),
		id: text().notNull(),
		owner: text().notNull(),
		scopeKey: text("scope_key").notNull(),
		scope: text().notNull(),
		token: text().notNull(),
		transition: integer().notNull(),
		status: text().notNull(),
		confirmedAt: time("confirmed_at"),
		validUntil: time("valid_until").notNull(),
		nextVerificationAt: time("next_verification_at").notNull(),
		reason: text(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.id] }),
		foreignKey({
			columns: [t.namespace, t.id],
			foreignColumns: [developerClaims.namespace, developerClaims.id],
		}).onDelete("cascade"),
		index("openbot_developer_proofs_owner").on(t.namespace, t.owner),
		index("openbot_developer_proofs_due").on(
			t.namespace,
			t.status,
			t.nextVerificationAt,
		),
	],
)
export const developerMembers = table(
	"openbot_developer_members",
	{
		namespace: namespace(),
		id: text().notNull(),
		proofId: text("proof_id").notNull(),
		owner: text().notNull(),
		role: text().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.id] }),
		foreignKey({
			columns: [t.namespace, t.proofId],
			foreignColumns: [developerProofs.namespace, developerProofs.id],
		}).onDelete("cascade"),
		uniqueIndex("openbot_developer_members_proof_owner").on(
			t.namespace,
			t.proofId,
			t.owner,
		),
		index("openbot_developer_members_owner").on(t.namespace, t.owner),
	],
)
export const developerInvitations = table(
	"openbot_developer_invitations",
	{
		namespace: namespace(),
		/** A secret bearer token. */
		id: text().notNull(),
		proofId: text("proof_id").notNull(),
		owner: text().notNull(),
		role: text().notNull(),
		expiresAt: time("expires_at").notNull(),
		status: text().notNull(),
		acceptedBy: text("accepted_by"),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.id] }),
		foreignKey({
			columns: [t.namespace, t.proofId],
			foreignColumns: [developerProofs.namespace, developerProofs.id],
		}).onDelete("cascade"),
		index("openbot_developer_invitations_proof").on(t.namespace, t.proofId),
	],
)
/** An App that a proof covers, with the state of its regular monitor check. */
export const developerApps = table(
	"openbot_developer_apps",
	{
		namespace: namespace(),
		cardUrl: text("card_url").notNull(),
		candidate: text().notNull(),
		nextCheckAt: time("next_check_at").notNull(),
		leaseUntil: time("lease_until").notNull().default(0),
		monitorToken: text("monitor_token"),
		monitorRevision: integer("monitor_revision").notNull().default(0),
		monitorIssues: text("monitor_issues").notNull().default("[]"),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.cardUrl] }),
		index("openbot_developer_apps_due").on(
			t.namespace,
			t.nextCheckAt,
			t.leaseUntil,
		),
	],
)
export const developerReports = table(
	"openbot_developer_reports",
	{
		namespace: namespace(),
		id: text().notNull(),
		/** The account that saved the report. It is null for a monitor report. */
		owner: text(),
		cardUrl: text("card_url").notNull(),
		checkedAt: time("checked_at").notNull(),
		report: text().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.id] }),
		index("openbot_developer_reports_owner").on(
			t.namespace,
			t.owner,
			t.checkedAt,
			t.id,
		),
		index("openbot_developer_reports_app").on(
			t.namespace,
			t.cardUrl,
			t.checkedAt,
			t.id,
		),
	],
)
/**
 * A connection test. `value` holds the full test. The other columns are copies
 * of its fields for queries, and only one function writes them.
 */
export const developerTests = table(
	"openbot_developer_tests",
	{
		namespace: namespace(),
		id: text().notNull(),
		owner: text().notNull(),
		cardUrl: text("card_url").notNull(),
		status: text().notNull(),
		cleanup: text().notNull(),
		expiresAt: time("expires_at").notNull(),
		value: text().notNull(),
		resourceMetadataUrl: text("resource_metadata_url"),
		cleanupToken: text("cleanup_token"),
		cleanupLeaseUntil: time("cleanup_lease_until").notNull().default(0),
		/** The sealed connection and credentials of the test. */
		privateState: text("private_state"),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.id] }),
		index("openbot_developer_tests_owner").on(t.namespace, t.owner),
		index("openbot_developer_tests_open")
			.on(t.namespace, t.expiresAt)
			.where(sql`${t.cleanup} <> 'Complete'`),
	],
)
/** An authorization flow of a connection test. A used flow has no `body` and no `callback`. */
export const developerTestFlows = table(
	"openbot_developer_test_flows",
	{
		namespace: namespace(),
		flowId: text("flow_id").notNull(),
		testId: text("test_id").notNull(),
		owner: text().notNull(),
		status: text().notNull(),
		expiresAt: time("expires_at").notNull(),
		value: text().notNull(),
		body: text(),
		callback: text(),
		consumed: boolean().notNull().default(false),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.flowId] }),
		foreignKey({
			columns: [t.namespace, t.testId],
			foreignColumns: [developerTests.namespace, developerTests.id],
		}).onDelete("cascade"),
		index("openbot_developer_test_flows_test").on(t.namespace, t.testId),
		index("openbot_developer_test_flows_open")
			.on(t.namespace, t.expiresAt)
			.where(sql`${t.body} IS NOT NULL OR ${t.callback} IS NOT NULL`),
	],
)
export const developerIndexRequests = table(
	"openbot_developer_index_requests",
	{
		namespace: namespace(),
		id: text().notNull(),
		owner: text().notNull(),
		cardUrl: text("card_url").notNull(),
		generation: text().notNull(),
		acceptedAt: time("accepted_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.id] }),
		uniqueIndex("openbot_developer_index_requests_generation").on(
			t.namespace,
			t.owner,
			t.cardUrl,
			t.generation,
		),
	],
)
export const developerSubscriptions = table(
	"openbot_developer_subscriptions",
	{
		namespace: namespace(),
		owner: text().notNull(),
		cardUrl: text("card_url").notNull(),
		enabled: boolean().notNull(),
	},
	(t) => [primaryKey({ columns: [t.namespace, t.owner, t.cardUrl] })],
)
export const developerNotices = table(
	"openbot_developer_notices",
	{
		namespace: namespace(),
		id: text().notNull(),
		owner: text().notNull(),
		cardUrl: text("card_url"),
		kind: text().notNull(),
		issue: text(),
		reason: text(),
		reportId: text("report_id"),
		createdAt: time("created_at").notNull(),
		readAt: time("read_at"),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.id] }),
		index("openbot_developer_notices_owner").on(
			t.namespace,
			t.owner,
			t.createdAt,
			t.id,
		),
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
/**
 * The Code Mode programs of each owner. The body is sealed. It holds the program,
 * its seed and clock, and the record of every App call, so a run can start again
 * and get the same results without sending a call twice.
 */
export const codeRuns = table(
	"openbot_code_runs",
	{
		owner: text().notNull(),
		id: text().notNull(),
		session: text().notNull(),
		callId: text("call_id").notNull(),
		status: text().notNull(),
		/** While a host runs the program, other hosts leave it alone until this time. */
		leaseUntil: time("lease_until"),
		body: text().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.owner, t.id] }),
		index("openbot_code_runs_session").on(t.owner, t.session),
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

/** One platform has many organizations. Their settings are in `openbot_settings`. */
export const organizations = table("openbot_organizations", {
	id: text().primaryKey(),
	name: text().notNull(),
	status: text().notNull(),
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
})

/**
 * The settings that every instance shares. One row for the platform
 * (`platform`, `platform`) and one row for each organization.
 * The document is JSON text. Secrets in it are sealed with the secret keys.
 */
export const settings = table(
	"openbot_settings",
	{
		scopeKind: text("scope_kind").notNull(),
		scopeId: text("scope_id").notNull(),
		document: text().notNull(),
		version: integer().notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.scopeKind, t.scopeId] })],
)

/** A platform admin is known by a verified email. The user ID is set at the first sign-in. */
export const platformAdmins = table("openbot_platform_admins", {
	email: text().primaryKey(),
	userId: text("user_id")
		.unique()
		.references(() => openbot_auth_user.id, { onDelete: "set null" }),
	addedAt: bigint("added_at", { mode: "number" }).notNull(),
})

/** Custom roles. Built-in roles live in the API contract. Policies are JSON text. */
export const roles = table(
	"openbot_roles",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		id: text().notNull(),
		name: text().notNull(),
		description: text().notNull(),
		policies: text().notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.organizationId, t.id] })],
)

/**
 * Model providers of the platform (`owner_kind` is `platform`) and of organizations.
 * The API key is sealed. Availability is JSON text. The models that a provider
 * offers are in `openbot_provider_models`.
 */
export const modelProviders = table(
	"openbot_model_providers",
	{
		id: text().primaryKey(),
		ownerKind: text("owner_kind").notNull(),
		ownerId: text("owner_id").notNull(),
		kind: text().notNull(),
		name: text().notNull(),
		endpoint: text(),
		apiKey: text("api_key").notNull(),
		apiKeyHint: text("api_key_hint"),
		availability: text(),
		version: integer().notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	},
	(t) => [index("openbot_model_providers_owner").on(t.ownerKind, t.ownerId)],
)

/**
 * Models of the platform (`owner_kind` is `platform`) and of organizations. A
 * model does not belong to a provider. The ID is unique for each owner.
 * Option lists and availability are JSON text.
 */
export const models = table(
	"openbot_models",
	{
		ownerKind: text("owner_kind").notNull(),
		ownerId: text("owner_id").notNull(),
		id: text().notNull(),
		/** `language` or `decision`. */
		type: text().notNull().default("language"),
		name: text().notNull(),
		reasoningEfforts: text("reasoning_efforts").notNull(),
		serviceTiers: text("service_tiers").notNull(),
		contextWindow: integer("context_window"),
		maxOutputTokens: integer("max_output_tokens"),
		availability: text(),
		version: integer().notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.ownerKind, t.ownerId, t.id] })],
)

/**
 * The models that a provider offers. A provider links at most one model with
 * each ID. A null column takes the value of the model. `upstream` is the
 * model name that the provider gets; null means the model ID.
 */
export const providerModels = table(
	"openbot_provider_models",
	{
		providerId: text("provider_id")
			.notNull()
			.references(() => modelProviders.id, { onDelete: "cascade" }),
		modelOwnerKind: text("model_owner_kind").notNull(),
		modelOwnerId: text("model_owner_id").notNull(),
		modelId: text("model_id").notNull(),
		position: integer().notNull(),
		upstream: text(),
		reasoningEfforts: text("reasoning_efforts"),
		serviceTiers: text("service_tiers"),
		contextWindow: integer("context_window"),
		maxOutputTokens: integer("max_output_tokens"),
	},
	(t) => [
		primaryKey({ columns: [t.providerId, t.modelId] }),
		foreignKey({
			columns: [t.modelOwnerKind, t.modelOwnerId, t.modelId],
			foreignColumns: [models.ownerKind, models.ownerId, models.id],
		}).onDelete("restrict"),
		index("openbot_provider_models_model").on(
			t.modelOwnerKind,
			t.modelOwnerId,
			t.modelId,
		),
	],
)

/** Email domains of organizations. Only one organization can verify a domain. */
export const organizationDomains = table(
	"openbot_organization_domains",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		domain: text().notNull(),
		token: text().notNull(),
		verifiedAt: bigint("verified_at", { mode: "number" }),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.organizationId, t.domain] }),
		uniqueIndex("openbot_organization_domains_verified")
			.on(t.domain)
			.where(sql`${t.verifiedAt} IS NOT NULL`),
	],
)

/** OpenID Connect providers of organizations. The client secret is sealed. Domains are JSON text. */
export const ssoConnections = table(
	"openbot_sso_connections",
	{
		id: text().primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		name: text().notNull(),
		issuer: text().notNull(),
		clientId: text("client_id").notNull(),
		clientSecret: text("client_secret"),
		clientSecretHint: text("client_secret_hint"),
		domains: text().notNull(),
		enforce: boolean().notNull(),
		version: integer().notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	},
	(t) => [index("openbot_sso_connections_organization").on(t.organizationId)],
)

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

/**
 * Invitations to join an organization. `email` is lower case. `roles` is JSON text.
 * A pending invitation that is past `expires_at` counts as expired.
 */
export const invitations = table(
	"openbot_invitations",
	{
		id: text().primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		email: text().notNull(),
		roles: text().notNull(),
		status: text().notNull(),
		invitedBy: text("invited_by").notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
	},
	(t) => [
		index("openbot_invitations_organization").on(t.organizationId),
		index("openbot_invitations_email").on(t.email),
	],
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
/**
 * A trigger starts a new Session for one Agent with one prompt, on a schedule or
 * from a webhook. `owner_user_id` is null for a shared trigger.
 */
export const triggers = table(
	"openbot_triggers",
	{
		organizationId: text("organization_id").notNull(),
		id: text().notNull(),
		ownerUserId: text("owner_user_id"),
		agent: text().notNull(),
		prompt: text().notNull(),
		scheduleCron: text("schedule_cron"),
		scheduleTimeZone: text("schedule_time_zone"),
		nextRunAt: time("next_run_at"),
		lastFiredAt: time("last_fired_at"),
		hookSecretHash: text("hook_secret_hash"),
		actor: text().notNull(),
		enabled: boolean().notNull(),
		revision: integer().notNull(),
		createdAt: time("created_at").notNull(),
		updatedAt: time("updated_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.organizationId, t.id] }),
		// A webhook names only the trigger, so its ID must find it.
		uniqueIndex("openbot_triggers_id").on(t.id),
		index("openbot_triggers_owner").on(t.organizationId, t.ownerUserId),
		index("openbot_triggers_due")
			.on(t.nextRunAt)
			.where(sql`${t.nextRunAt} IS NOT NULL AND ${t.enabled}`),
	],
)

/**
 * A bot of an organization on one platform, such as a Slack app.
 * `credentials` is the sealed JSON of its secrets. `hints` shows their last characters.
 */
export const channels = table(
	"openbot_channels",
	{
		organizationId: text("organization_id").notNull(),
		id: text().notNull(),
		kind: text().notNull(),
		name: text().notNull(),
		agent: text().notNull(),
		actor: text().notNull(),
		enabled: boolean().notNull(),
		linkPath: text("link_path"),
		credentials: text().notNull(),
		hints: text().notNull(),
		version: integer().notNull(),
		createdAt: time("created_at").notNull(),
		updatedAt: time("updated_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.organizationId, t.id] }),
		// A webhook names only the Channel, so its ID must find it.
		uniqueIndex("openbot_channels_id").on(t.id),
	],
)

/** A person on the platform of a Channel, linked to a member of the organization. */
export const channelIdentities = table(
	"openbot_channel_identities",
	{
		organizationId: text("organization_id").notNull(),
		channelId: text("channel_id").notNull(),
		externalUserId: text("external_user_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => openbot_auth_user.id, { onDelete: "cascade" }),
		displayName: text("display_name").notNull(),
		createdAt: time("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.channelId, t.externalUserId] }),
		foreignKey({
			columns: [t.organizationId, t.channelId],
			foreignColumns: [channels.organizationId, channels.id],
		}).onDelete("cascade"),
		index("openbot_channel_identities_user").on(t.organizationId, t.userId),
	],
)

/** A link code that a bot gave to a person. Only its hash is stored. */
export const channelLinks = table(
	"openbot_channel_links",
	{
		codeHash: text("code_hash").primaryKey(),
		organizationId: text("organization_id").notNull(),
		channelId: text("channel_id").notNull(),
		externalUserId: text("external_user_id").notNull(),
		displayName: text("display_name").notNull(),
		expiresAt: time("expires_at").notNull(),
		usedAt: time("used_at"),
	},
	(t) => [
		foreignKey({
			columns: [t.organizationId, t.channelId],
			foreignColumns: [channels.organizationId, channels.id],
		}).onDelete("cascade"),
	],
)

/**
 * Each chat of a Channel is one long-lived Session. `owner` is the actor of the Channel when
 * the chat began. The Session stays with that member when the actor changes.
 */
export const channelConversations = table(
	"openbot_channel_conversations",
	{
		organizationId: text("organization_id").notNull(),
		channelId: text("channel_id").notNull(),
		conversationKey: text("conversation_key").notNull(),
		kind: text().notNull(),
		title: text(),
		session: text().notNull(),
		owner: text().notNull(),
		createdAt: time("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.channelId, t.conversationKey] }),
		foreignKey({
			columns: [t.organizationId, t.channelId],
			foreignColumns: [channels.organizationId, channels.id],
		}).onDelete("cascade"),
		uniqueIndex("openbot_channel_conversations_session").on(t.session),
	],
)

/**
 * Events from platforms that wait to be handled. The key drops an event that the platform
 * sends again. A worker takes the oldest open event of each chat, so a chat keeps its order.
 */
export const channelInbox = table(
	"openbot_channel_inbox",
	{
		organizationId: text("organization_id").notNull(),
		channelId: text("channel_id").notNull(),
		eventId: text("event_id").notNull(),
		conversationKey: text("conversation_key").notNull(),
		event: text().notNull(),
		receivedAt: time("received_at").notNull(),
		attempts: integer().notNull().default(0),
		nextAt: time("next_at").notNull(),
		claim: text(),
		leaseUntil: time("lease_until").notNull().default(0),
		doneAt: time("done_at"),
	},
	(t) => [
		primaryKey({ columns: [t.channelId, t.eventId] }),
		foreignKey({
			columns: [t.organizationId, t.channelId],
			foreignColumns: [channels.organizationId, channels.id],
		}).onDelete("cascade"),
		index("openbot_channel_inbox_open")
			.on(t.channelId, t.conversationKey, t.receivedAt)
			.where(sql`${t.doneAt} IS NULL`),
	],
)

/**
 * Messages that the bot must send or change: the answers of Turns and the cards of requests.
 * `ref` is the message on the platform after the first send.
 */
export const channelDeliveries = table(
	"openbot_channel_deliveries",
	{
		id: text().primaryKey(),
		organizationId: text("organization_id").notNull(),
		channelId: text("channel_id").notNull(),
		/** `reply` for the answer of a Turn, `request` for a request card, `notice` otherwise. */
		kind: text().notNull(),
		target: text().notNull(),
		session: text(),
		turn: text(),
		request: text(),
		body: text().notNull(),
		ref: text(),
		/** `live` while a Turn still writes, `pending` while it waits to go out, then `done`. */
		state: text().notNull(),
		attempts: integer().notNull().default(0),
		nextAt: time("next_at").notNull(),
		claim: text(),
		leaseUntil: time("lease_until").notNull().default(0),
		updatedAt: time("updated_at").notNull(),
	},
	(t) => [
		foreignKey({
			columns: [t.organizationId, t.channelId],
			foreignColumns: [channels.organizationId, channels.id],
		}).onDelete("cascade"),
		uniqueIndex("openbot_channel_deliveries_turn").on(t.session, t.turn),
		uniqueIndex("openbot_channel_deliveries_request").on(
			t.channelId,
			t.request,
		),
		index("openbot_channel_deliveries_due")
			.on(t.nextAt)
			.where(sql`${t.state} = 'pending'`),
	],
)

/**
 * One row for each model call that reached a provider. Rows are only added.
 * Token counts and the cost are copied at the time of the call, so a later
 * price change does not change old rows. Money is in micro-USD (one millionth of a US dollar).
 */
export const usageEvents = table(
	"openbot_usage_events",
	{
		id: text().primaryKey(),
		organizationId: text("organization_id").notNull(),
		occurredAt: time("occurred_at").notNull(),
		/** `turn`, `compaction`, `session_memory`, `judge`, `agent_memory` or `other`. */
		source: text().notNull(),
		sessionId: text("session_id"),
		turnId: text("turn_id"),
		agentId: text("agent_id"),
		userId: text("user_id"),
		tokenId: text("token_id"),
		providerId: text("provider_id").notNull(),
		/** `platform` or `organization`. The owner of the API key that paid for the call. */
		providerOwner: text("provider_owner").notNull(),
		modelId: text("model_id").notNull(),
		inputUncached: bigint("input_uncached", { mode: "number" }).notNull(),
		inputCacheRead: bigint("input_cache_read", { mode: "number" }).notNull(),
		inputCacheWrite: bigint("input_cache_write", { mode: "number" }).notNull(),
		outputText: bigint("output_text", { mode: "number" }).notNull(),
		outputReasoning: bigint("output_reasoning", { mode: "number" }).notNull(),
		/** Null when the model had no price. Then the cost is 0. */
		priceId: text("price_id"),
		costMicros: bigint("cost_micros", { mode: "number" }).notNull(),
		/** True when the cost was taken from the credits of the organization. */
		charged: boolean().notNull(),
	},
	(t) => [
		index("openbot_usage_events_time").on(t.organizationId, t.occurredAt),
		index("openbot_usage_events_user").on(
			t.organizationId,
			t.userId,
			t.occurredAt,
		),
		index("openbot_usage_events_agent").on(
			t.organizationId,
			t.agentId,
			t.occurredAt,
		),
		index("openbot_usage_events_token").on(
			t.organizationId,
			t.tokenId,
			t.occurredAt,
		),
	],
)

/**
 * Prices of a model at one provider, in micro-USD for one million tokens.
 * A price can have tiers by input size and periods by time of day.
 * A new price is a new row. The row with the latest `effective_from` that is
 * not in the future is the current price.
 */
export const modelPrices = table(
	"openbot_model_prices",
	{
		id: text().primaryKey(),
		providerId: text("provider_id")
			.notNull()
			.references(() => modelProviders.id, { onDelete: "cascade" }),
		modelId: text("model_id").notNull(),
		effectiveFrom: time("effective_from").notNull(),
		/** The time zone, tiers and periods of the price, as JSON text. */
		schedule: text().notNull(),
		createdBy: text("created_by").notNull(),
		createdAt: time("created_at").notNull(),
	},
	(t) => [
		index("openbot_model_prices_current").on(
			t.providerId,
			t.modelId,
			t.effectiveFrom,
		),
	],
)

/** Spending limits of an organization, a member, an Agent or a user token. */
export const budgets = table(
	"openbot_budgets",
	{
		id: text().primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		/** `organization`, `member`, `agent` or `token`. */
		scopeKind: text("scope_kind").notNull(),
		/** The organization ID, user ID, Agent ID or token ID. */
		scopeId: text("scope_id").notNull(),
		/** `day` or `month`, in UTC. */
		period: text().notNull(),
		limitMicros: bigint("limit_micros", { mode: "number" }).notNull(),
		/** `hard` stops model calls. `soft` only marks the budget as exceeded. */
		mode: text().notNull(),
		version: integer().notNull(),
		createdAt: time("created_at").notNull(),
		updatedAt: time("updated_at").notNull(),
	},
	(t) => [
		uniqueIndex("openbot_budgets_scope").on(
			t.organizationId,
			t.scopeKind,
			t.scopeId,
			t.period,
		),
	],
)

/** The credits of an organization. Only a platform admin turns them on. */
export const organizationCredits = table("openbot_organization_credits", {
	organizationId: text("organization_id")
		.primaryKey()
		.references(() => organizations.id, { onDelete: "cascade" }),
	enabled: boolean().notNull(),
	balanceMicros: bigint("balance_micros", { mode: "number" }).notNull(),
	updatedAt: time("updated_at").notNull(),
})

/** Credits that a platform admin gave or took back. Rows are only added. */
export const creditGrants = table(
	"openbot_credit_grants",
	{
		id: text().primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
		note: text().notNull(),
		createdBy: text("created_by").notNull(),
		createdAt: time("created_at").notNull(),
	},
	(t) => [
		index("openbot_credit_grants_list").on(t.organizationId, t.createdAt),
	],
)

/** Request counts for the API rate limit, one row for each caller and minute. */
export const rateWindows = table(
	"openbot_rate_windows",
	{
		key: text().notNull(),
		windowStart: time("window_start").notNull(),
		count: integer().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.key, t.windowStart] }),
		index("openbot_rate_windows_start").on(t.windowStart),
	],
)
