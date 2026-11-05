import {
	bigint,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
} from "drizzle-orm/pg-core"

/** Published work is kept apart from the model prompt. */
export const artifacts = pgTable(
	"openbot_artifacts",
	{
		id: text().primaryKey(),
		namespace: text().notNull(),
		chat: text().notNull(),
		title: text().notNull(),
		latestVersion: integer("latest_version").notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	},
	(t) => [index("openbot_artifacts_chat").on(t.namespace, t.chat, t.id)],
)

/** Each version has its own fixed file and source links. */
export const artifactVersions = pgTable(
	"openbot_artifact_versions",
	{
		artifact: text().notNull(),
		version: integer().notNull(),
		namespace: text().notNull(),
		chat: text().notNull(),
		turn: text(),
		item: text(),
		file: text().notNull(),
		body: text().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.artifact, t.version] }),
		index("openbot_artifact_versions_item").on(t.namespace, t.chat, t.item),
	],
)

export const artifactSources = pgTable(
	"openbot_artifact_sources",
	{
		id: text().primaryKey(),
		namespace: text().notNull(),
		chat: text().notNull(),
		file: text().notNull(),
		body: text().notNull(),
	},
	(t) => [index("openbot_artifact_sources_chat").on(t.namespace, t.chat, t.id)],
)

/** Pending bytes stay fixed before a write to object storage. */
export const artifactJobs = pgTable(
	"openbot_artifact_jobs",
	{
		executionId: text("execution_id").primaryKey(),
		namespace: text().notNull(),
		chat: text().notNull(),
		file: text().notNull(),
		resourceId: text("resource_id").notNull(),
		snapshot: text(),
		metadata: text(),
		sha256: text(),
		result: text(),
	},
	(t) => [index("openbot_artifact_jobs_file").on(t.file)],
)

/** Generated files can only be read through their Chat. */
export const artifactFiles = pgTable("openbot_artifact_files", {
	file: text().primaryKey(),
	namespace: text().notNull(),
	chat: text().notNull(),
	executionId: text("execution_id").notNull(),
})

export const artifactCitations = pgTable(
	"openbot_artifact_citations",
	{
		namespace: text().notNull(),
		chat: text().notNull(),
		item: text().notNull(),
		citations: text().notNull(),
	},
	(t) => [primaryKey({ columns: [t.namespace, t.chat, t.item] })],
)

export const artifactCitationIntents = pgTable(
	"openbot_artifact_citation_intents",
	{
		namespace: text().notNull(),
		chat: text().notNull(),
		turn: text().notNull(),
		callId: text("call_id").notNull(),
		afterStep: integer("after_step").notNull(),
		citations: text().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.callId] }),
		index("openbot_artifact_citation_intents_turn").on(
			t.namespace,
			t.chat,
			t.turn,
		),
	],
)
