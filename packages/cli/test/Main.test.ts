import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { after, test } from "node:test"
import * as Dispatch from "../src/Dispatch.ts"

const main = join(import.meta.dirname, "..", "dist", "Main.js")
const folder = mkdtempSync(join(tmpdir(), "openbot-cli-"))
after(() => rmSync(folder, { recursive: true, force: true }))

const script = (name: string, body: string) => {
	const file = join(folder, name)
	writeFileSync(file, `#!/bin/sh\n${body}\n`)
	chmodSync(file, 0o755)
}
script(
	"openbot-echo",
	'for arg in "$@"; do echo "[$arg]"; done\nexit "${ECHO_EXIT:-0}"',
)
script("openbot-stop", "kill -TERM $$")
// A file without the right to run is not a command.
writeFileSync(join(folder, "openbot-plain"), "#!/bin/sh\n")

const openbot = (
	args: ReadonlyArray<string>,
	env: Record<string, string> = {},
) =>
	spawnSync(process.execPath, [main, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			...env,
			PATH: [folder, process.env["PATH"] ?? ""].join(delimiter),
		},
	})

test("openbot runs openbot-<name> from PATH and passes the arguments", () => {
	const result = openbot(["echo", "one", "two words", "--flag"])
	assert.equal(result.status, 0)
	assert.equal(result.stdout, "[one]\n[two words]\n[--flag]\n")
})

test("openbot exits with the exit code of the command", () => {
	const result = openbot(["echo"], { ECHO_EXIT: "7" })
	assert.equal(result.status, 7)
})

test("openbot stops with the signal that stopped the command", () => {
	const result = openbot(["stop"])
	assert.equal(result.status, null)
	assert.equal(result.signal, "SIGTERM")
})

test("openbot says when a command does not exist", () => {
	const result = openbot(["no-such-command"])
	assert.equal(result.status, 1)
	assert.equal(result.stdout, "")
	assert.match(result.stderr, /'no-such-command' is not a command/)
})

test("openbot does not take a path as a command name", () => {
	const result = openbot(["../echo"])
	assert.equal(result.status, 1)
	assert.match(result.stderr, /is not a command/)
})

test("openbot, openbot help, and openbot --help list the commands", () => {
	for (const args of [[], ["help"], ["--help"]]) {
		const result = openbot(args)
		assert.equal(result.status, 0)
		assert.match(result.stdout, /^Usage: openbot <command>/)
		assert.match(result.stdout, /^ {2}echo$/m)
		assert.match(result.stdout, /^ {2}stop$/m)
		assert.doesNotMatch(result.stdout, /^ {2}plain$/m)
	}
})

test("openbot help <name> runs the command with --help", () => {
	const result = openbot(["help", "echo"])
	assert.equal(result.status, 0)
	assert.equal(result.stdout, "[--help]\n")
})

test("openbot looks next to itself before PATH", () => {
	const near = mkdtempSync(join(tmpdir(), "openbot-cli-near-"))
	try {
		const file = join(near, "openbot-echo")
		writeFileSync(file, "#!/bin/sh\n")
		chmodSync(file, 0o755)
		const folders = Dispatch.searchFolders({
			script: join(near, "Main.js"),
			path: folder,
		})
		assert.equal(folders[0], near)
		assert.equal(folders.at(-1), folder)
		assert.ok(folders.includes(join(near, "node_modules", ".bin")))
		assert.equal(Dispatch.find("echo", folders), file)
	} finally {
		rmSync(near, { recursive: true, force: true })
	}
})
