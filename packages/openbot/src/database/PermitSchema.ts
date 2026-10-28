import {
	bigint,
	foreignKey,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	uuid,
} from "drizzle-orm/pg-core"
import { executions } from "./ExecutionSchema.ts"

/** A bounded work scope holds its place until release or its saved deadline. */
export const executionPermits = pgTable(
	"openbot_execution_permits",
	{
		namespace: text().notNull(),
		executionId: text("execution_id").notNull(),
		generation: integer().notNull(),
		id: uuid().notNull(),
		pool: text().notNull(),
		deadline: bigint({ mode: "number" }).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.executionId, t.id] }),
		foreignKey({
			columns: [t.namespace, t.executionId],
			foreignColumns: [executions.namespace, executions.id],
		}),
		index("openbot_execution_permits_pool").on(t.pool, t.deadline),
	],
)
