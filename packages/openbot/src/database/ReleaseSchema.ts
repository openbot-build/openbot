import { boolean, pgTable, text } from "drizzle-orm/pg-core"

/** An absent row means that release admission is open. */
export const releaseAdmission = pgTable("openbot_release_admission", {
	id: text().primaryKey(),
	quiesced: boolean().notNull(),
})
