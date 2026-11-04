import { ChatStore } from "@openbot-build/core"
import { Effect } from "effect"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import * as Shared from "../server-kernel/database/DatabaseError.ts"
import * as Db from "../server-database/Database.ts"
import * as Progress from "../server-kernel/imported/Progress.ts"
import * as Convert from "./Convert.ts"
import * as GrantUses from "./GrantUses.ts"
import { migrationsFolder as folder } from "../server-database/MigrationsFolder.ts"
import { check } from "../server-kernel/database/Check.ts"
export { check, checkStartup } from "../server-kernel/database/Check.ts"

/** Apply the current schema with the standard Drizzle migrator, which keeps a journal. */
const schema = Effect.gen(function* () {
	const db = yield* Db.make
	yield* migrate(db, { migrationsFolder: folder }).pipe(
		// Keep the words of the database, so a broken migration says what broke.
		Effect.mapError((error) =>
			ChatStore.ChatStoreError.make({
				reason: "storage-failed",
				message: "A database migration failed: " + String(error),
				// Drizzle keeps the error of the database, with its code, in the cause.
				cause: error,
			}),
		),
	)
	yield* check
}).pipe(Effect.mapError(Shared.databaseError))

/** Schema changes and the first inventory run with all servers stopped. */
export const initialize = Progress.withMaintenance(
	schema.pipe(
		Effect.andThen(Progress.establish),
		Effect.andThen(GrantUses.establish),
	),
)

/** The maintenance program resumes the data move, then requires the complete version. */
export const upgrade = Progress.withMaintenance(
	schema.pipe(
		// A completed data move must not check new rows against its old counts.
		Effect.andThen(
			Progress.checkReady.pipe(
				Effect.catchTag("DataUpgradeRequired", () => Convert.run),
			),
		),
		Effect.andThen(GrantUses.run),
	),
)
