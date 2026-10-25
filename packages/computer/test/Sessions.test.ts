// The tests give each program its services at the edge.
// @effect-diagnostics strictEffectProvide:off
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ComputersApi } from "@openbot-build/api"
import { NodeFileSystem } from "@effect/platform-node"
import { afterAll, assert, it } from "@effect/vitest"
import { Effect, Queue } from "effect"
import * as Sessions from "../src/Sessions.ts"

const home = mkdtempSync(join(tmpdir(), "openbot-computer-sessions-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))

type Sent = Extract<
	ComputersApi.FromConnector,
	{ readonly _tag: "Output" | "Exit" }
>
type Exit = Extract<Sent, { readonly _tag: "Exit" }>

/**
 * Makes the sessions of one connection, and keeps what they send. `read` takes the
 * output of a session until the text matches, or until the session ends.
 */
const harness = (maxFrame = Sessions.defaultFrame) =>
	Effect.gen(function* () {
		const sent = yield* Queue.unbounded<Sent>()
		const sessions = yield* Sessions.make({ home, maxFrame }, (message) =>
			Queue.offer(sent, message),
		)
		const all: Array<Sent> = []
		const read = Effect.fnUntraced(function* (until?: RegExp) {
			let text = ""
			while (true) {
				const message = yield* Queue.take(sent)
				all.push(message)
				if (message._tag === "Exit") return { text, exit: message }
				text += Buffer.from(message.data, "base64").toString("utf8")
				if (until !== undefined && until.test(text))
					return { text, exit: undefined }
			}
		})
		const input = (session: string, text: string) =>
			sessions.handle({
				_tag: "Input",
				session,
				data: Buffer.from(text, "utf8").toString("base64"),
			})
		return { sessions, read, input, all }
	}).pipe(Effect.provide(NodeFileSystem.layer))

const exitOf = (result: { readonly exit: Exit | undefined }): Exit => {
	if (result.exit === undefined) return assert.fail("The session did not end.")
	return result.exit
}

it.live("Start runs a command, sends its output in order, and then Exit", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const { sessions, read, all } = yield* harness()
			yield* sessions.handle({
				_tag: "Start",
				session: "s-1",
				command:
					'echo out; echo err >&2; pwd; echo "$GREETING"; sh -c "exit 3"',
				cwd: "/",
				env: { GREETING: "hello" },
				tty: false,
			})
			const result = yield* read()
			assert.strictEqual(
				result.text.split("\n").sort().join("\n"),
				["", "/", "err", "hello", "out"].join("\n"),
			)
			assert.deepStrictEqual(exitOf(result), {
				_tag: "Exit",
				session: "s-1",
				code: 3,
				signal: null,
			})
			assert.deepStrictEqual(
				all.flatMap((message) =>
					message._tag === "Output" ? [message.seq] : [],
				),
				all.slice(0, -1).map((_, index) => index),
			)
		}),
	),
)

it.live("Input goes to stdin, and Ctrl-D closes stdin without a terminal", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const { sessions, read, input } = yield* harness()
			yield* sessions.handle({
				_tag: "Start",
				session: "cat",
				command: "cat",
				tty: false,
			})
			yield* input("cat", "hello\n")
			assert.strictEqual((yield* read(/hello\n/)).text, "hello\n")
			yield* input("cat", "last\n\x04")
			const result = yield* read()
			assert.strictEqual(result.text, "last\n")
			assert.strictEqual(exitOf(result).code, 0)
		}),
	),
)

it.live("Signal and Close stop the command and its children", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const { sessions, read } = yield* harness()
			yield* sessions.handle({
				_tag: "Start",
				session: "sleep",
				command: "sleep 30 & echo started; wait",
				tty: false,
			})
			yield* read(/started/)
			yield* sessions.handle({
				_tag: "Signal",
				session: "sleep",
				signal: "SIGTERM",
			})
			assert.strictEqual(exitOf(yield* read()).signal, "SIGTERM")

			yield* sessions.handle({
				_tag: "Start",
				session: "close",
				command: "sleep 30",
				tty: false,
			})
			yield* sessions.handle({ _tag: "Close", session: "close" })
			const closed = exitOf(yield* read())
			assert.strictEqual(closed.session, "close")
			assert.strictEqual(closed.code, null)
			assert.strictEqual(closed.signal, "SIGKILL")
		}),
	),
)

it.live("Start gives a clear Exit when the folder does not exist", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const { sessions, read } = yield* harness()
			yield* sessions.handle({
				_tag: "Start",
				session: "s-1",
				command: "true",
				cwd: "no-such-folder",
				tty: false,
			})
			const exit = exitOf(yield* read())
			assert.strictEqual(exit.code, null)
			assert.match(exit.error ?? "", /does not exist/)
		}),
	),
)

it.live("long output comes in frames of the most bytes", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const { sessions, read, all } = yield* harness(100)
			yield* sessions.handle({
				_tag: "Start",
				session: "seq",
				command: "seq 1 1000",
				tty: false,
			})
			const result = yield* read()
			assert.ok(result.text.endsWith("999\n1000\n"))
			for (const message of all)
				if (message._tag === "Output")
					assert.ok(Buffer.from(message.data, "base64").length <= 100)
		}),
	),
)

it.live("tty gives the command a terminal of the right size", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const { sessions, read } = yield* harness()
			yield* sessions.handle({
				_tag: "Start",
				session: "tty",
				command: "tty; stty size",
				tty: true,
				rows: 30,
				cols: 100,
			})
			const result = yield* read()
			assert.match(result.text, /^\/dev\/\S+\r\n30 100\r\n$/)
			assert.strictEqual(exitOf(result).code, 0)
		}),
	),
)

it.live("Resize changes the size of the terminal", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const { sessions, read, input } = yield* harness()
			yield* sessions.handle({
				_tag: "Start",
				session: "tty",
				command: "read line; stty size",
				tty: true,
			})
			yield* sessions.handle({
				_tag: "Resize",
				session: "tty",
				rows: 50,
				cols: 120,
			})
			yield* input("tty", "go\r")
			assert.match((yield* read()).text, /50 120\r\n$/)
		}),
	),
)

it.live(
	"Ctrl-D on a terminal ends the input of cat, and Ctrl-C stops a command",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const { sessions, read, input } = yield* harness()
				yield* sessions.handle({
					_tag: "Start",
					session: "cat",
					command: "cat",
					tty: true,
				})
				yield* input("cat", "hello\r")
				// The terminal shows the input, and then cat writes it again.
				assert.match((yield* read(/hello\r\nhello\r\n/)).text, /hello/)
				yield* input("cat", "\x04")
				assert.strictEqual(exitOf(yield* read()).code, 0)

				yield* sessions.handle({
					_tag: "Start",
					session: "sleep",
					command: "echo started; sleep 30",
					tty: true,
				})
				yield* read(/started/)
				yield* input("sleep", "\x03")
				const exit = exitOf(yield* read())
				assert.notStrictEqual(exit.code, 0)
			}),
		),
)

it.live("closing the scope stops all sessions", () =>
	Effect.gen(function* () {
		const marker = join(home, "pid")
		yield* Effect.scoped(
			Effect.gen(function* () {
				const { sessions, read } = yield* harness()
				yield* sessions.handle({
					_tag: "Start",
					session: "a",
					command: `echo $$ > ${marker}; echo started; sleep 30`,
					tty: false,
				})
				yield* read(/started/)
			}),
		)
		const pid = Number(readFileSync(marker, "utf8"))
		yield* Effect.sleep(200)
		assert.throws(() => process.kill(pid, 0))
	}),
)
