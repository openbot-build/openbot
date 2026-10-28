import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { publishSource } from "./publish-source.mjs"
test("source packages are commit-pinned, verified after upload and never replaced", async () => {
	const directory = await mkdtemp(join(tmpdir(), "openbot-source-"))
	await writeFile(directory + "/source.tar.gz", "fixture-source")
	try {
		let stored = null,
			uploads = 0
		const fetcher = async (url, options) => {
			assert.match(
				url,
				/packages\/generic\/openbot-source\/[a-f0-9]{40}\/source.tar.gz$/,
			)
			assert.equal(options.headers["JOB-TOKEN"], "fixture")
			if (options.method === "PUT") {
				uploads++
				stored = options.body
				return new Response(null, { status: 201 })
			}
			return stored === null
				? new Response(null, { status: 404 })
				: new Response(stored)
		}
		const input = {
			api: "https://gitlab.example/api/v4",
			project: "202",
			commit: "a".repeat(40),
			token: "fixture",
			directory,
			fetcher,
		}
		const first = await publishSource(input)
		assert.equal(first.checksum.length, 64)
		assert.equal(uploads, 1)
		assert.deepEqual(await publishSource(input), first)
		assert.equal(uploads, 1)
		stored = Buffer.from("different-content")
		await assert.rejects(publishSource(input), /differs/)
		assert.equal(uploads, 1)
		await assert.rejects(
			publishSource({ ...input, commit: "latest" }),
			/CI commit and job token/,
		)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
