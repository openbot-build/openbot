import { NodeServices } from "@effect/platform-node"
import { ComputersApi } from "@openbot-build/api"
import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	Context,
	Effect,
	FileSystem,
	Latch,
	Layer,
	Order,
	Path,
	Queue,
	Ref,
	Schedule,
	String as Str,
} from "effect"
import { Base64 } from "effect/encoding"
import * as Sessions from "../src/Sessions.ts"

/** Where the commands run when a session gives no folder. All tests in this file share it. */
class Home extends Context.Service<Home, string>()(
	"@openbot-build/computer/test/Sessions.test/Home",
) {}

const home = Layer.effect(
	Home,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.makeTempDirectoryScoped({
			prefix: "openbot-computer-sessions-",
		})
	}),
).pipe(Layer.provideMerge(NodeServices.layer))

type Sent = Extract<
	ComputersApi.FromConnector,
	{ readonly _tag: "Output" | "Exit" }
>
type Exit = Extract<Sent, { readonly _tag: "Exit" }>

/**
 * Makes the sessions of one connection, and keeps what they send. `read` takes the
 * output of a session until the text matches, or until the session ends. `all` gives
 * every message that `read` took. `beforeSend` runs before each message is sent, so a
 * test can make sending slow.
 */
const harness = Effect.fnUntraced(function* (options?: {
	readonly maxFrame?: number
	readonly highWaterMark?: number
	readonly beforeSend?: Effect.Effect<void>
}) {
	const sent = yield* Queue.unbounded<Sent>()
	const sessions = yield* Sessions.make(
		{
			home: yield* Home,
			maxFrame: options?.maxFrame ?? Sessions.defaultFrame,
			highWaterMark: options?.highWaterMark ?? Sessions.defaultHighWaterMark,
		},
		(message) =>
			Effect.andThen(
				options?.beforeSend ?? Effect.void,
				Queue.offer(sent, message),
			),
	)
	const taken = yield* Ref.make<ReadonlyArray<Sent>>([])
	const read = Effect.fnUntraced(function* (until?: RegExp) {
		let text = ""
		while (true) {
			const message = yield* Queue.take(sent)
			yield* Ref.update(taken, Arr.append(message))
			if (message._tag === "Exit") return { text, exit: message }
			text += yield* Effect.fromResult(Base64.decodeString(message.data))
			if (until !== undefined && until.test(text))
				return { text, exit: undefined }
		}
	})
	const input = (session: string, text: string) =>
		sessions.handle({
			_tag: "Input",
			session: ComputersApi.ConnectorSessionId.make(session),
			data: Base64.encode(text),
		})
	return { sessions, read, input, all: Ref.get(taken) }
})

const exitOf = (result: { readonly exit: Exit | undefined }): Exit => {
	if (result.exit === undefined) return assert.fail("The session did not end.")
	return result.exit
}

layer(home, { excludeTestServices: true })((it) => {
	it.effect(
		"Start runs a command, sends its output in order, and then Exit",
		() =>
			Effect.gen(function* () {
				const { sessions, read, all } = yield* harness()
				yield* sessions.handle({
					_tag: "Start",
					session: ComputersApi.ConnectorSessionId.make("s-1"),
					command:
						'echo out; echo err >&2; pwd; echo "$GREETING"; sh -c "exit 3"',
					cwd: "/",
					env: { GREETING: "hello" },
					tty: false,
				})
				const result = yield* read()
				assert.deepStrictEqual(
					Arr.sort(Str.split(result.text, "\n"), Order.String),
					["", "/", "err", "hello", "out"],
				)
				assert.deepStrictEqual(exitOf(result), {
					_tag: "Exit",
					session: ComputersApi.ConnectorSessionId.make("s-1"),
					code: 3,
					signal: null,
				})
				const messages = yield* all
				assert.deepStrictEqual(
					Arr.flatMap(messages, (message) =>
						message._tag === "Output" ? [message.seq] : [],
					),
					Arr.map(Arr.dropRight(messages, 1), (_, index) => index),
				)
			}),
	)

	it.effect(
		"Input goes to stdin, and Ctrl-D closes stdin without a terminal",
		() =>
			Effect.gen(function* () {
				const { sessions, read, input } = yield* harness()
				yield* sessions.handle({
					_tag: "Start",
					session: ComputersApi.ConnectorSessionId.make("cat"),
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
	)

	it.effect("Signal and Close stop the command and its children", () =>
		Effect.gen(function* () {
			const { sessions, read } = yield* harness()
			yield* sessions.handle({
				_tag: "Start",
				session: ComputersApi.ConnectorSessionId.make("sleep"),
				command: "sleep 30 & echo started; wait",
				tty: false,
			})
			yield* read(/started/)
			yield* sessions.handle({
				_tag: "Signal",
				session: ComputersApi.ConnectorSessionId.make("sleep"),
				signal: "SIGTERM",
			})
			assert.strictEqual(exitOf(yield* read()).signal, "SIGTERM")

			yield* sessions.handle({
				_tag: "Start",
				session: ComputersApi.ConnectorSessionId.make("close"),
				command: "sleep 30",
				tty: false,
			})
			yield* sessions.handle({
				_tag: "Close",
				session: ComputersApi.ConnectorSessionId.make("close"),
			})
			const closed = exitOf(yield* read())
			assert.strictEqual(closed.session, "close")
			assert.strictEqual(closed.code, null)
			assert.strictEqual(closed.signal, "SIGKILL")
		}),
	)

	it.effect("Start gives a clear Exit when the folder does not exist", () =>
		Effect.gen(function* () {
			const { sessions, read } = yield* harness()
			yield* sessions.handle({
				_tag: "Start",
				session: ComputersApi.ConnectorSessionId.make("s-1"),
				command: "true",
				cwd: "no-such-folder",
				tty: false,
			})
			const exit = exitOf(yield* read())
			assert.strictEqual(exit.code, null)
			assert.match(exit.error ?? "", /does not exist/)
		}),
	)

	it.effect("Start says why it cannot open the folder", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const file = path.join(yield* Home, "plain-file")
			yield* fs.writeFileString(file, "")
			const { sessions, read } = yield* harness()
			yield* sessions.handle({
				_tag: "Start",
				session: ComputersApi.ConnectorSessionId.make("s-1"),
				command: "true",
				cwd: "plain-file/inner",
				tty: false,
			})
			const exit = exitOf(yield* read())
			assert.strictEqual(exit.code, null)
			assert.match(
				exit.error ?? "",
				new RegExp(`^Could not open the folder ${file}/inner: `),
			)
		}),
	)

	it.effect("Start gives a clear Exit when the command cannot start", () =>
		Effect.gen(function* () {
			const { sessions, read } = yield* harness()
			yield* sessions.handle({
				_tag: "Start",
				session: ComputersApi.ConnectorSessionId.make("s-1"),
				command: "true",
				env: { BROKEN: "a\u0000b" },
				tty: false,
			})
			const exit = exitOf(yield* read())
			assert.strictEqual(exit.code, null)
			assert.match(
				exit.error ?? "",
				/^The command could not start: .*null bytes/,
			)
		}),
	)

	it.effect(
		"when send is slow, the command waits, and all output and then Exit still come in order",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const marker = path.join(yield* Home, "slow-done")
				const gate = yield* Latch.make(false)
				const { sessions, read, all } = yield* harness({
					highWaterMark: 64 * 1024,
					beforeSend: Latch.await(gate),
				})
				yield* sessions.handle({
					_tag: "Start",
					session: ComputersApi.ConnectorSessionId.make("slow"),
					command: `seq 1 300000; touch ${marker}`,
					tty: false,
				})
				// The output is about 2 MB. Nothing is sent, so the command must wait on its
				// full pipe and not end. This checks that something does not happen, so it
				// waits a fixed time.
				yield* Effect.sleep("500 millis")
				assert.isFalse(yield* fs.exists(marker))

				yield* Latch.open(gate)
				const result = yield* read()
				assert.strictEqual(
					result.text,
					Arr.join(
						Arr.map(Arr.range(1, 300000), (n) => `${n}\n`),
						"",
					),
				)
				assert.strictEqual(exitOf(result).code, 0)
				assert.isTrue(yield* fs.exists(marker))
				const messages = yield* all
				assert.deepStrictEqual(
					Arr.flatMap(messages, (message) =>
						message._tag === "Output" ? [message.seq] : [],
					),
					Arr.map(Arr.dropRight(messages, 1), (_, index) => index),
				)
			}),
	)

	it.effect(
		"a terminal command that ends while it is paused still sends all its output",
		() =>
			Effect.gen(function* () {
				const gate = yield* Latch.make(false)
				const { sessions, read } = yield* harness({
					highWaterMark: 1024,
					beforeSend: Latch.await(gate),
				})
				yield* sessions.handle({
					_tag: "Start",
					session: ComputersApi.ConnectorSessionId.make("tty"),
					command: "seq 1 3000",
					tty: true,
				})
				// The output fits in the buffers of the terminal, so the command ends while
				// it is paused. node-pty drops output that nobody reads 200 ms after the end,
				// so this waits longer than that before anything is sent.
				yield* Effect.sleep("500 millis")
				yield* Latch.open(gate)
				const result = yield* read()
				assert.strictEqual(
					result.text,
					Arr.join(
						Arr.map(Arr.range(1, 3000), (n) => `${n}\r\n`),
						"",
					),
				)
				assert.strictEqual(exitOf(result).code, 0)
			}),
	)

	it.effect("long output comes in frames of the most bytes", () =>
		Effect.gen(function* () {
			const { sessions, read, all } = yield* harness({ maxFrame: 100 })
			yield* sessions.handle({
				_tag: "Start",
				session: ComputersApi.ConnectorSessionId.make("seq"),
				command: "seq 1 1000",
				tty: false,
			})
			const result = yield* read()
			assert.strictEqual(
				result.text,
				Arr.join(
					Arr.map(Arr.range(1, 1000), (n) => `${n}\n`),
					"",
				),
			)
			assert.strictEqual(exitOf(result).code, 0)
			for (const message of yield* all)
				if (message._tag === "Output")
					assert.ok(
						(yield* Effect.fromResult(Base64.decode(message.data))).length <=
							100,
					)
		}),
	)

	it.effect("tty gives the command a terminal of the right size", () =>
		Effect.gen(function* () {
			const { sessions, read } = yield* harness()
			yield* sessions.handle({
				_tag: "Start",
				session: ComputersApi.ConnectorSessionId.make("tty"),
				command: "tty; stty size",
				tty: true,
				rows: 30,
				cols: 100,
			})
			const result = yield* read()
			assert.match(result.text, /^\/dev\/\S+\r\n30 100\r\n$/)
			assert.strictEqual(exitOf(result).code, 0)
		}),
	)

	it.effect("Resize changes the size of the terminal", () =>
		Effect.gen(function* () {
			const { sessions, read, input } = yield* harness()
			yield* sessions.handle({
				_tag: "Start",
				session: ComputersApi.ConnectorSessionId.make("tty"),
				command: "read line; stty size",
				tty: true,
			})
			yield* sessions.handle({
				_tag: "Resize",
				session: ComputersApi.ConnectorSessionId.make("tty"),
				rows: 50,
				cols: 120,
			})
			yield* input("tty", "go\r")
			assert.match((yield* read()).text, /50 120\r\n$/)
		}),
	)

	it.effect(
		"Ctrl-D on a terminal ends the input of cat, and Ctrl-C stops a command",
		() =>
			Effect.gen(function* () {
				const { sessions, read, input } = yield* harness()
				yield* sessions.handle({
					_tag: "Start",
					session: ComputersApi.ConnectorSessionId.make("cat"),
					command: "cat",
					tty: true,
				})
				yield* input("cat", "hello\r")
				// The terminal shows the input, and then cat writes it again.
				const echoed = yield* read(/hello\r\nhello\r\n/)
				assert.strictEqual(echoed.exit, undefined)
				assert.match(echoed.text, /hello\r\nhello\r\n/)
				yield* input("cat", "\x04")
				assert.strictEqual(exitOf(yield* read()).code, 0)

				yield* sessions.handle({
					_tag: "Start",
					session: ComputersApi.ConnectorSessionId.make("sleep"),
					command: "echo started; sleep 30",
					tty: true,
				})
				yield* read(/started/)
				yield* input("sleep", "\x03")
				assert.deepStrictEqual(exitOf(yield* read()), {
					_tag: "Exit",
					session: ComputersApi.ConnectorSessionId.make("sleep"),
					code: null,
					signal: "SIGINT",
				})
			}),
	)

	it.effect("closing the scope stops all sessions", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const marker = path.join(yield* Home, "pid")
			yield* Effect.scoped(
				Effect.gen(function* () {
					const { sessions, read } = yield* harness()
					yield* sessions.handle({
						_tag: "Start",
						session: ComputersApi.ConnectorSessionId.make("a"),
						command: `echo $$ > ${marker}; echo started; sleep 30`,
						tty: false,
					})
					yield* read(/started/)
				}),
			)
			const pid = Number(yield* fs.readFileString(marker))
			const alive = Effect.sync(() => {
				try {
					process.kill(pid, 0)
					return true
				} catch {
					return false
				}
			})
			// The finalizer sends SIGKILL and does not wait, so wait until Node has reaped the process.
			const stillAlive = yield* alive.pipe(
				Effect.repeat({
					while: (up) => up,
					schedule: Schedule.spaced("20 millis"),
					times: 100,
				}),
			)
			assert.isFalse(stillAlive)
		}),
	)
})
