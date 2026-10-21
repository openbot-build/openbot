import { Predicate } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** A real, throwaway PostgreSQL instance. All executables come from devenv. */
export const start = async () => {
	const directory = await mkdtemp(join(tmpdir(), "openbot-postgres-"))
	const probe = createServer()
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject)
		probe.listen(0, "127.0.0.1", resolve)
	})
	const address = probe.address()
	if (!Predicate.isObject(address))
		throw new Error("Could not get a port for test PostgreSQL")
	const port = address.port
	await new Promise<void>((resolve, reject) =>
		probe.close((error) => (error === undefined ? resolve() : reject(error))),
	)
	const data = join(directory, "data")
	try {
		execFileSync(
			"initdb",
			[
				"-D",
				data,
				"-A",
				"trust",
				"-U",
				"openbot_test",
				"--no-locale",
				"-E",
				"UTF8",
			],
			{ stdio: "ignore" },
		)
		execFileSync(
			"pg_ctl",
			[
				"-D",
				data,
				"-l",
				join(directory, "postgres.log"),
				"-o",
				`-h 127.0.0.1 -p ${port} -k ${directory}`,
				"-w",
				"start",
			],
			{ stdio: "ignore" },
		)
	} catch (error) {
		await rm(directory, { recursive: true, force: true })
		throw error
	}
	return {
		url: `postgres://openbot_test@127.0.0.1:${port}/postgres`,
		close: async () => {
			try {
				execFileSync("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], {
					stdio: "ignore",
				})
			} finally {
				await rm(directory, { recursive: true, force: true })
			}
		},
	}
}
