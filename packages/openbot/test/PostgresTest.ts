import { NodeSocketServer } from "@effect/platform-node"
import { Effect, FileSystem, Path, Predicate, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

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
const run = Effect.fn("PostgresTest.run")(function* (
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
