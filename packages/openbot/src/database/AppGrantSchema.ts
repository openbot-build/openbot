import { index, pgTable, primaryKey, text } from "drizzle-orm/pg-core"

/** A saved use or send keeps its grant family out of cleanup. */
export const appGrantUses = pgTable(
	"openbot_app_grant_uses",
	{
		namespace: text().notNull(),
		kind: text().notNull(),
		reference: text().notNull(),
		scopeKey: text("scope_key").notNull(),
		executionId: text("execution_id"),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.kind, t.reference] }),
		index("openbot_app_grant_uses_scope").on(t.scopeKey, t.kind),
	],
)
