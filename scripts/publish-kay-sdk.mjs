import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const output = path.join(root, ".devenv/release/sdk")
const packages = ["core", "domain", "protocol", "api", "client"]
const command = process.argv[2]
const revision =
	process.env.CI_COMMIT_SHA ??
	execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim()
if (!/^[a-f0-9]{40}$/.test(revision))
	throw new Error("A full source revision is required")
const version = `0.1.0-kay.g${revision.slice(0, 12)}`

if (command === "pack") {
	if (
		execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim() !== revision
	)
		throw new Error("The checked out source does not match the release")
	if (
		execFileSync(
			"git",
			["status", "--porcelain", "--untracked-files=all", "--", "packages"],
			{ cwd: root, encoding: "utf8" },
		).trim() !== ""
	)
		throw new Error("Commit all SDK source changes before packing")
	await mkdir(output, { recursive: true })
	const staging = await mkdtemp(path.join(tmpdir(), "openbot-sdk-"))
	const entries = []
	try {
		for (const name of packages) {
			const source = path.join(root, "packages", name)
			const destination = path.join(staging, name)
			const manifest = JSON.parse(
				await readFile(path.join(source, "package.json"), "utf8"),
			)
			manifest.version = version
			manifest.gitHead = revision
			delete manifest.scripts
			delete manifest.devDependencies
			for (const group of [
				"dependencies",
				"optionalDependencies",
				"peerDependencies",
			]) {
				for (const [dependency, range] of Object.entries(
					manifest[group] ?? {},
				)) {
					if (!range.startsWith("workspace:")) continue
					if (!packages.some((item) => dependency === `@openbot-build/${item}`))
						throw new Error(`The SDK set is missing ${dependency}`)
					manifest[group][dependency] = version
				}
			}
			await mkdir(destination)
			for (const entry of Object.values(manifest.exports)) {
				if (
					typeof entry !== "string" ||
					!entry.startsWith("./") ||
					entry.includes("..", 2)
				)
					throw new Error(`Unsupported SDK export in ${manifest.name}`)
				await stat(path.join(source, entry))
			}
			for (const entry of manifest.files) {
				await mkdir(path.dirname(path.join(destination, entry)), {
					recursive: true,
				})
				try {
					await cp(path.join(source, entry), path.join(destination, entry), {
						recursive: true,
					})
				} catch (error) {
					if (error.code !== "ENOENT") throw error
				}
			}
			await cp(path.join(root, "LICENSE"), path.join(destination, "LICENSE"))
			await writeFile(
				path.join(destination, "package.json"),
				JSON.stringify(manifest, null, 2) + "\n",
			)
			const [packed] = JSON.parse(
				execFileSync(
					"npm",
					["pack", "--json", "--ignore-scripts", "--pack-destination", output],
					{ cwd: destination, encoding: "utf8" },
				),
			)
			const bytes = await readFile(path.join(output, packed.filename))
			entries.push({
				name: manifest.name,
				version,
				file: packed.filename,
				integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
			})
		}
		await writeFile(
			path.join(output, "manifest.json"),
			JSON.stringify({ revision, packages: entries }, null, 2) + "\n",
		)
		console.log(`Packed ${entries.length} SDK packages for ${revision}`)
	} finally {
		await rm(staging, { recursive: true, force: true })
	}
} else if (command === "publish") {
	const api = process.env.CI_API_V4_URL
	const project = process.env.CI_PROJECT_ID
	const token = process.env.CI_JOB_TOKEN
	if (!api || !project || !token || !/^\d+$/.test(project))
		throw new Error("The internal CI registry is required")
	const registry = new URL(`${api}/projects/${project}/packages/npm/`)
	if (registry.protocol !== "https:")
		throw new Error("The package registry must use HTTPS")
	const manifest = JSON.parse(
		await readFile(path.join(output, "manifest.json"), "utf8"),
	)
	if (manifest.revision !== revision)
		throw new Error("The SDK artifact has a different revision")
	const staging = await mkdtemp(path.join(tmpdir(), "openbot-sdk-auth-"))
	try {
		const config = path.join(staging, ".npmrc")
		await writeFile(
			config,
			`${registry.host}${registry.pathname}`.replace(/^/, "//") +
				`:_authToken=${token}\n`,
			{ mode: 0o600 },
		)
		const metadata = async (name) => {
			const response = await fetch(
				new URL(encodeURIComponent(name), registry),
				{ headers: { authorization: `Bearer ${token}` }, redirect: "error" },
			)
			if (response.status === 404) return undefined
			if (!response.ok)
				throw new Error(`The registry read failed: ${response.status}`)
			return (await response.json()).versions?.[version]
		}
		for (const entry of manifest.packages) {
			const archive = path.join(output, entry.file)
			if (
				`sha512-${createHash("sha512")
					.update(await readFile(archive))
					.digest("base64")}` !== entry.integrity
			)
				throw new Error("The SDK artifact changed after packing")
			const existing = await metadata(entry.name)
			if (existing === undefined) {
				try {
					execFileSync(
						"npm",
						[
							"publish",
							archive,
							"--registry",
							registry.toString(),
							"--ignore-scripts",
							"--tag",
							"kay",
						],
						{
							env: { ...process.env, NPM_CONFIG_USERCONFIG: config },
							stdio: "pipe",
						},
					)
				} catch {
					throw new Error(
						`SDK publication failed: ${entry.name}. Read the registry before retrying.`,
					)
				}
			}
			const published = await metadata(entry.name)
			if (typeof published?.dist?.tarball !== "string")
				throw new Error(`Published SDK is missing: ${entry.name}`)
			const tarball = new URL(published.dist.tarball)
			if (tarball.origin !== registry.origin)
				throw new Error("The registry returned an outside download URL")
			// GitLab metadata may have only a SHA-1 shasum. Check the actual archive with SHA-512.
			const downloaded = await fetch(tarball, {
				headers: { authorization: `Bearer ${token}` },
				redirect: "error",
			})
			if (
				!downloaded.ok ||
				`sha512-${createHash("sha512")
					.update(Buffer.from(await downloaded.arrayBuffer()))
					.digest("base64")}` !== entry.integrity
			)
				throw new Error(`Published SDK does not match: ${entry.name}`)
			console.log(`Published and checked ${entry.name}@${version}`)
		}
	} finally {
		await rm(staging, { recursive: true, force: true })
	}
} else throw new Error("Use pack or publish")
