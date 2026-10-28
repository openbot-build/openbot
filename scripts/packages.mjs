import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"

const registry = "https://npm.pkg.github.com"

export function releaseVersion(ref, sha) {
	if (!/^[a-f0-9]{40}$/.test(sha))
		throw new Error("A full commit hash is required")
	if (!ref) return { version: `0.0.0-commit-${sha}`, tag: `sha-${sha}` }
	const match =
		/^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/.exec(ref)
	if (!match) throw new Error("Use a version tag such as v0.1.0")
	return { version: match[1], tag: "latest" }
}

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
	const files = directories.map((dir) => join(dir, "package.json"))
	const packages = files
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
		for (const entry of packages) {
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
		}
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

function publish(output) {
	const release = JSON.parse(readFileSync(join(output, "release.json"), "utf8"))
	for (const artifact of release.artifacts) {
		const spec = `${artifact.name}@${release.version}`
		const current = spawnSync(
			"npm",
			["view", spec, "dist.integrity", "--json", "--registry", registry],
			{ encoding: "utf8" },
		)
		if (current.error) throw current.error
		if (current.status === 0) {
			if (JSON.parse(current.stdout) !== artifact.integrity)
				throw new Error(`Package already has other contents: ${spec}`)
		} else {
			let error
			try {
				error = JSON.parse(current.stdout).error
			} catch {
				throw new Error(current.stderr)
			}
			if (error?.code !== "E404")
				throw new Error(current.stderr || error?.summary)
			execFileSync(
				"npm",
				[
					"publish",
					join(output, artifact.file),
					"--ignore-scripts",
					"--registry",
					registry,
					"--tag",
					release.tag,
				],
				{ stdio: "inherit" },
			)
		}
		// Set the tag on a retry too, if a prior run stopped after upload.
		execFileSync(
			"npm",
			["dist-tag", "add", spec, release.tag, "--registry", registry],
			{ stdio: "inherit" },
		)
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const output = resolve(process.argv[3] ?? ".release")
	if (process.argv[2] === "pack")
		pack(
			process.cwd(),
			output,
			process.env.RELEASE_REF ?? "",
			process.env.RELEASE_SHA ??
				execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		)
	else if (process.argv[2] === "publish") publish(output)
	else throw new Error("Use pack or publish")
}
