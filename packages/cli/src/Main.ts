#!/usr/bin/env node
import { spawn } from "node:child_process"
import * as Dispatch from "./Dispatch.ts"

const folders = Dispatch.searchFolders({
	script: process.argv[1] ?? import.meta.filename,
	path: process.env["PATH"],
})
const [first, ...rest] = process.argv.slice(2)

const run = (file: string, args: ReadonlyArray<string>): void => {
	const child = spawn(file, args, { stdio: "inherit" })
	// The terminal sends Ctrl-C to the command too, so openbot waits for the command to stop.
	process.on("SIGINT", () => {})
	for (const signal of ["SIGTERM", "SIGHUP"] as const)
		process.on(signal, () => child.kill(signal))
	child.on("error", (error) => {
		process.stderr.write(`openbot: could not run ${file}: ${error.message}\n`)
		process.exit(1)
	})
	child.on("exit", (code, signal) => {
		if (signal === null) process.exit(code ?? 1)
		// Stop with the same signal as the command, so the caller sees the same result.
		process.removeAllListeners(signal)
		process.kill(process.pid, signal)
	})
}

if (first === undefined || first === "--help" || first === "-h") {
	process.stdout.write(Dispatch.usage(Dispatch.list(folders)))
} else if (first === "help") {
	const name = rest[0]
	const file = name === undefined ? undefined : Dispatch.find(name, folders)
	if (name === undefined)
		process.stdout.write(Dispatch.usage(Dispatch.list(folders)))
	else if (file === undefined) {
		process.stderr.write(Dispatch.unknown(name))
		process.exitCode = 1
	} else run(file, ["--help"])
} else {
	const file = Dispatch.find(first, folders)
	if (file === undefined) {
		process.stderr.write(Dispatch.unknown(first))
		process.exitCode = 1
	} else run(file, rest)
}
