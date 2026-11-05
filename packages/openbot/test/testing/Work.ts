import { eq } from "drizzle-orm"
import { Effect } from "effect"
import * as Db from "@openbot-build/server-database/Database"
import { botRecords } from "@openbot-build/server-database/Schema"
import type * as BrowserHost from "../BrowserHost.ts"

/** Reads saved reminder bodies so a test can check that their notes are sealed. */
export const savedReminders = (host: BrowserHost.Host) =>
	host.run(
		Effect.gen(function* () {
			const db = yield* Db.make
			return yield* db
				.select({ body: botRecords.body })
				.from(botRecords)
				.where(eq(botRecords.kind, "reminder"))
		}),
	)
