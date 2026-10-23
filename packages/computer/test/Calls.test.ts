import assert from "node:assert/strict"
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import type { ComputersApi } from "@openbot-build/api"
import { Effect } from "effect"
import * as Calls from "../src/Calls.ts"

const home = mkdtempSync(join(tmpdir(), "openbot-computer-calls-"))
after(() => rmSync(home, { recursive: true, force: true }))
const options: Calls.Options = { maxOutput: 1024 * 1024, home }

const call = (
	operation: ComputersApi.ConnectorCall["operation"],
	callOptions: Calls.Options = options,
) => Effect.runPromise(Calls.execute({ id: "call-1", operation }, callOptions))

const done = async (
	operation: ComputersApi.ConnectorCall["operation"],
	callOptions?: Calls.Options,
): Promise<any> => {
	const reply = await call(operation, callOptions)
	assert.equal(reply.id, "call-1")
	if (reply.result._tag !== "Done") assert.fail(reply.result.message)
	return reply.result.value
}

test("Run gives the exit code and the output of the command", async () => {
	const result = await done({
		_tag: "Run",
		request: {
			command: 'echo out; echo err >&2; echo "$GREETING"; pwd; sh -c "exit 3"',
		},
	})
	assert.equal(result.exitCode, 3)
	assert.equal(result.stdout, `out\n\n${home}\n`)
	assert.equal(result.stderr, "err\n")
	assert.equal(result.truncated, false)
	assert.equal(typeof result.durationMs, "number")
})

test("Run uses the folder and the variables of the request", async () => {
	const result = await done({
		_tag: "Run",
		request: {
			command: 'pwd; echo "$GREETING"',
			cwd: "/",
			env: { GREETING: "hello" },
		},
	})
	assert.equal(result.exitCode, 0)
	assert.equal(result.stdout, "/\nhello\n")
})

test("Run stops the command at its timeout", async () => {
	const started = Date.now()
	const result = await done({
		_tag: "Run",
		request: { command: "sleep 30", timeout: 1 },
	})
	assert.equal(result.exitCode, null)
	assert.ok(Date.now() - started < 10_000)
})

test("Run keeps only the end of long output", async () => {
	const result = await done(
		{ _tag: "Run", request: { command: "seq 1 1000" } },
		{ ...options, maxOutput: 100 },
	)
	assert.equal(result.truncated, true)
	assert.equal(result.stdout.length, 100)
	assert.ok(result.stdout.endsWith("999\n1000\n"))
})

test("Run fails clearly when the folder does not exist", async () => {
	const reply = await call({
		_tag: "Run",
		request: { command: "true", cwd: "no-such-folder" },
	})
	assert.equal(reply.result._tag, "Failed")
	assert.match(
		reply.result._tag === "Failed" ? reply.result.message : "",
		/does not exist/,
	)
})

test("Write makes missing folders, and Read gives the content back", async () => {
	assert.equal(
		await done({
			_tag: "Write",
			file: { path: "a/b/note.txt", encoding: "utf8", content: "hello ü" },
		}),
		null,
	)
	assert.equal(readFileSync(join(home, "a/b/note.txt"), "utf8"), "hello ü")
	assert.deepEqual(
		await done({ _tag: "Read", path: "a/b/note.txt", encoding: "utf8" }),
		{ path: "a/b/note.txt", encoding: "utf8", content: "hello ü" },
	)
})

test("Write and Read work with base64 bytes", async () => {
	const bytes = Buffer.from([0, 1, 2, 250, 255])
	const file = join(home, "bytes.bin")
	await done({
		_tag: "Write",
		file: { path: file, encoding: "base64", content: bytes.toString("base64") },
	})
	assert.deepEqual(readFileSync(file), bytes)
	const read = await done({ _tag: "Read", path: file, encoding: "base64" })
	assert.equal(read.content, bytes.toString("base64"))
})

test("List gives the entries of a folder", async () => {
	const folder = join(home, "list")
	await done({
		_tag: "Write",
		file: {
			path: join(folder, "file.txt"),
			encoding: "utf8",
			content: "12345",
		},
	})
	await done({
		_tag: "Write",
		file: { path: join(folder, "inner/x"), encoding: "utf8", content: "" },
	})
	const entries = await done({ _tag: "List", path: folder })
	const byName = new Map(entries.map((entry: any) => [entry.name, entry]))
	assert.equal(byName.size, 2)
	assert.equal((byName.get("file.txt") as any).kind, "file")
	assert.equal((byName.get("file.txt") as any).size, 5)
	assert.equal((byName.get("inner") as any).kind, "directory")
})

test("Remove deletes a file or a folder", async () => {
	const file = join(home, "remove.txt")
	writeFileSync(file, "x")
	assert.equal(await done({ _tag: "Remove", path: file }), null)
	assert.equal(existsSync(file), false)
	await done({
		_tag: "Write",
		file: { path: "gone/inner/x", encoding: "utf8", content: "" },
	})
	await done({ _tag: "Remove", path: "gone" })
	assert.equal(existsSync(join(home, "gone")), false)
})

test("a failed file call gives a Failed reply", async () => {
	const reply = await call({
		_tag: "Read",
		path: "missing.txt",
		encoding: "utf8",
	})
	assert.equal(reply.id, "call-1")
	assert.equal(reply.result._tag, "Failed")
})

test("Screenshot and Desktop say that this machine has no desktop", async () => {
	for (const operation of [
		{ _tag: "Screenshot" } as const,
		{ _tag: "Desktop", actions: [] } as const,
	]) {
		const reply = await call(operation)
		assert.deepEqual(reply.result, {
			_tag: "Failed",
			message: "This machine has no desktop.",
		})
	}
})
