import { Effect, Record as Rec } from "effect"
import * as Shared from "./DatabaseError.ts"
import * as Tables from "../../server-database/Schema.ts"
import {
	openbot_auth_user,
	openbot_auth_session,
	openbot_auth_account,
	openbot_auth_verification,
} from "../../server-database/AuthSchema.ts"
import * as Db from "../../server-database/Database.ts"
import * as Progress from "../imported/Progress.ts"
import * as GrantUses from "../imported/GrantUses.ts"

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

/** This scope must outlive the application services. It performs no DDL. */
export const checkStartup = check.pipe(
	Effect.andThen(Progress.checkStartup),
	Effect.andThen(GrantUses.checkReady),
)
