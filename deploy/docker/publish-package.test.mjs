import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { publishPackageFile } from "./publish-package.mjs"

test("a manual generic package uses PRIVATE-TOKEN for upload and read back", async () => {
	const directory = await mkdtemp(join(tmpdir(), "openbot-private-package-"))
	try {
		await writeFile(join(directory, "source.tar.gz"), "source")
		let stored,
			uploads = 0
		const options = {
			api: "https://gitlab.example/api/v4",
			project: "202",
			commit: "a".repeat(40),
			token: "private-fixture",
			tokenHeader: "PRIVATE-TOKEN",
			directory,
			packageName: "openbot-source",
			fileName: "source.tar.gz",
			fetcher: async (_, options) => {
				assert.deepEqual(options.headers, {
					"PRIVATE-TOKEN": "private-fixture",
				})
				assert.equal(options.redirect, "error")
				if (options.method === "PUT") {
					uploads++
					stored = options.body
					return new Response(null, { status: 201 })
				}
				return stored
					? new Response(stored)
					: new Response(null, { status: 404 })
			},
		}
		const result = await publishPackageFile(options)
		assert.equal(result.checksum.length, 64)
		await publishPackageFile(options)
		assert.equal(uploads, 1)
		await assert.rejects(
			publishPackageFile({ ...options, tokenHeader: "Authorization" }),
			/known GitLab token header/,
		)
		stored = Buffer.from("different bytes")
		await assert.rejects(publishPackageFile(options), /differs/)
		assert.equal(uploads, 1)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
