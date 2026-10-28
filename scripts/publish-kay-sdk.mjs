import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { constants } from "node:fs"
import {
	cp,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
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
const sourceRevision = () =>
	execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim()
const checkedRevision = (revision) => {
	if (typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision))
		throw new Error("A full source revision is required")
	return revision
}
const sdkVersion = (revision) =>
	`0.1.0-kay.g${checkedRevision(revision).slice(0, 12)}`

export async function packSdk(revision) {
	const version = sdkVersion(revision)
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
}

const registryFor = (api, project) => {
	if (typeof project !== "string" || !/^\d+$/.test(project))
		throw new Error("A GitLab project ID is required")
	const base = new URL(api)
	if (
		base.protocol !== "https:" ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		!/^\/api\/v4\/?$/.test(base.pathname)
	)
		throw new Error("Use the HTTPS GitLab API")
	return new URL(`${base.origin}/api/v4/projects/${project}/packages/npm/`)
}
const digest = (bytes) =>
	`sha512-${createHash("sha512").update(bytes).digest("base64")}`

/** Check all files before the first upload, including the name and version npm uses. */
export async function checkSdkArtifacts({ directory, revision }) {
	const version = sdkVersion(revision)
	const manifest = JSON.parse(
		await readFile(path.join(directory, "manifest.json"), "utf8"),
	)
	if (manifest.revision !== revision)
		throw new Error("The SDK artifact has a different revision")
	if (
		!Array.isArray(manifest.packages) ||
		manifest.packages.length !== packages.length
	)
		throw new Error("The complete SDK package set is required")
	const names = new Set()
	for (const entry of manifest.packages) {
		const name = packages.find(
			(name) => entry.name === `@openbot-build/${name}`,
		)
		if (
			!name ||
			names.has(entry.name) ||
			entry.version !== version ||
			entry.file !== `openbot-build-${name}-${version}.tgz`
		)
			throw new Error("The SDK package identity does not match the release")
		names.add(entry.name)
		const archive = path.join(directory, entry.file)
		const bytes = await readFile(archive)
		if (digest(bytes) !== entry.integrity)
			throw new Error("The SDK artifact changed after packing")
		const packed = JSON.parse(
			execFileSync("tar", ["-xOf", archive, "package/package.json"], {
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
			}),
		)
		if (
			packed.name !== entry.name ||
			packed.version !== version ||
			packed.gitHead !== revision
		)
			throw new Error("The packed SDK identity does not match the release")
		for (const group of [
			"dependencies",
			"optionalDependencies",
			"peerDependencies",
		]) {
			for (const [dependency, range] of Object.entries(packed[group] ?? {})) {
				if (
					range.startsWith("workspace:") ||
					(packages.some((name) => dependency === `@openbot-build/${name}`) &&
						range !== version)
				)
					throw new Error(
						"The packed SDK dependency does not match the release",
					)
			}
		}
	}
	return manifest
}

/** The CI and manual commands use the same write-once publication and read-back check. */
export async function publishSdk({
	api,
	project,
	revision,
	token,
	directory = output,
	fetcher = fetch,
	publisher,
	onVerified = async () => {},
}) {
	const registry = registryFor(api, project)
	const version = sdkVersion(revision)
	if (typeof token !== "string" || !token || /[\r\n]/.test(token))
		throw new Error("A registry token is required")
	const manifest = await checkSdkArtifacts({ directory, revision })
	const staging = await mkdtemp(path.join(tmpdir(), "openbot-sdk-auth-"))
	try {
		const config = path.join(staging, ".npmrc")
		await writeFile(
			config,
			`//${registry.host}${registry.pathname}:_authToken=${token}\n`,
			{ mode: 0o600 },
		)
		const metadata = async (name) => {
			const response = await fetcher(
				new URL(encodeURIComponent(name), registry),
				{
					headers: { authorization: `Bearer ${token}` },
					redirect: "error",
					signal: AbortSignal.timeout(60000),
				},
			)
			if (response.status === 404) return undefined
			if (!response.ok)
				throw new Error(`The registry read failed: ${response.status}`)
			return (await response.json()).versions?.[version]
		}
		for (const entry of manifest.packages) {
			const archive = path.join(directory, entry.file)
			if (digest(await readFile(archive)) !== entry.integrity)
				throw new Error("The SDK artifact changed after packing")
			const existing = await metadata(entry.name)
			if (existing === undefined) {
				try {
					if (publisher)
						await publisher({ archive, registry: registry.toString(), config })
					else
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
			if (
				tarball.origin !== registry.origin ||
				tarball.username ||
				tarball.password
			)
				throw new Error("The registry returned an outside download URL")
			const downloaded = await fetcher(tarball, {
				headers: { authorization: `Bearer ${token}` },
				redirect: "error",
				signal: AbortSignal.timeout(60000),
			})
			if (
				!downloaded.ok ||
				digest(Buffer.from(await downloaded.arrayBuffer())) !== entry.integrity
			)
				throw new Error(`Published SDK does not match: ${entry.name}`)
			await onVerified(entry)
			console.log(`Published and checked ${entry.name}@${version}`)
		}
		return manifest
	} finally {
		await rm(staging, { recursive: true, force: true })
	}
}

export async function readPrivateToken(file) {
	if (!path.isAbsolute(file)) throw new Error("Use an absolute token file path")
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
	try {
		const info = await handle.stat()
		if (
			!info.isFile() ||
			(info.mode & 0o777) !== 0o600 ||
			info.uid !== process.getuid() ||
			info.size > 16384
		)
			throw new Error(
				"The token file must belong to this user and have mode 0600",
			)
		const token = (await handle.readFile("utf8")).trim()
		if (!token || /\s/.test(token))
			throw new Error("The token file must contain one registry token")
		return token
	} finally {
		await handle.close()
	}
}

export function manualOptions(args) {
	const keys = new Set([
		"api-url",
		"project-id",
		"revision",
		"token-file",
		"operation-id",
	])
	const values = {}
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index]?.slice(2)
		if (
			!args[index]?.startsWith("--") ||
			!keys.has(key) ||
			values[key] !== undefined ||
			!args[index + 1] ||
			args[index + 1].startsWith("--")
		)
			throw new Error("Use each manual publication option exactly once")
		values[key] = args[index + 1]
	}
	if (Object.keys(values).length !== keys.size)
		throw new Error(
			"Supply api-url, project-id, revision, token-file and operation-id",
		)
	registryFor(values["api-url"], values["project-id"])
	checkedRevision(values.revision)
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(values["operation-id"]))
		throw new Error("Use a plain publication operation ID")
	return {
		api: values["api-url"],
		project: values["project-id"],
		revision: values.revision,
		tokenFile: values["token-file"],
		operationId: values["operation-id"],
	}
}

/** A local publication records the real GitLab user; it never creates CI identity. */
export async function publishManual({
	api,
	project,
	revision,
	tokenFile,
	operationId,
	directory = output,
	head = sourceRevision(),
	fetcher = fetch,
	publisher,
}) {
	if (checkedRevision(revision) !== head)
		throw new Error("The checked out source does not match the release")
	registryFor(api, project)
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(operationId))
		throw new Error("Use a plain publication operation ID")
	await checkSdkArtifacts({ directory, revision })
	const token = await readPrivateToken(tokenFile)
	const base = api.replace(/\/$/, "")
	const read = async (suffix) => {
		const response = await fetcher(base + suffix, {
			headers: { "PRIVATE-TOKEN": token },
			redirect: "error",
			signal: AbortSignal.timeout(60000),
		})
		if (!response.ok)
			throw new Error(
				`The manual publication identity could not be checked: ${response.status}`,
			)
		return response.json()
	}
	const caller = await read("/user")
	if (
		!Number.isSafeInteger(caller.id) ||
		caller.id <= 0 ||
		typeof caller.username !== "string" ||
		!caller.username
	)
		throw new Error("GitLab did not return a user identity")
	const target = await read(`/projects/${project}`)
	if (String(target.id) !== project)
		throw new Error("GitLab returned a different project")
	const commit = await read(
		`/projects/${project}/repository/commits/${revision}`,
	)
	if (commit.id !== revision)
		throw new Error("The source commit is not in the target project")
	const recordPath = path.join(directory, `publish-${operationId}.json`)
	let record = {
		version: 1,
		source: "manual",
		operationId,
		api: base,
		project,
		revision,
		caller: { id: caller.id, username: caller.username },
		startedAt: new Date().toISOString(),
		status: "running",
		verified: [],
	}
	await writeFile(recordPath, JSON.stringify(record, null, 2) + "\n", {
		mode: 0o600,
		flag: "wx",
	})
	const save = async (change) => {
		record = { ...record, ...change }
		const next = recordPath + ".tmp"
		await writeFile(next, JSON.stringify(record, null, 2) + "\n", {
			mode: 0o600,
			flag: "wx",
		})
		await rename(next, recordPath)
	}
	try {
		await publishSdk({
			api,
			project,
			revision,
			token,
			directory,
			fetcher,
			publisher,
			onVerified: async (entry) =>
				save({ verified: [...record.verified, entry] }),
		})
		await save({ status: "completed", finishedAt: new Date().toISOString() })
	} catch (error) {
		await save({
			status: "failed",
			finishedAt: new Date().toISOString(),
		}).catch(() => {})
		throw error
	}
	return { recordPath, record }
}

export async function main(args = process.argv.slice(2), env = process.env) {
	const [command, ...options] = args
	if (command === "pack" && options.length === 0)
		return packSdk(checkedRevision(env.CI_COMMIT_SHA ?? sourceRevision()))
	if (command === "publish" && options.length === 0) {
		const {
			CI_API_V4_URL: api,
			CI_PROJECT_ID: project,
			CI_JOB_TOKEN: token,
			CI_COMMIT_SHA: revision,
		} = env
		if (!api || !project || !token || !revision)
			throw new Error("The internal CI registry is required")
		return publishSdk({ api, project, revision, token })
	}
	if (command === "publish-manual") return publishManual(manualOptions(options))
	throw new Error("Use pack, publish, or publish-manual with explicit options")
}

if (import.meta.main) await main()
