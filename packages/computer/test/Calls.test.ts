// The tests give each program its services at the edge.
// @effect-diagnostics strictEffectProvide:off
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ComputersApi } from "@openbot-build/api"
import { NodeFileSystem } from "@effect/platform-node"
import { afterAll, assert, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Calls from "../src/Calls.ts"

const home = mkdtempSync(join(tmpdir(), "openbot-computer-calls-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const options: Calls.Options = { maxOutput: 1024 * 1024, home }

const call = (
	operation: ComputersApi.ConnectorCall["operation"],
	callOptions: Calls.Options = options,
) =>
	Calls.execute({ id: "call-1", operation }, callOptions).pipe(
		Effect.provide(NodeFileSystem.layer),
	)

const done = Effect.fnUntraced(function* (
	operation: ComputersApi.ConnectorCall["operation"],
	callOptions?: Calls.Options,
) {
	const reply = yield* call(operation, callOptions)
	assert.strictEqual(reply.id, "call-1")
	if (reply.result._tag !== "Done") return assert.fail(reply.result.message)
	return reply.result.value as any
})

it.live("Run gives the exit code and the output of the command", () =>
	Effect.gen(function* () {
		const result = yield* done({
			_tag: "Run",
			request: {
				command:
					'echo out; echo err >&2; echo "$GREETING"; pwd; sh -c "exit 3"',
			},
		})
		assert.strictEqual(result.exitCode, 3)
		assert.strictEqual(result.stdout, `out\n\n${home}\n`)
		assert.strictEqual(result.stderr, "err\n")
		assert.strictEqual(result.truncated, false)
		assert.strictEqual(typeof result.durationMs, "number")
	}),
)

it.live("Run uses the folder and the variables of the request", () =>
	Effect.gen(function* () {
		const result = yield* done({
			_tag: "Run",
			request: {
				command: 'pwd; echo "$GREETING"',
				cwd: "/",
				env: { GREETING: "hello" },
			},
		})
		assert.strictEqual(result.exitCode, 0)
		assert.strictEqual(result.stdout, "/\nhello\n")
	}),
)

it.live("Run stops the command at its timeout", () =>
	Effect.gen(function* () {
		const started = Date.now()
		const result = yield* done({
			_tag: "Run",
			request: { command: "sleep 30", timeout: 1 },
		})
		assert.strictEqual(result.exitCode, null)
		assert.ok(Date.now() - started < 10_000)
	}),
)

it.live("Run keeps only the end of long output", () =>
	Effect.gen(function* () {
		const result = yield* done(
			{ _tag: "Run", request: { command: "seq 1 1000" } },
			{ ...options, maxOutput: 100 },
		)
		assert.strictEqual(result.truncated, true)
		assert.strictEqual(result.stdout.length, 100)
		assert.ok(result.stdout.endsWith("999\n1000\n"))
	}),
)

it.live("Run fails clearly when the folder does not exist", () =>
	Effect.gen(function* () {
		const reply = yield* call({
			_tag: "Run",
			request: { command: "true", cwd: "no-such-folder" },
		})
		assert.strictEqual(reply.result._tag, "Failed")
		assert.match(
			reply.result._tag === "Failed" ? reply.result.message : "",
			/does not exist/,
		)
	}),
)

it.live("Write makes missing folders, and Read gives the content back", () =>
	Effect.gen(function* () {
		assert.strictEqual(
			yield* done({
				_tag: "Write",
				file: { path: "a/b/note.txt", encoding: "utf8", content: "hello ü" },
			}),
			null,
		)
		assert.strictEqual(
			readFileSync(join(home, "a/b/note.txt"), "utf8"),
			"hello ü",
		)
		assert.deepStrictEqual(
			yield* done({ _tag: "Read", path: "a/b/note.txt", encoding: "utf8" }),
			{ path: "a/b/note.txt", encoding: "utf8", content: "hello ü" },
		)
	}),
)

it.live("Write and Read work with base64 bytes", () =>
	Effect.gen(function* () {
		const bytes = Buffer.from([0, 1, 2, 250, 255])
		const file = join(home, "bytes.bin")
		yield* done({
			_tag: "Write",
			file: {
				path: file,
				encoding: "base64",
				content: bytes.toString("base64"),
			},
		})
		assert.deepStrictEqual(readFileSync(file), bytes)
		const read = yield* done({ _tag: "Read", path: file, encoding: "base64" })
		assert.strictEqual(read.content, bytes.toString("base64"))
	}),
)

it.live("List gives the entries of a folder", () =>
	Effect.gen(function* () {
		const folder = join(home, "list")
		yield* done({
			_tag: "Write",
			file: {
				path: join(folder, "file.txt"),
				encoding: "utf8",
				content: "12345",
			},
		})
		yield* done({
			_tag: "Write",
			file: { path: join(folder, "inner/x"), encoding: "utf8", content: "" },
		})
		const entries = yield* done({ _tag: "List", path: folder })
		const byName = new Map(entries.map((entry: any) => [entry.name, entry]))
		assert.strictEqual(byName.size, 2)
		assert.strictEqual((byName.get("file.txt") as any).kind, "file")
		assert.strictEqual((byName.get("file.txt") as any).size, 5)
		assert.strictEqual((byName.get("inner") as any).kind, "directory")
	}),
)

it.live("Remove deletes a file or a folder", () =>
	Effect.gen(function* () {
		const file = join(home, "remove.txt")
		writeFileSync(file, "x")
		assert.strictEqual(yield* done({ _tag: "Remove", path: file }), null)
		assert.strictEqual(existsSync(file), false)
		yield* done({
			_tag: "Write",
			file: { path: "gone/inner/x", encoding: "utf8", content: "" },
		})
		yield* done({ _tag: "Remove", path: "gone" })
		assert.strictEqual(existsSync(join(home, "gone")), false)
	}),
)

it.live("a failed file call gives a Failed reply", () =>
	Effect.gen(function* () {
		const reply = yield* call({
			_tag: "Read",
			path: "missing.txt",
			encoding: "utf8",
		})
		assert.strictEqual(reply.id, "call-1")
		assert.strictEqual(reply.result._tag, "Failed")
	}),
)

it.live("Screenshot and Desktop say that this machine has no desktop", () =>
	Effect.gen(function* () {
		for (const operation of [
			{ _tag: "Screenshot" } as const,
			{ _tag: "Desktop", actions: [] } as const,
		]) {
			const reply = yield* call(operation)
			assert.deepStrictEqual(reply.result, {
				_tag: "Failed",
				message: "This machine has no desktop.",
			})
		}
	}),
)
