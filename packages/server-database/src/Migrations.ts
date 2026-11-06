import { PgClient } from "@effect/sql-pg"
import { migrate as runMigrations } from "drizzle-orm/effect-postgres/migrator"
import { readMigrationFiles } from "drizzle-orm/migrator"
import {
	Array as Arr,
	Cause,
	Effect,
	Option,
	Predicate,
	Record as Rec,
	Schema,
} from "effect"
import * as Db from "./Database.ts"
import { migrationsFolder } from "./MigrationsFolder.ts"
import * as Tables from "./Tables.ts"

/** A migration of the folder failed. The database keeps its old schema. */
export class MigrationFailed extends Schema.TaggedError<
	MigrationFailed,
	{ readonly brand: unique symbol }
>()("MigrationFailed", { message: Schema.String, cause: Schema.Defect() }) {}

/**
 * The database did not get the newest migration of the folder, or it does not
 * have a table or a column of the schema.
 */
export class SchemaMismatch extends Schema.TaggedError<
	SchemaMismatch,
	{ readonly brand: unique symbol }
>()("SchemaMismatch", { message: Schema.String, cause: Schema.Defect() }) {}

/** The words of the database: the message at the end of the chain of causes. */
const reason = (error: unknown): string =>
	Cause.isCause(error)
		? reason(Cause.squash(error))
		: Predicate.hasProperty(error, "cause") && error.cause !== undefined
			? reason(error.cause)
			: Predicate.hasProperty(error, "message") &&
				  Predicate.isString(error.message)
				? error.message
				: String(error)

const mismatch = (cause: unknown) =>
	SchemaMismatch.make({
		message:
			"The database does not match the schema of this version. Run `openbot migrate` first.",
		cause,
	})

/**
 * The name of the newest migration of the folder. The Drizzle migrator reads
 * the folder in the same way, so this is the last migration that it applies.
 */
const newestMigration = Effect.try({
	try: () => Arr.last(readMigrationFiles({ migrationsFolder })),
	catch: mismatch,
}).pipe(
	Effect.flatMap(
		Option.match({
			onNone: () => Effect.fail(mismatch("The migrations folder is empty.")),
			onSome: (migration) => Effect.succeed(migration.name),
		}),
	),
)

/**
 * Checks that the journal of the Drizzle migrator has the newest migration of
 * the folder. A database of an older version can have every table and column
 * of this version, but it did not get the migrations that check its data.
 * Then it selects no rows from every table of the schema, so a database that
 * misses a table or a column fails.
 */
export const check: Effect.Effect<void, SchemaMismatch, PgClient.PgClient> =
	Effect.gen(function* () {
		const newest = yield* newestMigration
		const db = yield* Db.make
		const pg = yield* PgClient.PgClient
		const applied = yield* pg<{
			readonly name: string
		}>`select name from drizzle.__drizzle_migrations where name = ${newest}`.pipe(
			Effect.mapError(mismatch),
		)
		if (applied.length === 0) {
			return yield* mismatch(`The migration ${newest} is not in the journal.`)
		}
		yield* Effect.forEach(
			Rec.values(Tables),
			(table) =>
				db.select().from(table).limit(0).pipe(Effect.mapError(mismatch)),
			{ discard: true },
		)
	})

/**
 * Applies every migration of the folder with the Drizzle migrator, which keeps
 * a journal, and then checks the schema. All servers must be stopped.
 */
export const migrate: Effect.Effect<
	void,
	MigrationFailed | SchemaMismatch,
	PgClient.PgClient
> = Effect.gen(function* () {
	const db = yield* Db.make
	yield* runMigrations(db, { migrationsFolder }).pipe(
		// Keep the words of the database, so a failed migration says what broke.
		// Drizzle keeps the error of the database, with its code, in the cause.
		Effect.mapError((cause) =>
			MigrationFailed.make({
				message: "A database migration failed: " + reason(cause),
				cause,
			}),
		),
	)
	yield* check
})
