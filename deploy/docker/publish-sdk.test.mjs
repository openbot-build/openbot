import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const names = ["core", "domain", "protocol", "api", "client"]

const fixture = async (t, options = {}) => {
	const directory = await mkdtemp(path.join(tmpdir(), "openbot-sdk-test-"))
	t.after(() => rm(directory, { recursive: true, force: true }))
	await mkdir(path.join(directory, "scripts"))
	await cp(
		path.join(root, "scripts/publish-kay-sdk.mjs"),
		path.join(directory, "scripts/publish-kay-sdk.mjs"),
	)
	await writeFile(path.join(directory, "LICENSE"), "AGPL-3.0-only fixture\n")
	for (const name of names) {
		const base = path.join(directory, "packages", name)
		await mkdir(path.join(base, "dist"), { recursive: true })
		await mkdir(path.join(base, "src"))
		await writeFile(path.join(base, "src/index.ts"), "export const value = 1\n")
		const entry = name === "protocol" ? "main.js" : "index.js"
		await writeFile(path.join(base, "dist", entry), "export const value = 1\n")
		const exports = { ".": `./dist/${entry}` }
		if (name === "protocol") {
			await mkdir(path.join(base, "test"))
			await writeFile(
				path.join(base, "test/Testing.ts"),
				"export const testValue = 1\n",
			)
			exports["./testing"] = "./test/Testing.ts"
			if (options.missingEntry) exports["./missing"] = "./dist/Missing.js"
		}
		const dependencies =
			name === "client"
				? Object.fromEntries(
						["core", "domain", "protocol", "api"].map((dependency) => [
							`@openbot-build/${dependency}`,
							"workspace:*",
						]),
					)
				: {}
		await writeFile(
			path.join(base, "package.json"),
			JSON.stringify(
				{
					name: `@openbot-build/${name}`,
					version: "0.1.0",
					license: "AGPL-3.0-only",
					type: "module",
					files: [
						"dist",
						"src",
						...(name === "protocol" ? ["test/Testing.ts"] : []),
					],
					exports,
					dependencies,
					peerDependencies:
						name === "api" ? { "@openbot-build/domain": "workspace:^" } : {},
					optionalDependencies:
						name === "api" ? { "@openbot-build/protocol": "workspace:*" } : {},
					devDependencies: { "test-only": "1.0.0" },
					scripts: {
						prepack:
							"node -e 'throw new Error(\"Must not run package scripts\")'",
					},
				},
				null,
				2,
			) + "\n",
		)
	}
	const git = (...args) =>
		execFileSync("git", args, {
			cwd: directory,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim()
	git("init", "--quiet")
	git("add", ".")
	git(
		"-c",
		"user.name=SDK fixture",
		"-c",
		"user.email=sdk-fixture@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--quiet",
		"-m",
		"Create SDK fixture",
	)
	const revision = git("rev-parse", "HEAD")
	const run = () =>
		spawnSync(process.execPath, ["scripts/publish-kay-sdk.mjs", "pack"], {
			cwd: directory,
			env: { ...process.env, CI_COMMIT_SHA: revision },
			encoding: "utf8",
			timeout: 60000,
		})
	return {
		directory,
		revision,
		run,
		output: path.join(directory, ".devenv/release/sdk"),
	}
}

test("SDK archives keep their real entries and one commit version for all workspace dependencies", async (t) => {
	const current = await fixture(t)
	const packed = current.run()
	assert.equal(packed.status, 0, packed.stderr || packed.error?.message)
	const manifest = JSON.parse(
		await readFile(path.join(current.output, "manifest.json"), "utf8"),
	)
	assert.equal(manifest.revision, current.revision)
	assert.deepEqual(
		manifest.packages.map((entry) => entry.name),
		names.map((name) => `@openbot-build/${name}`),
	)
	const version = `0.1.0-kay.g${current.revision.slice(0, 12)}`
	for (const entry of manifest.packages) {
		assert.equal(entry.version, version)
		const archive = path.join(current.output, entry.file)
		const bytes = await readFile(archive)
		assert.equal(
			entry.integrity,
			`sha512-${createHash("sha512").update(bytes).digest("base64")}`,
		)
		const unpack = (file) =>
			execFileSync("tar", ["-xOf", archive, `package/${file}`], {
				encoding: "utf8",
			})
		const pkg = JSON.parse(unpack("package.json"))
		assert.equal(pkg.name, entry.name)
		assert.equal(pkg.version, version)
		assert.equal(pkg.gitHead, current.revision)
		assert.equal(pkg.license, "AGPL-3.0-only")
		assert.equal(pkg.scripts, undefined)
		assert.equal(pkg.devDependencies, undefined)
		assert.match(unpack("LICENSE"), /AGPL-3.0-only/)
		assert.match(unpack("src/index.ts"), /value = 1/)
		for (const group of [
			"dependencies",
			"peerDependencies",
			"optionalDependencies",
		])
			for (const range of Object.values(pkg[group] ?? {}))
				assert.equal(range, version)
		assert.match(unpack(pkg.exports["."].slice(2)), /value = 1/)
		if (entry.name === "@openbot-build/protocol") {
			assert.equal(pkg.exports["."], "./dist/main.js")
			assert.equal(pkg.exports["./testing"], "./test/Testing.ts")
			assert.match(unpack("test/Testing.ts"), /testValue = 1/)
		}
	}
})

test("SDK packing rejects changed tracked source", async (t) => {
	const current = await fixture(t)
	await writeFile(
		path.join(current.directory, "packages/core/src/index.ts"),
		"export const value = 2\n",
	)
	const packed = current.run()
	assert.notEqual(
		packed.status,
		0,
		"Changed source must not use the committed version.",
	)
	await assert.rejects(readFile(path.join(current.output, "manifest.json")), {
		code: "ENOENT",
	})
})

test("SDK packing rejects source that is not in the commit", async (t) => {
	const current = await fixture(t)
	await writeFile(
		path.join(current.directory, "packages/core/src/New.ts"),
		"export const added = true\n",
	)
	const packed = current.run()
	assert.notEqual(
		packed.status,
		0,
		"Untracked source must not enter a committed SDK release.",
	)
	await assert.rejects(readFile(path.join(current.output, "manifest.json")), {
		code: "ENOENT",
	})
})

test("SDK packing rejects a missing declared export", async (t) => {
	const current = await fixture(t, { missingEntry: true })
	const packed = current.run()
	assert.notEqual(
		packed.status,
		0,
		"Every public export must have a file in the archive.",
	)
	await assert.rejects(readFile(path.join(current.output, "manifest.json")), {
		code: "ENOENT",
	})
})
