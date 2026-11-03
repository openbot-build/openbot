import assert from "node:assert/strict"
import { execFile, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import {
	publicationPlan,
	registryArgs,
	releaseManifest,
	releaseVersion,
} from "./packages.mjs"

const sha = "0123456789abcdef0123456789abcdef01234567"

test("a commit has an exact version and its own tag", () => {
	assert.deepEqual(releaseVersion("", sha), {
		version: `0.0.0-commit-${sha}`,
		tag: `sha-${sha}`,
		snapshot: true,
	})
})

test("only a plain version tag can change latest", () => {
	assert.deepEqual(releaseVersion("v1.2.3", sha), {
		version: "1.2.3",
		tag: "latest",
		snapshot: false,
	})
	for (const ref of [
		"main",
		"v01.2.3",
		"v1.2.3-beta",
		"v1.2.3-beta.01",
		"v1.2.3-latest.0",
		"v1.2.3-next.0",
		"v1.2",
	])
		assert.throws(() => releaseVersion(ref, sha))
	assert.throws(() => releaseVersion("", "0123456"))
})

test("a prerelease tag publishes under its channel", () => {
	for (const channel of ["alpha", "beta", "rc"])
		assert.deepEqual(releaseVersion(`v0.2.0-${channel}.3`, sha), {
			version: `0.2.0-${channel}.3`,
			tag: channel,
			snapshot: false,
		})
})

test("workspace packages use the same exact release", () => {
	const manifest = {
		name: "@openbot-build/api",
		version: "0.0.0",
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

test("a scoped package goes to the chosen registry, not its scope's", () => {
	assert.deepEqual(
		registryArgs("@openbot-build/core", "https://registry.npmjs.org"),
		[
			"--registry",
			"https://registry.npmjs.org",
			"--@openbot-build:registry=https://registry.npmjs.org",
		],
	)
	assert.deepEqual(registryArgs("openbot", "https://registry.npmjs.org"), [
		"--registry",
		"https://registry.npmjs.org",
	])
})

test("latest never moves back to an older release", () => {
	const becomesLatest = (version, current) =>
		publicationPlan({ version, tag: "latest" }, current).publishTag === "latest"
	assert.equal(becomesLatest("1.2.3", undefined), true)
	assert.equal(becomesLatest("1.2.3", "1.2.3"), true)
	assert.equal(becomesLatest("1.10.0", "1.9.9"), true)
	assert.equal(becomesLatest("1.2.3", "2.0.0"), false)
	assert.equal(becomesLatest("1.2.3", "1.2.10"), false)
})

// A fake npm records its calls, so these tests never write to a registry.
const publishWith = (
	registry,
	tag,
	mode,
	current = "",
	tagged = "",
	version = "1.2.3",
) => {
	const snapshot = tag.startsWith("sha-")
	const dir = mkdtempSync(join(tmpdir(), "openbot-publish-test-"))
	try {
		writeFileSync(
			join(dir, "release.json"),
			JSON.stringify({
				version,
				tag,
				snapshot,
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
if [ "$1" = "view" ] && [ "$3" = "dist-tags" ]; then
  case "$TEST_MODE" in
    tags-empty) exit 0;;
    tags-invalid) echo '[]'; exit 0;;
    package-missing|package-missing) echo '{"error":{"code":"E404"}}'; exit 1;;
  esac
  if [ -n "$TEST_CURRENT" ]; then printf '{"%s":"%s"}\\n' "$TEST_CHANNEL" "$TEST_CURRENT"
  elif [ -n "$TEST_TAGGED" ]; then printf '{"%s":"1.2.3"}\\n' "$TEST_TAGGED"
  else echo '{}'; fi
  exit 0
fi
if [ "$1" = "view" ]; then
  case "$TEST_MODE" in
    missing|package-missing) echo '{"error":{"code":"E404"}}'; exit 1;;
    same) echo '"sha512-test"'; exit 0;;
    changed) echo '"sha512-other"'; exit 0;;
    denied) echo '{"error":{"code":"E403","summary":"No access"}}'; exit 1;;
    empty) exit 0;;
  esac
fi
printf '%s\\n' "$*" >> "$TEST_LOG"
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
				registry,
				dir,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${dir}:${process.env.PATH}`,
					TEST_MODE: mode,
					TEST_CURRENT: current,
					TEST_CHANNEL: tag,
					TEST_TAGGED: tagged,
					TEST_LOG: log,
				},
			},
		)
		return {
			status: result.status,
			stderr: result.stderr,
			calls: readFileSync(log, "utf8")
				.split("\n")
				.filter((line) => line !== ""),
		}
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

for (const mode of ["missing", "same", "changed", "denied"]) {
	test(`publication handles a ${mode} version`, () => {
		const { status, stderr, calls } = publishWith("github", "latest", mode)
		assert.equal(status, mode === "missing" || mode === "same" ? 0 : 1, stderr)
		assert.deepEqual(
			calls.map((call) => call.split(" ")[0]),
			mode === "missing" ? ["publish"] : mode === "same" ? ["dist-tag"] : [],
		)
	})
}

test("an existing version whose tag is already set needs no calls", () => {
	const { status, stderr, calls } = publishWith(
		"github",
		"latest",
		"same",
		"",
		"latest",
	)
	assert.equal(status, 0, stderr)
	assert.deepEqual(calls, [])
})

test("npm gets public releases, and no snapshots", () => {
	const release = publishWith("npm", "latest", "missing")
	assert.equal(release.status, 0, release.stderr)
	assert.match(release.calls[0], /^publish .*--access public/)
	assert.match(release.calls[0], /--registry https:\/\/registry\.npmjs\.org/)
	const snapshot = publishWith("npm", `sha-${sha}`, "missing")
	assert.equal(snapshot.status, 0, snapshot.stderr)
	assert.deepEqual(snapshot.calls, [])
})

test("npm gets prereleases under their channel, never latest", () => {
	const { status, stderr, calls } = publishWith(
		"npm",
		"beta",
		"missing",
		"0.1.0",
	)
	assert.equal(status, 0, stderr)
	assert.match(calls[0], /^publish .*--tag beta/)
	assert.equal(calls.length, 1)
})

test("an older release does not take latest", () => {
	const { status, stderr, calls } = publishWith(
		"npm",
		"latest",
		"missing",
		"2.0.0",
	)
	assert.equal(status, 0, stderr)
	assert.match(calls[0], /^publish .*--tag backport/)
	assert.equal(calls.length, 1)
})

test("an existing version with no contents yet is published", () => {
	const { status, stderr, calls } = publishWith("github", "latest", "empty")
	assert.equal(status, 0, stderr)
	assert.match(calls[0], /^publish /)
	assert.doesNotMatch(calls[0], /--access/)
})

test("an unknown registry is refused", () => {
	assert.notEqual(publishWith("elsewhere", "latest", "missing").status, 0)
})

test("each registry has a fixed publishing queue across refs and commits", () => {
	const workflow = readFileSync(
		new URL("../.github/workflows/ci.yml", import.meta.url),
		"utf8",
	)
	for (const [job, group] of [
		["npm", "publish-npm"],
		["github-packages", "publish-github-packages"],
	]) {
		const section = workflow
			.split(/\n  (?=[\w-]+:\n)/)
			.find((part) => part.startsWith(`${job}:\n`))
		assert.ok(section, `Missing job: ${job}`)
		const concurrency = section.match(
			/^    concurrency:\n((?:      .*\n)+)/m,
		)?.[1]
		assert.ok(concurrency, `Missing job concurrency: ${job}`)
		assert.match(concurrency, new RegExp(`^      group: ${group}$`, "m"))
		assert.match(concurrency, /^      cancel-in-progress: false$/m)
		assert.match(concurrency, /^      queue: max$/m)
	}
})

test("npm retries leave existing versions and tags unchanged without tag permissions", () => {
	const { status, stderr, calls } = publishWith(
		"npm",
		"latest",
		"same",
		"2.0.0",
	)
	assert.equal(status, 0, stderr)
	assert.deepEqual(calls, [])
})

for (const registry of ["npm", "github"]) {
	for (const [tag, older, newer] of [
		["latest", "1.0.0", "2.0.0"],
		["alpha", "0.2.0-alpha.1", "0.2.0-alpha.2"],
		["beta", "0.2.0-beta.2", "0.2.0-beta.10"],
		["rc", "0.2.0-rc.10", "0.3.0-rc.1"],
	]) {
		for (const versions of [
			[older, newer],
			[newer, older],
		]) {
			test(`${registry} serialized publications preserve ${tag} in order ${versions.join(", ")} and on retry`, () => {
				const dir = mkdtempSync(join(tmpdir(), "openbot-release-order-"))
				try {
					const stateFile = join(dir, "state.json")
					writeFileSync(
						stateFile,
						JSON.stringify({ tags: { latest: "0.5.0" }, versions: {} }),
					)
					writeFileSync(
						join(dir, "npm"),
						`#!${process.execPath}
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.TEST_STATE, "utf8"));
const [command, spec, field] = process.argv.slice(2);
if (command === "view") {
 const value = field === "dist-tags" ? state.tags : state.versions[spec.split("@").at(-1)];
 if (value === undefined) { console.log('{"error":{"code":"E404"}}'); process.exit(1); }
 console.log(JSON.stringify(value));
} else {
 const args = process.argv.slice(2);
 if (command === "publish") {
  const version = JSON.parse(fs.readFileSync(spec, "utf8")).version;
  state.versions[version] = "sha512-test";
  state.tags[args[args.indexOf("--tag") + 1]] = version;
 } else if (command === "dist-tag") {
  state.tags[args[3]] = args[2].split("@").at(-1);
 } else { throw new Error("Unexpected npm command: " + command); }
 fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(state));
}
`,
						{ mode: 0o755 },
					)
					for (const version of [...versions, older]) {
						writeFileSync(join(dir, "core.tgz"), JSON.stringify({ version }))
						writeFileSync(
							join(dir, "release.json"),
							JSON.stringify({
								version,
								tag,
								snapshot: false,
								artifacts: [
									{
										name: "@openbot-build/core",
										file: "core.tgz",
										integrity: "sha512-test",
									},
								],
							}),
						)
						const result = spawnSync(
							process.execPath,
							[
								fileURLToPath(new URL("./packages.mjs", import.meta.url)),
								"publish",
								registry,
								dir,
							],
							{
								encoding: "utf8",
								env: {
									...process.env,
									PATH: `${dir}:${process.env.PATH}`,
									TEST_STATE: stateFile,
								},
							},
						)
						assert.equal(result.status, 0, result.stderr)
					}
					const state = JSON.parse(readFileSync(stateFile, "utf8"))
					assert.equal(state.tags[tag], newer)
					if (tag !== "latest") assert.equal(state.tags.latest, "0.5.0")
					if (versions[0] === newer)
						assert.equal(
							state.tags[tag === "latest" ? "backport" : `${tag}-backport`],
							older,
						)
					assert.deepEqual(
						Object.keys(state.versions).sort(),
						[older, newer].sort(),
					)
				} finally {
					rmSync(dir, { recursive: true, force: true })
				}
			})
		}
	}
}

test("channel decisions follow SemVer precedence in both directions", () => {
	// The SemVer specification's precedence examples, extended with numeric boundaries.
	const ordered = [
		"1.0.0-alpha",
		"1.0.0-alpha.1",
		"1.0.0-alpha.beta",
		"1.0.0-beta",
		"1.0.0-beta.2",
		"1.0.0-beta.11",
		"1.0.0-rc.1",
		"1.0.0",
		"1.0.1-alpha.0",
		"1.0.1",
		"1.1.0",
		"2.0.0",
	]
	for (const [index, current] of ordered.entries()) {
		for (const version of ordered.slice(index + 1)) {
			assert.deepEqual(
				publicationPlan({ version, tag: "beta" }, current),
				{
					publishTag: "beta",
					repairTag: "beta",
				},
				`${current} -> ${version}`,
			)
			assert.deepEqual(
				publicationPlan({ version: current, tag: "beta" }, version),
				{
					publishTag: "beta-backport",
					repairTag: undefined,
				},
				`${version} -> ${current}`,
			)
		}
	}
	for (const [version, current] of [
		["1.0.0-beta.9007199254740993", "1.0.0-beta.9007199254740992"],
		["9007199254740993.0.0", "9007199254740992.0.0"],
	]) {
		assert.equal(
			publicationPlan({ version, tag: "beta" }, current).repairTag,
			"beta",
		)
		assert.equal(
			publicationPlan({ version: current, tag: "beta" }, version).repairTag,
			undefined,
		)
	}
})

test("channel repair distinguishes missing, equal and older versions without ordering build metadata", () => {
	const release = { version: "0.2.0-beta.2", tag: "beta" }
	assert.deepEqual(publicationPlan(release, undefined), {
		publishTag: "beta",
		repairTag: "beta",
	})
	assert.deepEqual(publicationPlan(release, release.version), {
		publishTag: "beta",
		repairTag: undefined,
	})
	assert.deepEqual(publicationPlan(release, "0.2.0-beta.2+build.99"), {
		publishTag: "beta",
		repairTag: "beta",
	})
	assert.deepEqual(publicationPlan(release, "0.2.0-beta.3+build.1"), {
		publishTag: "beta-backport",
		repairTag: undefined,
	})
	const snapshot = releaseVersion("", sha)
	assert.deepEqual(publicationPlan(snapshot, undefined), {
		publishTag: `sha-${sha}`,
		repairTag: `sha-${sha}`,
	})
	assert.deepEqual(publicationPlan(snapshot, snapshot.version), {
		publishTag: `sha-${sha}`,
		repairTag: undefined,
	})
})

test("an invalid registry version stops publication instead of moving a channel", () => {
	for (const current of [
		"not-a-version",
		"1.0",
		"01.0.0",
		"1.0.0-beta.01",
		"1.0.0\n",
	]) {
		assert.throws(
			() => publicationPlan({ version: "1.0.0", tag: "latest" }, current),
			/Invalid SemVer/,
		)
	}
	const { status, calls } = publishWith(
		"github",
		"latest",
		"missing",
		"not-a-version",
	)
	assert.notEqual(status, 0)
	assert.deepEqual(calls, [])
})

test("GitHub repairs a prerelease channel only toward an existing newer version", () => {
	const forward = publishWith(
		"github",
		"beta",
		"same",
		"1.2.3-beta.1",
		"",
		"1.2.3-beta.2",
	)
	assert.equal(forward.status, 0, forward.stderr)
	assert.deepEqual(forward.calls, [
		"dist-tag add @openbot-build/core@1.2.3-beta.2 beta --registry https://npm.pkg.github.com --@openbot-build:registry=https://npm.pkg.github.com",
	])
	const backward = publishWith(
		"github",
		"beta",
		"same",
		"1.2.3-beta.2",
		"",
		"1.2.3-beta.1",
	)
	assert.equal(backward.status, 0, backward.stderr)
	assert.deepEqual(backward.calls, [])
})

for (const [scenario, tags, expected] of [
	[
		"beta without latest",
		{ beta: "0.2.0-beta.2" },
		{ publishTag: "beta-backport" },
	],
	[
		"beta alongside an older latest",
		{ beta: "0.2.0-beta.2", latest: "0.1.0" },
		{ publishTag: "beta-backport" },
	],
	[
		"a missing beta channel",
		{ latest: "0.1.0" },
		{ publishTag: "beta", repairTag: "beta" },
	],
]) {
	// Runs in the repository, whose .npmrc sends @openbot-build to GitHub
	// Packages, so this also checks that the chosen registry wins.
	test(`real npm reads ${scenario} from a local registry`, async () => {
		const cache = mkdtempSync(join(tmpdir(), "openbot-registry-protocol-"))
		const newer = "0.2.0-beta.2"
		const server = createServer((request, response) => {
			assert.equal(request.method, "GET")
			response.setHeader("content-type", "application/json")
			response.end(
				JSON.stringify({
					name: "@openbot-build/core",
					"dist-tags": tags,
					versions: {
						"0.1.0": { name: "@openbot-build/core", version: "0.1.0" },
						[newer]: {
							name: "@openbot-build/core",
							version: newer,
							dist: { integrity: "sha512-test" },
						},
					},
				}),
			)
		})
		try {
			await new Promise((resolve, reject) => {
				server.once("error", reject)
				server.listen(0, "127.0.0.1", resolve)
			})
			const registry = `http://127.0.0.1:${server.address().port}`
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`
   import { readDistTags, publicationPlan } from ${JSON.stringify(new URL("./packages.mjs", import.meta.url).href)};
   const tags = readDistTags("@openbot-build/core", "beta", ${JSON.stringify(registry)}, process.env);
   console.log(JSON.stringify(publicationPlan({version: "0.2.0-beta.1", tag: "beta"}, tags.beta)));
  `,
				],
				{
					cwd: fileURLToPath(new URL("..", import.meta.url)),
					env: {
						...process.env,
						NPM_CONFIG_CACHE: cache,
						NPM_CONFIG_USERCONFIG: join(cache, "npmrc"),
					},
					timeout: 15000,
				},
			)
			assert.deepEqual(JSON.parse(stdout), expected)
		} finally {
			await new Promise((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			)
			rmSync(cache, { recursive: true, force: true })
		}
	})
}

test("empty or malformed tag responses fail closed while a missing package can publish", () => {
	for (const mode of ["tags-empty", "tags-invalid"]) {
		const result = publishWith("npm", "beta", mode)
		assert.notEqual(result.status, 0)
		assert.deepEqual(result.calls, [])
	}
	const absent = publishWith("npm", "beta", "package-missing")
	assert.equal(absent.status, 0, absent.stderr)
	assert.match(absent.calls[0], /--tag beta/)
})
