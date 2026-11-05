import { ChatStore } from "@openbot-build/core"
import { Effect } from "effect"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import * as Shared from "@openbot-build/server-kernel/database/DatabaseError"
import * as Db from "@openbot-build/server-database/Database"
import * as Progress from "@openbot-build/server-kernel/imported/Progress"
import * as Convert from "./Convert.ts"
import * as GrantUses from "./GrantUses.ts"
import { migrationsFolder as folder } from "@openbot-build/server-database/MigrationsFolder"
import { check } from "@openbot-build/server-kernel/database/Check"
export {
	check,
	checkStartup,
} from "@openbot-build/server-kernel/database/Check"

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
