import { bigint, boolean, pgTable, primaryKey, text } from "drizzle-orm/pg-core"

/** A data version is ready only after every required check has passed. */
export const dataUpgrades = pgTable("openbot_data_upgrades", {
	version: text().primaryKey(),
	source: text().notNull(),
	state: text().notNull(),
	/** Counts contain table names and numbers only. */
	counts: text().notNull(),
	startedAt: bigint("started_at", { mode: "number" }).notNull(),
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	checkedAt: bigint("checked_at", { mode: "number" }),
})

/** Each batch changes its rows and cursor in the same transaction. */
export const dataUpgradeSteps = pgTable(
	"openbot_data_upgrade_steps",
	{
		version: text()
			.notNull()
			.references(() => dataUpgrades.version),
		step: text().notNull(),
		cursor: text(),
		rows: bigint({ mode: "number" }).notNull().default(0),
		complete: boolean().notNull().default(false),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.version, t.step] })],
)

/** A row keeps its source key and blocked authority until it has a full new form. */
export const dataUpgradeRecords = pgTable(
	"openbot_data_upgrade_records",
	{
		version: text()
			.notNull()
			.references(() => dataUpgrades.version),
		collection: text().notNull(),
		key: text().notNull(),
		state: text().notNull(),
		/** A sealed record. It can hold identity evidence, never an assumed caller. */
		body: text().notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.version, t.collection, t.key] })],
)

/** A bad record stops the move. Its full cause stays sealed. */
export const dataUpgradeFailures = pgTable("openbot_data_upgrade_failures", {
	id: text().primaryKey(),
	version: text()
		.notNull()
		.references(() => dataUpgrades.version),
	step: text().notNull(),
	cause: text().notNull(),
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
})
