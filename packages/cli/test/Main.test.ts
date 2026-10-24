import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterAll, assert, it } from "@effect/vitest"
import * as Dispatch from "../src/Dispatch.ts"

const main = join(import.meta.dirname, "..", "dist", "Main.js")
const folder = mkdtempSync(join(tmpdir(), "openbot-cli-"))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

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

it("openbot runs openbot-<name> from PATH and passes the arguments", () => {
	const result = openbot(["echo", "one", "two words", "--flag"])
	assert.strictEqual(result.status, 0)
	assert.strictEqual(result.stdout, "[one]\n[two words]\n[--flag]\n")
})

it("openbot exits with the exit code of the command", () => {
	const result = openbot(["echo"], { ECHO_EXIT: "7" })
	assert.strictEqual(result.status, 7)
})

it("openbot stops with the signal that stopped the command", () => {
	const result = openbot(["stop"])
	assert.strictEqual(result.status, null)
	assert.strictEqual(result.signal, "SIGTERM")
})

it("openbot says when a command does not exist", () => {
	const result = openbot(["no-such-command"])
	assert.strictEqual(result.status, 1)
	assert.strictEqual(result.stdout, "")
	assert.match(result.stderr, /'no-such-command' is not a command/)
})

it("openbot does not take a path as a command name", () => {
	const result = openbot(["../echo"])
	assert.strictEqual(result.status, 1)
	assert.match(result.stderr, /is not a command/)
})

it("openbot, openbot help, and openbot --help list the commands", () => {
	for (const args of [[], ["help"], ["--help"]]) {
		const result = openbot(args)
		assert.strictEqual(result.status, 0)
		assert.match(result.stdout, /^Usage: openbot <command>/)
		assert.match(result.stdout, /^ {2}echo$/m)
		assert.match(result.stdout, /^ {2}stop$/m)
		assert.notMatch(result.stdout, /^ {2}plain$/m)
	}
})

it("openbot help <name> runs the command with --help", () => {
	const result = openbot(["help", "echo"])
	assert.strictEqual(result.status, 0)
	assert.strictEqual(result.stdout, "[--help]\n")
})

it("openbot looks next to itself before PATH", () => {
	const near = mkdtempSync(join(tmpdir(), "openbot-cli-near-"))
	try {
		const file = join(near, "openbot-echo")
		writeFileSync(file, "#!/bin/sh\n")
		chmodSync(file, 0o755)
		const folders = Dispatch.searchFolders({
			script: join(near, "Main.js"),
			path: folder,
		})
		assert.strictEqual(folders[0], near)
		assert.strictEqual(folders.at(-1), folder)
		assert.ok(folders.includes(join(near, "node_modules", ".bin")))
		assert.strictEqual(Dispatch.find("echo", folders), file)
	} finally {
		rmSync(near, { recursive: true, force: true })
	}
})
