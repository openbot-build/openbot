import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const revision = "a".repeat(40),
	digest = "sha256:" + "b".repeat(64)
const registry = "registry.example:5050/openbot/platform"
async function publish(failure = "") {
	const directory = await mkdtemp(join(tmpdir(), "openbot-publish-"))
	try {
		const bin = join(directory, "bin"),
			trace = join(directory, "trace")
		await mkdir(bin)
		await writeFile(trace, "")
		await writeFile(
			join(bin, "docker"),
			"#!/usr/bin/env node\n" +
				`
const fs=require("node:fs"),args=process.argv.slice(2)
fs.appendFileSync(process.env.TRACE,JSON.stringify(args)+"\\n")
if(args[0]==="push") {
 if(args[1]!=="--platform" || args[2]!=="linux/amd64") process.exit(1)
 process.stdout.write("push progress\\n")
} else if(args[0]==="buildx") {
 process.stdout.write(process.env.FAILURE==="digest"?"invalid":process.env.DIGEST)
} else if(args[0]==="pull") {
 if(process.env.FAILURE==="pull")process.exit(1)
} else if(args[0]==="image") {
 process.stdout.write(args.at(-1).includes("Architecture") ? (process.env.FAILURE==="architecture"?"arm64":"amd64") : (process.env.FAILURE==="revision"?"wrong":process.env.REVISION))
}
`,
			{ mode: 0o755 },
		)
		const result = spawnSync(
			"bash",
			[
				fileURLToPath(new URL("./publish-platform.sh", import.meta.url)),
				"openbot-platform:" + revision,
				registry + ":" + revision,
				revision,
			],
			{
				cwd: directory,
				env: {
					...process.env,
					PATH: bin + ":" + process.env.PATH,
					TRACE: trace,
					REVISION: revision,
					DIGEST: digest,
					FAILURE: failure,
				},
				encoding: "utf8",
			},
		)
		return {
			result,
			calls: (await readFile(trace, "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		}
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}

test("publish selects AMD64 and returns only the digest fetched back from the registry", async () => {
	const { result, calls } = await publish()
	assert.equal(result.status, 0, result.stderr)
	assert.equal(result.stdout, registry + "@" + digest + "\n")
	assert.deepEqual(
		calls.find((args) => args[0] === "push"),
		["push", "--platform", "linux/amd64", registry + ":" + revision],
	)
	const inspect = calls.findIndex((args) => args[0] === "buildx")
	const pull = calls.findIndex((args) => args[0] === "pull")
	assert.ok(inspect >= 0 && pull > inspect)
	assert.deepEqual(calls[pull], [
		"pull",
		"--platform",
		"linux/amd64",
		registry + "@" + digest,
	])
	assert.equal(
		calls.some((args) => args.some((value) => value.includes("RepoDigests"))),
		false,
	)
})

for (const failure of ["digest", "pull", "architecture", "revision"]) {
	test(`publish rejects ${failure} failures before recording a release`, async () => {
		const { result } = await publish(failure)
		assert.notEqual(result.status, 0)
		assert.equal(result.stdout, "")
	})
}
