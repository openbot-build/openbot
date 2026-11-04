import {
	pgTable,
	text,
	uuid,
	integer,
	primaryKey,
	index,
} from "drizzle-orm/pg-core"

/** Only resource addresses live here. Calls and results use the execution store. */
export const resourceOwners = pgTable(
	"openbot_resource_owners",
	{
		namespace: text().notNull(),
		kind: text().notNull(),
		id: text().notNull(),
		lease: uuid().notNull(),
		node: uuid().notNull(),
		host: text().notNull(),
		port: integer().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.namespace, t.kind, t.id] }),
		index("openbot_resource_owners_node").on(t.node),
	],
)

/** Keep each physical lease until its close result is known. A route may be replaced first. */
export const resourceLeases = pgTable(
	"openbot_resource_leases",
	{
		lease: uuid().primaryKey(),
		namespace: text().notNull(),
		kind: text().notNull(),
		id: text().notNull(),
		node: uuid().notNull(),
		host: text().notNull(),
		port: integer().notNull(),
		// Only safe close results go here. Full failure causes stay in the error store.
		result: text(),
	},
	(t) => [
		index("openbot_resource_leases_resource").on(t.namespace, t.kind, t.id),
	],
)
