/**
 * Helpers for tests that need a database: a throwaway PostgreSQL server, and
 * folders with some of the migrations. Only tests use this module. Importing it
 * starts nothing; each helper is an Effect that a test runs.
 */
import { NodeSocketServer } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Path,
	Predicate,
	Redacted,
	Schema,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Migrations from "./Migrations.ts"
import { migrationsFolder } from "./MigrationsFolder.ts"

/** A throwaway PostgreSQL server for a test. */
export interface Database {
	/** The connection URL, such as postgres://openbot_test@127.0.0.1:5432/postgres. */
	readonly url: string
}

/** A PostgreSQL program of the test ended with an error. */
export class CommandFailed extends Schema.TaggedError<
	CommandFailed,
	{ readonly brand: unique symbol }
>()("CommandFailed", {
	command: Schema.String,
	exitCode: Schema.Int,
}) {}

/** Gets a free TCP port on 127.0.0.1. The probe server closes at once. */
export const freePort = Effect.scoped(
	Effect.flatMap(
		NodeSocketServer.make({ host: "127.0.0.1", port: 0 }),
		(server) =>
			server.address._tag === "UnixPathAddress"
				? Effect.die(new Error("The port probe has no TCP address"))
				: Effect.succeed(server.address.port),
	),
)

/**
 * Runs a program with no output, and fails when it ends with an error. The
 * program stays in the process group of the test, because pg_ctl leaves the
 * server running after it ends, and a stop of its own group must not touch
 * the server.
 */
const run = Effect.fn("Testing.run")(function* (
	command: string,
	args: ReadonlyArray<string>,
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const exitCode = yield* spawner.exitCode(
		ChildProcess.make(command, args, {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: false,
		}),
	)
	if (exitCode !== 0) return yield* CommandFailed.make({ command, exitCode })
})

/**
 * Starts a real, throwaway PostgreSQL server. It stops, and its files go away,
 * when the scope closes. All programs come from devenv. Give it
 * `NodeServices.layer`.
 */
export const start = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* fs.makeTempDirectoryScoped({
		prefix: "openbot-postgres-",
	})
	const data = path.join(directory, "data")
	yield* run("initdb", [
		"-D",
		data,
		"-A",
		"trust",
		"-U",
		"openbot_test",
		"--no-locale",
		"-E",
		"UTF8",
	])
	// The probe lets its port go before PostgreSQL takes it, and another test can
	// take the port in that time. Then the start fails, so it tries again with a
	// new port.
	const port = yield* Effect.acquireRelease(
		freePort.pipe(
			Effect.tap((port) =>
				run("pg_ctl", [
					"-D",
					data,
					"-l",
					path.join(directory, "postgres.log"),
					"-o",
					`-h 127.0.0.1 -p ${port} -k ${directory}`,
					"-w",
					"start",
				]),
			),
			Effect.retry({ times: 4, while: Predicate.isTagged("CommandFailed") }),
		),
		() =>
			run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]).pipe(
				Effect.orDie,
			),
	)
	const database: Database = {
		url: `postgres://openbot_test@127.0.0.1:${port}/postgres`,
	}
	return database
})

/**
 * Starts a throwaway PostgreSQL server, as `start` does, and makes the tables
 * of OpenBot in it. The migration has its own database pool, which closes
 * after it. Give it `NodeServices.layer`.
 */
export const migrated = Effect.tap(start, (database) =>
	Migrations.migrate.pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off -- The migration has its own pool, which must close before a server opens its pool.
		Effect.provide(PgClient.layer({ url: Redacted.make(database.url) })),
	),
)

/** The folder with every migration of OpenBot. It comes from the database package. */
export const folder = Effect.succeed(migrationsFolder)

/** Copies the migrations with the names that `keep` takes into a new folder. The folder goes away at the end of the test. */
export const migrationsWhere = Effect.fn("Testing.migrationsWhere")(function* (
	keep: Predicate.Predicate<string>,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const migrations = yield* folder
	const copy = yield* fs.makeTempDirectoryScoped({
		prefix: "openbot-migrations-",
	})
	const names = yield* fs.readDirectory(migrations)
	yield* Effect.forEach(
		Arr.filter(names, keep),
		(name) => fs.copy(path.join(migrations, name), path.join(copy, name)),
		{ discard: true },
	)
	return copy
})

/**
 * The first migration of the version that needs a new database. It stops on
 * data of older versions, so tests that keep such data stop before it.
 */
export const removeOldData = "20261105183225_remove_old_data"

/** A folder with every migration before `removeOldData`. */
export const olderVersions = Effect.suspend(() =>
	migrationsWhere((name) => name < removeOldData),
)
