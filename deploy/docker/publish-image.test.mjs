import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { publishImage } from "./publish-image.mjs"

const commit = "a".repeat(40)
const imageId = "sha256:" + "b".repeat(64)
const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex")
const source = {
	url:
		"https://gitlab.example/api/v4/projects/202/packages/generic/openbot-source/" +
		commit +
		"/source.tar.gz",
	checksum: checksum("source"),
}
const fixture = async (run) => {
	const directory = await mkdtemp(join(tmpdir(), "openbot-image-"))
	await writeFile(directory + "/platform.tar.gz", "tested-image")
	try {
		await run({
			api: "https://gitlab.example/api/v4",
			project: "202",
			commit,
			token: "fixture",
			directory,
			imageId,
			source,
		})
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}

test("image archives and source-bound records are read back and never replaced", () =>
	fixture(async (input) => {
		const stored = new Map()
		let uploads = 0
		const fetcher = async (url, options) => {
			assert.equal(options.headers["JOB-TOKEN"], "fixture")
			assert.equal(options.redirect, "error")
			assert.match(
				url,
				new RegExp(
					"/openbot-image/" + commit + "/(platform\\.tar\\.gz|release\\.json)$",
				),
			)
			if (options.method === "PUT") {
				uploads++
				stored.set(url, Buffer.from(options.body))
				return new Response(null, { status: 201 })
			}
			return stored.has(url)
				? new Response(stored.get(url))
				: new Response(null, { status: 404 })
		}
		const first = await publishImage({ ...input, fetcher })
		assert.equal(first.archive.checksum, checksum("tested-image"))
		assert.equal(uploads, 2)
		const record = JSON.parse(stored.get(first.manifest.url).toString())
		assert.equal(record.commit, commit)
		assert.equal(record.image.id, imageId)
		assert.equal(record.image.tag, "openbot-platform:" + commit)
		assert.equal(record.image.architecture, "amd64")
		assert.equal(record.image.nodeVersion, "26.12.1")
		assert.deepEqual(record.source, source)
		assert.deepEqual(record.image.archive, first.archive)
		assert.equal(record.image.registryDigest, undefined)
		assert.deepEqual(await publishImage({ ...input, fetcher }), first)
		assert.equal(uploads, 2)
		stored.set(first.archive.url, Buffer.from("other-image"))
		await assert.rejects(publishImage({ ...input, fetcher }), /differs/)
		assert.equal(uploads, 2)
	}))

test("a successful upload is not success when downloaded bytes differ", () =>
	fixture(async (input) => {
		let uploaded = false
		await assert.rejects(
			publishImage({
				...input,
				fetcher: async (_, options) => {
					if (options.method === "PUT") {
						uploaded = true
						return new Response(null, { status: 201 })
					}
					return uploaded
						? new Response("wrong-image")
						: new Response(null, { status: 404 })
				},
			}),
			/differs/,
		)
		assert.equal(uploaded, true)
	}))

test("unverified reads, failed uploads and failed records stop publication", () =>
	fixture(async (input) => {
		await assert.rejects(
			publishImage({
				...input,
				fetcher: async () => new Response(null, { status: 403 }),
			}),
			/cannot be verified/,
		)
		await assert.rejects(
			publishImage({
				...input,
				fetcher: async (_, options) =>
					new Response(null, { status: options.method === "PUT" ? 500 : 404 }),
			}),
			/upload failed/,
		)
		await assert.rejects(
			publishImage({
				...input,
				fetcher: async (url) =>
					url.endsWith("platform.tar.gz")
						? new Response("tested-image")
						: new Response(null, { status: 500 }),
			}),
			/cannot be verified/,
		)
	}))

test("image ID and source must identify the tested commit before any upload", () =>
	fixture(async (input) => {
		const fetcher = async () => {
			throw new Error("must not fetch")
		}
		await assert.rejects(
			publishImage({ ...input, imageId: "tag:latest", fetcher }),
			/image ID/,
		)
		await assert.rejects(
			publishImage({
				...input,
				source: { ...source, url: source.url.replace(commit, "c".repeat(40)) },
				fetcher,
			}),
			/same commit/,
		)
		await assert.rejects(
			publishImage({
				...input,
				source: { ...source, checksum: "bad" },
				fetcher,
			}),
			/same commit/,
		)
	}))
