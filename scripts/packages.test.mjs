import assert from "node:assert/strict"
import { test } from "node:test"
import { releaseManifest, releaseVersion } from "./packages.mjs"

const sha = "0123456789abcdef0123456789abcdef01234567"
test("a commit has an exact version and its own tag", () => {
	assert.deepEqual(releaseVersion("", sha), {
		version: `0.0.0-commit-${sha}`,
		tag: `sha-${sha}`,
	})
})
test("only a plain version tag can change latest", () => {
	assert.deepEqual(releaseVersion("v1.2.3", sha), {
		version: "1.2.3",
		tag: "latest",
	})
	for (const ref of ["main", "v01.2.3", "v1.2.3-beta", "v1.2"])
		assert.throws(() => releaseVersion(ref, sha))
	assert.throws(() => releaseVersion("", "0123456"))
})
test("workspace packages use the same exact release", () => {
	const manifest = {
		name: "@openbot-build/api",
		version: "0.1.0",
		dependencies: { "@openbot-build/core": "workspace:*", effect: "4.0.7" },
		peerDependencies: { "@openbot-build/domain": "workspace:^" },
	}
	const result = releaseManifest(
		manifest,
		"1.2.3",
		new Set(["@openbot-build/core", "@openbot-build/domain"]),
	)
	assert.equal(result.dependencies["@openbot-build/core"], "1.2.3")
	assert.equal(result.peerDependencies["@openbot-build/domain"], "1.2.3")
	assert.equal(result.dependencies.effect, "4.0.7")
	assert.equal(manifest.dependencies["@openbot-build/core"], "workspace:*")
	assert.throws(() => releaseManifest(manifest, "1.2.3", new Set()))
})

// Fake npm replies exercise retries without writing to a registry.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

for (const mode of ["missing", "same", "changed", "denied"]) {
	test(`publication handles a ${mode} version`, () => {
		const dir = mkdtempSync(join(tmpdir(), "openbot-publish-test-"))
		try {
			writeFileSync(
				join(dir, "release.json"),
				JSON.stringify({
					version: "1.2.3",
					tag: "latest",
					artifacts: [
						{
							name: "@openbot-build/core",
							file: "core.tgz",
							integrity: "sha512-test",
						},
					],
				}),
			)
			writeFileSync(
				join(dir, "npm"),
				`#!/bin/sh
if [ "$1" = "view" ]; then
  case "$TEST_MODE" in
    missing) echo '{"error":{"code":"E404"}}'; exit 1;;
    same) echo '"sha512-test"'; exit 0;;
    changed) echo '"sha512-other"'; exit 0;;
    denied) echo '{"error":{"code":"E403","summary":"No access"}}'; exit 1;;
  esac
fi
printf '%s\n' "$1" >> "$TEST_LOG"
`,
				{ mode: 0o755 },
			)
			const log = join(dir, "calls")
			writeFileSync(log, "")
			const result = spawnSync(
				process.execPath,
				[
					fileURLToPath(new URL("./packages.mjs", import.meta.url)),
					"publish",
					dir,
				],
				{
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${dir}:${process.env.PATH}`,
						TEST_MODE: mode,
						TEST_LOG: log,
					},
				},
			)
			assert.equal(
				result.status,
				mode === "missing" || mode === "same" ? 0 : 1,
				result.stderr,
			)
			assert.equal(
				readFileSync(log, "utf8"),
				mode === "missing"
					? "publish\ndist-tag\n"
					: mode === "same"
						? "dist-tag\n"
						: "",
			)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
}
