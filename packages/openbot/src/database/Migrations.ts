import { ChatStore } from "@openbot-build/core"
import { Effect, Record as Rec } from "effect"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { fileURLToPath } from "node:url"
import * as Shared from "../chats/ChatEncoding.ts"
import * as Tables from "./Schema.ts"
import {
	openbot_auth_user,
	openbot_auth_session,
	openbot_auth_account,
	openbot_auth_verification,
} from "./AuthSchema.ts"
import * as Db from "./Database.ts"
import * as Progress from "./conversion/Progress.ts"
import * as Convert from "./conversion/Convert.ts"

const folder = fileURLToPath(new URL("../../migrations", import.meta.url))

/**
 * Selects no rows from every table of the schema, so a database that misses a
 * table or a column fails at start.
 */
export const check = Effect.gen(function* () {
	const db = yield* Db.make
	yield* Effect.forEach(
		Rec.values(Tables),
		(table) => db.select().from(table).limit(0),
		{ discard: true },
	)
	yield* db
		.select({ id: openbot_auth_user.id })
		.from(openbot_auth_user)
		.limit(0)
	yield* db
		.select({ id: openbot_auth_session.id })
		.from(openbot_auth_session)
		.limit(0)
	yield* db
		.select({ id: openbot_auth_account.id })
		.from(openbot_auth_account)
		.limit(0)
	yield* db
		.select({ id: openbot_auth_verification.id })
		.from(openbot_auth_verification)
		.limit(0)
}).pipe(Effect.mapError(Shared.databaseError))

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
	schema.pipe(Effect.andThen(Progress.establish), Effect.asVoid),
)

/** The maintenance program resumes the data move, then requires the complete version. */
export const upgrade = Progress.withMaintenance(
	schema.pipe(Effect.andThen(Convert.run)),
)

/** This scope must outlive the application services. It performs no DDL. */
export const checkStartup = check.pipe(Effect.andThen(Progress.checkStartup))
