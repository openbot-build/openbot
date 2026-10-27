import { doublePrecision, pgTable, primaryKey, text } from "drizzle-orm/pg-core"

/** All server processes take from the same model token buckets. */
export const tokenBuckets = pgTable(
	"openbot_token_buckets",
	{
		organizationId: text("organization_id").notNull(),
		kind: text().notNull(),
		subjectId: text("subject_id").notNull(),
		level: doublePrecision().notNull(),
		updatedAt: doublePrecision("updated_at").notNull(),
		tokensPerSecond: doublePrecision("tokens_per_second").notNull(),
		burstTokens: doublePrecision("burst_tokens").notNull(),
	},
	(t) => [primaryKey({ columns: [t.organizationId, t.kind, t.subjectId] })],
)
