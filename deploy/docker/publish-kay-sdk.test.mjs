import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
	chmod,
	mkdtemp,
	mkdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
	checkSdkArtifacts,
	main,
	manualOptions,
	publishManual,
	publishSdk,
	readPrivateToken,
} from "../../scripts/publish-kay-sdk.mjs"

const revision = "a".repeat(40)
const version = `0.1.0-kay.g${revision.slice(0, 12)}`
const names = ["core", "domain", "protocol", "api", "client"]
const fixture = async (run) => {
	const directory = await mkdtemp(join(tmpdir(), "sdk-release-test-"))
	const tokenFile = join(directory, "token")
	await writeFile(tokenFile, "private-fixture-token\n", { mode: 0o600 })
	await mkdir(join(directory, "package"))
	const manifest = { revision, packages: [] }
	for (const name of names) {
		const file = `openbot-build-${name}-${version}.tgz`
		await writeFile(
			join(directory, "package/package.json"),
			JSON.stringify({
				name: `@openbot-build/${name}`,
				version,
				gitHead: revision,
				dependencies: name === "core" ? {} : { "@openbot-build/core": version },
			}),
		)
		execFileSync(
			"tar",
			["-czf", join(directory, file), "package/package.json"],
			{ cwd: directory },
		)
		const integrity =
			"sha512-" +
			createHash("sha512")
				.update(await readFile(join(directory, file)))
				.digest("base64")
		manifest.packages.push({
			name: `@openbot-build/${name}`,
			version,
			file,
			integrity,
		})
	}
	const writeManifest = (value = manifest) =>
		writeFile(join(directory, "manifest.json"), JSON.stringify(value))
	await writeManifest()
	const input = {
		api: "https://gitlab.example/api/v4",
		project: "202",
		revision,
		head: revision,
		tokenFile,
		operationId: "manual-sdk-1",
		directory,
	}
	const stored = new Map(),
		uploads = [],
		requests = [],
		configs = []
	const fetcher = async (value, options) => {
		const url = new URL(value)
		requests.push(url.pathname)
		assert.equal(options.redirect, "error")
		if (!url.pathname.includes("/packages/")) {
			assert.equal(options.headers["PRIVATE-TOKEN"], "private-fixture-token")
			if (url.pathname === "/api/v4/user")
				return Response.json({ id: 17, username: "release-user" })
			if (url.pathname === "/api/v4/projects/202")
				return Response.json({ id: 202 })
			if (
				url.pathname === `/api/v4/projects/202/repository/commits/${revision}`
			)
				return Response.json({ id: revision })
			throw new Error("Unexpected identity route")
		}
		assert.equal(options.headers.authorization, "Bearer private-fixture-token")
		const entry = manifest.packages.find(
			(entry) =>
				url.pathname.endsWith(encodeURIComponent(entry.name)) ||
				url.pathname.endsWith(entry.file),
		)
		assert.ok(entry, "Only known packages may be read")
		if (url.pathname.endsWith(entry.file))
			return new Response(stored.get(entry.name))
		return stored.has(entry.name)
			? Response.json({
					versions: {
						[version]: {
							dist: {
								tarball: `https://gitlab.example/api/v4/projects/202/packages/npm/files/${entry.file}`,
							},
						},
					},
				})
			: new Response(null, { status: 404 })
	}
	const publisher = async ({ archive, registry, config }) => {
		assert.equal(
			registry,
			"https://gitlab.example/api/v4/projects/202/packages/npm/",
		)
		assert.equal((await stat(config)).mode & 0o777, 0o600)
		assert.match(
			await readFile(config, "utf8"),
			/:_authToken=private-fixture-token\n$/,
		)
		configs.push(config)
		const entry = manifest.packages.find((entry) =>
			archive.endsWith(entry.file),
		)
		uploads.push(entry.name)
		stored.set(entry.name, await readFile(archive))
	}
	try {
		await run({
			input,
			manifest,
			writeManifest,
			stored,
			uploads,
			requests,
			configs,
			fetcher,
			publisher,
		})
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}

test("manual SDK publication uses a real caller, records all read backs and never replaces a version", () =>
	fixture(
		async ({
			input,
			manifest,
			stored,
			uploads,
			requests,
			configs,
			fetcher,
			publisher,
		}) => {
			const result = await publishManual({ ...input, fetcher, publisher })
			assert.equal(uploads.length, 5)
			assert.deepEqual(result.record.caller, {
				id: 17,
				username: "release-user",
			})
			assert.equal(result.record.source, "manual")
			assert.equal(result.record.status, "completed")
			assert.deepEqual(result.record.verified, manifest.packages)
			assert.deepEqual(requests.slice(0, 3), [
				"/api/v4/user",
				"/api/v4/projects/202",
				`/api/v4/projects/202/repository/commits/${revision}`,
			])
			const record = await readFile(result.recordPath, "utf8")
			assert.ok(!record.includes("private-fixture-token"))
			assert.equal((await stat(result.recordPath)).mode & 0o777, 0o600)
			for (const config of configs)
				await assert.rejects(readFile(config), { code: "ENOENT" })
			await assert.rejects(publishManual({ ...input, fetcher, publisher }), {
				code: "EEXIST",
			})
			await publishManual({
				...input,
				operationId: "manual-sdk-2",
				fetcher,
				publisher,
			})
			assert.equal(uploads.length, 5)
			stored.set(manifest.packages[0].name, Buffer.from("other bytes"))
			await assert.rejects(
				publishManual({
					...input,
					operationId: "manual-sdk-3",
					fetcher,
					publisher,
				}),
				/does not match/,
			)
			assert.equal(uploads.length, 5)
			assert.equal(
				JSON.parse(
					await readFile(
						join(input.directory, "publish-manual-sdk-3.json"),
						"utf8",
					),
				).status,
				"failed",
			)
		},
	))

test("a lost publication reply is recorded as failed and a later explicit run only reads saved packages", () =>
	fixture(async ({ input, uploads, fetcher, publisher }) => {
		await assert.rejects(
			publishManual({
				...input,
				fetcher,
				publisher: async (args) => {
					await publisher(args)
					throw new Error("lost reply")
				},
			}),
			/Read the registry before retrying/,
		)
		assert.equal(uploads.length, 1)
		assert.equal(
			JSON.parse(
				await readFile(
					join(input.directory, "publish-manual-sdk-1.json"),
					"utf8",
				),
			).status,
			"failed",
		)
		await publishManual({
			...input,
			operationId: "manual-sdk-recheck",
			fetcher,
			publisher,
		})
		assert.equal(uploads.length, 5)
	}))

test("manual parameters and CI requirements stay separate", async () => {
	const args = [
		"--api-url",
		"https://gitlab.example/api/v4",
		"--project-id",
		"202",
		"--revision",
		revision,
		"--token-file",
		"/private/token",
		"--operation-id",
		"operation-1",
	]
	assert.equal(manualOptions(args).revision, revision)
	for (const invalid of [
		args.slice(0, -2),
		[...args, "--project-id", "202"],
		[...args, "--unknown", "value"],
		args.map((value) => (value === "operation-1" ? "../escape" : value)),
		args.map((value) =>
			value === "https://gitlab.example/api/v4"
				? "https://user:secret@gitlab.example/api/v4"
				: value,
		),
	])
		assert.throws(() => manualOptions(invalid))
	await assert.rejects(main(["publish"], {}), /internal CI registry/)
	await assert.rejects(
		main(["publish"], {
			CI_API_V4_URL: "https://gitlab.example/api/v4",
			CI_PROJECT_ID: "202",
			CI_JOB_TOKEN: "fixture",
		}),
		/internal CI registry/,
	)
	await assert.rejects(
		main(["publish", "--token-file", "/private/token"], {}),
		/Use pack/,
	)
})

test("token files must be private regular files, not links", () =>
	fixture(async ({ input }) => {
		assert.equal(
			await readPrivateToken(input.tokenFile),
			"private-fixture-token",
		)
		await chmod(input.tokenFile, 0o644)
		await assert.rejects(readPrivateToken(input.tokenFile), /mode 0600/)
		await chmod(input.tokenFile, 0o600)
		const link = join(input.directory, "token-link")
		await symlink(input.tokenFile, link)
		await assert.rejects(readPrivateToken(link))
		await writeFile(input.tokenFile, "first\nsecond")
		await assert.rejects(
			readPrivateToken(input.tokenFile),
			/one registry token/,
		)
		await assert.rejects(readPrivateToken("relative-token"), /absolute/)
	}))

test("all SDK source and package identities are checked before any registry request", () =>
	fixture(async ({ input, manifest, writeManifest }) => {
		const fetcher = async () => {
			throw new Error("must not fetch")
		}
		await assert.rejects(
			publishManual({ ...input, head: "b".repeat(40), fetcher }),
			/checked out source/,
		)
		for (const changed of [
			{ ...manifest, revision: "b".repeat(40) },
			{ ...manifest, packages: manifest.packages.slice(1) },
			{
				...manifest,
				packages: manifest.packages.map((entry, index) =>
					index === 0 ? { ...entry, version: "wrong" } : entry,
				),
			},
			{
				...manifest,
				packages: manifest.packages.map((entry, index) =>
					index === 0 ? { ...entry, file: "../other.tgz" } : entry,
				),
			},
			{
				...manifest,
				packages: [
					manifest.packages[0],
					manifest.packages[0],
					...manifest.packages.slice(2),
				],
			},
		]) {
			await writeManifest(changed)
			await assert.rejects(
				publishManual({ ...input, fetcher }),
				/revision|package/,
			)
		}
		await writeManifest()
		await writeFile(
			join(input.directory, manifest.packages.at(-1).file),
			"changed archive",
		)
		await assert.rejects(
			publishManual({ ...input, fetcher }),
			/changed after packing/,
		)
	}))

test("packed npm metadata cannot publish another version under a valid archive hash", () =>
	fixture(async ({ input, manifest, writeManifest }) => {
		const entry = manifest.packages[0]
		await writeFile(
			join(input.directory, "package/package.json"),
			JSON.stringify({ name: entry.name, version: "wrong", gitHead: revision }),
		)
		execFileSync(
			"tar",
			["-czf", join(input.directory, entry.file), "package/package.json"],
			{ cwd: input.directory },
		)
		entry.integrity =
			"sha512-" +
			createHash("sha512")
				.update(await readFile(join(input.directory, entry.file)))
				.digest("base64")
		await writeManifest()
		await assert.rejects(checkSdkArtifacts(input), /packed SDK identity/)
	}))

test("manual identity and target commit must be verified before uploads", () =>
	fixture(async ({ input, fetcher, publisher, uploads }) => {
		for (const invalid of [
			"/user",
			"/projects/202",
			`/projects/202/repository/commits/${revision}`,
		]) {
			await assert.rejects(
				publishManual({
					...input,
					publisher,
					fetcher: async (url, options) =>
						String(url).endsWith(invalid)
							? new Response(null, { status: 403 })
							: fetcher(url, options),
				}),
				/identity could not be checked/,
			)
		}
		assert.equal(uploads.length, 0)
	}))

test("SDK publication rejects outside archive URLs and unverified registry reads", () =>
	fixture(async ({ input, publisher, uploads }) => {
		await assert.rejects(
			publishSdk({
				...input,
				token: "private-fixture-token",
				publisher,
				fetcher: async () => new Response(null, { status: 403 }),
			}),
			/registry read failed/,
		)
		await assert.rejects(
			publishSdk({
				...input,
				token: "private-fixture-token",
				publisher,
				fetcher: async () =>
					Response.json({
						versions: {
							[version]: {
								dist: { tarball: "https://outside.example/archive.tgz" },
							},
						},
					}),
			}),
			/outside download URL/,
		)
		assert.equal(uploads.length, 0)
	}))
