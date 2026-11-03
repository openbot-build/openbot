// Packs every public workspace package with one shared version, and publishes
// the packed files to GitHub Packages or to npm. Run from a package directory,
// it packs only that package. See "Publish and check the project" in the
// developer docs for how CI uses this script.
import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const registries = {
	github: { url: "https://npm.pkg.github.com", snapshots: true },
	npm: { url: "https://registry.npmjs.org", snapshots: false },
}

/**
 * A commit gets an exact snapshot version; a tag like v1.2.3 is a release,
 * and a tag like v1.2.3-beta.0 a prerelease under its channel's npm tag.
 */
export function releaseVersion(ref, sha) {
	if (!/^[a-f0-9]{40}$/.test(sha))
		throw new Error("A full commit hash is required")
	if (!ref)
		return {
			version: `0.0.0-commit-${sha}`,
			tag: `sha-${sha}`,
			snapshot: true,
		}
	const match =
		/^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(alpha|beta|rc)\.(?:0|[1-9][0-9]*))?)$/.exec(
			ref,
		)
	if (!match)
		throw new Error("Use a version tag such as v0.1.0 or v0.2.0-beta.0")
	return { version: match[1], tag: match[2] ?? "latest", snapshot: false }
}

// Publishing jobs run without workspace dependencies. Keep SemVer precedence
// self-contained, including registry versions with arbitrary prerelease identifiers.
function parseVersion(version) {
	const match =
		/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
			version,
		)
	if (!match || match[0] !== version)
		throw new Error(`Invalid SemVer version: ${version}`)
	const prerelease = match[4]?.split(".") ?? []
	if (prerelease.some((part) => /^0[0-9]+$/.test(part)))
		throw new Error(`Invalid SemVer version: ${version}`)
	return { core: match.slice(1, 4).map(BigInt), prerelease }
}

const compare = (left, right) => (left === right ? 0 : left < right ? -1 : 1)
const numeric = (identifier) => /^[0-9]+$/.test(identifier)

function compareVersions(left, right) {
	const next = parseVersion(left)
	const current = parseVersion(right)
	for (const [index, value] of next.core.entries()) {
		const order = compare(value, current.core[index])
		if (order !== 0) return order
	}
	if (next.prerelease.length === 0)
		return current.prerelease.length === 0 ? 0 : 1
	if (current.prerelease.length === 0) return -1
	for (const [index, value] of next.prerelease.entries()) {
		const previous = current.prerelease[index]
		if (previous === undefined) return 1
		const order =
			numeric(value) && numeric(previous)
				? compare(BigInt(value), BigInt(previous))
				: numeric(value) !== numeric(previous)
					? numeric(value)
						? -1
						: 1
					: compare(value, previous)
		if (order !== 0) return order
	}
	return compare(next.prerelease.length, current.prerelease.length)
}

/** One channel decision for first uploads and tag repair, under the registry lock. */
export function publicationPlan({ version, tag, snapshot }, current) {
	const mayAdvance =
		snapshot || current === undefined || compareVersions(version, current) >= 0
	return {
		publishTag: mayAdvance
			? tag
			: tag === "latest"
				? "backport"
				: `${tag}-backport`,
		repairTag: mayAdvance && current !== version ? tag : undefined,
	}
}

/** Gives the package the release version, and pins its workspace dependencies to it. */
export function releaseManifest(manifest, version, names) {
	const result = { ...manifest, version }
	for (const field of [
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		if (!manifest[field]) continue
		result[field] = Object.fromEntries(
			Object.entries(manifest[field]).map(([name, value]) => {
				if (names.has(name)) return [name, version]
				if (value.startsWith("workspace:"))
					throw new Error(`Package is not in the release: ${name}`)
				return [name, value]
			}),
		)
	}
	return result
}

function pack(root, output, ref, sha) {
	const release = releaseVersion(ref, sha)
	const directories = existsSync(join(root, "pnpm-workspace.yaml"))
		? readdirSync(join(root, "packages"), { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(root, "packages", entry.name))
		: [root]
	const packages = directories
		.map((directory) => join(directory, "package.json"))
		.map((file) => ({ file, original: readFileSync(file, "utf8") }))
		.map((entry) => ({ ...entry, manifest: JSON.parse(entry.original) }))
		.filter((entry) => !entry.manifest.private)
	const names = new Set(packages.map((entry) => entry.manifest.name))
	mkdirSync(output, { recursive: true })
	try {
		for (const entry of packages) {
			const manifest = releaseManifest(entry.manifest, release.version, names)
			writeFileSync(entry.file, JSON.stringify(manifest, null, "\t") + "\n")
		}
		for (const entry of packages)
			execFileSync(
				"pnpm",
				[
					"--dir",
					resolve(entry.file, ".."),
					"pack",
					"--pack-destination",
					output,
				],
				{ stdio: "inherit" },
			)
		const artifacts = packages.map(({ manifest }) => {
			const file = `${manifest.name.replace("@", "").replace("/", "-")}-${release.version}.tgz`
			const integrity = `sha512-${createHash("sha512")
				.update(readFileSync(join(output, file)))
				.digest("base64")}`
			return { name: manifest.name, file, integrity }
		})
		writeFileSync(
			join(output, "release.json"),
			JSON.stringify({ ...release, sha, artifacts }, null, "\t") + "\n",
		)
	} finally {
		for (const entry of packages) writeFileSync(entry.file, entry.original)
	}
}

/**
 * Points npm at one registry for a package. A scope registry, such as the one
 * in this repository's `.npmrc`, wins over `--registry`, so it is set as well.
 */
export function registryArgs(name, registry) {
	const scope = name.startsWith("@") ? name.split("/")[0] : undefined
	return [
		"--registry",
		registry,
		...(scope ? [`--${scope}:registry=${registry}`] : []),
	]
}

/** Reads a field of a published package, or `undefined` if it does not exist. */
function viewRegistry(name, spec, field, registry, env) {
	const result = spawnSync(
		"npm",
		["view", spec, field, "--json", ...registryArgs(name, registry)],
		{ encoding: "utf8", env },
	)
	if (result.error) throw result.error
	if (result.status === 0)
		return result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout)
	let error
	try {
		error = JSON.parse(result.stdout).error
	} catch {
		throw new Error(result.stderr)
	}
	if (error?.code !== "E404") throw new Error(result.stderr || error?.summary)
	return field === "dist-tags" ? {} : undefined
}

/** Read packument tags without npm's implicit latest-version selection. */
export function readDistTags(name, channel, registry, env) {
	const tags = viewRegistry(
		name,
		`${name}@${channel}`,
		"dist-tags",
		registry,
		env,
	)
	if (tags === undefined)
		throw new Error(`No dist-tags object returned for ${name}`)
	if (
		tags === null ||
		typeof tags !== "object" ||
		Array.isArray(tags) ||
		Object.values(tags).some((version) => typeof version !== "string")
	)
		throw new Error(`Invalid dist-tags object returned for ${name}`)
	return tags
}

function publish(output, name) {
	const registry = registries[name]
	if (!registry) throw new Error("Use github or npm as the registry")
	const release = JSON.parse(readFileSync(join(output, "release.json"), "utf8"))
	if (release.snapshot && !registry.snapshots) {
		console.log(`Snapshots are not published to ${name}`)
		return
	}
	const host = new URL(registry.url).host
	// With NODE_AUTH_TOKEN, npm reads the token from the environment, so it is
	// never written to disk. Without one, npm signs in as usual: with trusted
	// publishing in CI, or with the npm login on a developer's machine.
	const token = process.env["NODE_AUTH_TOKEN"]
	const config = mkdtempSync(join(tmpdir(), "openbot-publish-"))
	writeFileSync(
		join(config, "npmrc"),
		`//${host}/:_authToken=\${NODE_AUTH_TOKEN}\n`,
	)
	const env = token
		? { ...process.env, NPM_CONFIG_USERCONFIG: join(config, "npmrc") }
		: process.env
	const npm = (packageName, args) =>
		execFileSync("npm", [...args, ...registryArgs(packageName, registry.url)], {
			stdio: "inherit",
			env,
		})

	try {
		for (const artifact of release.artifacts) {
			const spec = `${artifact.name}@${release.version}`
			// The caller must serialize this entire operation per registry (CI uses
			// a fixed job concurrency group). A check alone cannot prevent a race.
			const { publishTag, repairTag } = publicationPlan(
				release,
				readDistTags(artifact.name, release.tag, registry.url, env)[
					release.tag
				],
			)
			const integrity = viewRegistry(
				artifact.name,
				spec,
				"dist.integrity",
				registry.url,
				env,
			)
			// Our npm trusted publisher grants publish access without dist-tag access.
			// Set the tag as part of the first upload; retries leave npm tags alone.
			if (integrity === undefined)
				npm(artifact.name, [
					"publish",
					join(output, artifact.file),
					"--ignore-scripts",
					"--tag",
					publishTag,
					...(name === "npm" ? ["--access", "public"] : []),
				])
			else if (integrity !== artifact.integrity)
				throw new Error(`Package already has other contents: ${spec}`)
			// GitHub Packages also permits repairing a tag after a partial upload.
			else if (name !== "npm" && repairTag !== undefined)
				npm(artifact.name, ["dist-tag", "add", spec, repairTag])
		}
	} finally {
		rmSync(config, { recursive: true, force: true })
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [command, registry, directory] = process.argv.slice(2)
	if (command === "pack")
		pack(
			process.cwd(),
			resolve(registry ?? ".release"),
			process.env.RELEASE_REF ?? "",
			process.env.RELEASE_SHA ??
				execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		)
	else if (command === "publish")
		publish(resolve(directory ?? ".release"), registry)
	else
		throw new Error("Use pack [directory] or publish <github|npm> [directory]")
}
