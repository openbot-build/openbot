import { Redacted } from "effect"
import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Effect,
	Option,
	pipe,
	type Predicate,
	Ref,
	Schema,
	Stream,
} from "effect"
import {
	HttpClient,
	type HttpClientRequest,
	HttpClientResponse,
} from "effect/http"
import type { Machine, Process, Provider } from "../src/computers/Computer.ts"
import * as Desktop from "../src/computers/e2b/Desktop.ts"
import * as E2bProvider from "../src/computers/e2b/E2bProvider.ts"
import { envelope } from "../src/computers/e2b/Envd.ts"

interface Seen {
	readonly method: string
	readonly url: URL
	readonly headers: Readonly<Record<string, string>>
	readonly body: unknown
}

type Answer = (seen: Seen) => Response

const JsonText = Schema.fromJsonString(Schema.Unknown)

/** A JSON body as its value, other bytes as they are, and a form as its data. */
const bodyOf = (request: HttpClientRequest.HttpClientRequest): unknown => {
	const body = request.body
	if (body._tag === "Uint8Array")
		return Option.getOrElse(
			Schema.decodeOption(JsonText)(new TextDecoder().decode(body.body)),
			() => body.body,
		)
	if (body._tag === "FormData") return body.formData
	return undefined
}

/** A fake E2B: one function answers every request, and the test keeps a log. */
const fake = (answer: Answer) =>
	Effect.gen(function* () {
		const log = yield* Ref.make<ReadonlyArray<Seen>>([])
		const client = HttpClient.make((request, url) => {
			const seen: Seen = {
				method: request.method,
				url,
				headers: request.headers,
				body: bodyOf(request),
			}
			return Ref.update(log, Arr.append(seen)).pipe(
				Effect.as(HttpClientResponse.fromWeb(request, answer(seen))),
			)
		})
		return { log: Ref.get(log), client }
	})

/** The first request in the log that matches. It fails when there is none. */
const findRequest = (
	log: Effect.Effect<ReadonlyArray<Seen>>,
	predicate: Predicate.Predicate<Seen>,
) =>
	Effect.flatMap(log, (seen) =>
		Effect.fromOption(Arr.findFirst(seen, predicate)),
	)

/** The JSON message in a Connect envelope, after its 5 byte header. */
const envelopeJson = <S extends Schema.Constraint>(schema: S, body: unknown) =>
	Effect.suspend(() => {
		assert.instanceOf(body, Uint8Array)
		return Schema.decodeEffect(Schema.fromJsonString(schema))(
			new TextDecoder().decode(body.subarray(5)),
		)
	})

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	})

const credentials: E2bProvider.Credentials = {
	kind: "e2b",
	apiKey: Redacted.make("e2b-test-key"),
	apiUrl: "https://api.e2b.test",
	sandboxDomain: "e2b.test",
}

const provider = (client: HttpClient.HttpClient) =>
	E2bProvider.make(credentials).pipe(
		Effect.provideService(HttpClient.HttpClient, client),
	)

const running = {
	sandboxID: "sbx1",
	templateID: "base",
	state: "running",
	envdAccessToken: "envd-token",
	metadata: { "openbot-desktop": "false" },
}

const base64 = (text: string) => Buffer.from(text).toString("base64")

/** A Connect stream with the events of one process. */
const processStream = (events: ReadonlyArray<unknown>, end: unknown = {}) => {
	const parts = [
		...Arr.map(events, (event) => envelope({ event })),
		envelope(end, 0x02),
	]
	return new Response(Buffer.concat(parts), {
		headers: { "content-type": "application/connect+json" },
	})
}

const attach = (answer: Answer) =>
	Effect.gen(function* () {
		const { log, client } = yield* fake((seen) =>
			seen.method === "GET" && seen.url.pathname === "/sandboxes/sbx1"
				? json(running)
				: answer(seen),
		)
		const value: Provider = yield* provider(client)
		const machine: Machine = yield* value.attach("sbx1")
		return { machine, log, provider: value }
	})

/** The create request of a sandbox, with only its template. */
const TemplateBody = Schema.Struct({ templateID: Schema.String })

it.effect(
	"E2B makes a sandbox from the template, with labels and the desktop flag",
	() =>
		Effect.gen(function* () {
			const { log, client } = yield* fake(() =>
				json({ sandboxID: "sbx9", envdAccessToken: "t" }, 201),
			)
			const value = yield* provider(client)
			const made = yield* value.create({
				desktop: true,
				labels: { computer: "c1" },
			})
			assert.deepStrictEqual(made, { ref: "sbx9" })
			const seen = yield* Effect.fromOption(Arr.head(yield* log))
			assert.strictEqual(seen.method, "POST")
			assert.strictEqual(seen.url.href, "https://api.e2b.test/sandboxes")
			assert.strictEqual(seen.headers["x-api-key"], "e2b-test-key")
			assert.deepStrictEqual(seen.body, {
				templateID: "desktop",
				timeout: 3600,
				autoPause: true,
				secure: true,
				metadata: { computer: "c1", "openbot-desktop": "true" },
				envVars: { DISPLAY: ":0" },
			})
			yield* value.create({ desktop: false, labels: {} })
			const second = yield* Effect.fromOption(Arr.get(yield* log, 1))
			assert.strictEqual(
				(yield* Schema.decodeUnknownEffect(TemplateBody)(second.body))
					.templateID,
				"base",
			)
			yield* value.create({
				template: "my-template",
				desktop: false,
				labels: {},
			})
			const third = yield* Effect.fromOption(Arr.get(yield* log, 2))
			assert.strictEqual(
				(yield* Schema.decodeUnknownEffect(TemplateBody)(third.body))
					.templateID,
				"my-template",
			)
		}),
)

/** The start request of a process, with only the arguments of the command. */
const StartRequest = Schema.Struct({
	process: Schema.Struct({ args: Schema.Array(Schema.String) }),
})

/** All the output of a process as text, and how it ended. */
const collect = (process: Process) =>
	Effect.gen(function* () {
		const chunks = yield* Stream.runCollect(process.output)
		return {
			output: pipe(
				chunks,
				Arr.map((chunk) => new TextDecoder().decode(chunk)),
				Arr.join(""),
			),
			exit: yield* process.exit,
		}
	})

it.effect(
	"E2B starts a command over the envd stream and gives its output and exit code",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const { machine, log } = yield* attach(() =>
					processStream([
						{ start: { pid: 7 } },
						{ data: { stdout: base64("hello\n") } },
						{ data: { stderr: base64("warn\n") } },
						{ keepalive: {} },
						{ end: { exitCode: 3, exited: true, status: "exit status 3" } },
					]),
				)
				const process = yield* machine.shell.start({
					command: "echo hello",
					cwd: "/tmp",
					env: { A: "1" },
					tty: false,
				})
				const result = yield* collect(process)
				assert.strictEqual(result.output, "hello\nwarn\n")
				assert.deepStrictEqual(result.exit, { code: 3, signal: null })
				const start = yield* findRequest(
					log,
					(seen) => seen.url.pathname === "/process.Process/Start",
				)
				assert.strictEqual(start.url.host, "49983-sbx1.e2b.test")
				assert.strictEqual(start.headers["x-access-token"], "envd-token")
				assert.strictEqual(start.headers["x-api-key"], undefined)
				assert.strictEqual(
					start.headers["content-type"],
					"application/connect+json",
				)
				assert.deepStrictEqual(
					yield* envelopeJson(Schema.Unknown, start.body),
					{
						process: {
							cmd: "/bin/bash",
							args: ["-l", "-c", "echo hello"],
							envs: { A: "1" },
							cwd: "/tmp",
						},
						stdin: true,
					},
				)
			}),
		),
)

it.effect("E2B gives a terminal, and a signal stops the command", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const { machine, log } = yield* attach((seen) =>
				seen.url.pathname === "/process.Process/Start"
					? processStream([
							{ start: { pid: 9 } },
							{ data: { pty: base64(">>> ") } },
							{ end: { exitCode: -1, exited: true, status: "signal: killed" } },
						])
					: json({}),
			)
			const process = yield* machine.shell.start({
				command: "python3",
				tty: true,
				rows: 40,
				cols: 120,
			})
			yield* process.write(new TextEncoder().encode("1+1\n"))
			yield* process.resize(50, 100)
			const result = yield* collect(process)
			assert.strictEqual(result.output, ">>> ")
			assert.deepStrictEqual(result.exit, { code: null, signal: "SIGKILL" })
			const start = yield* findRequest(
				log,
				(seen) => seen.url.pathname === "/process.Process/Start",
			)
			const body = yield* envelopeJson(
				Schema.Struct({ pty: Schema.optionalKey(Schema.Unknown) }),
				start.body,
			)
			assert.deepStrictEqual(body.pty, { size: { rows: 40, cols: 120 } })
			const input = yield* findRequest(
				log,
				(seen) => seen.url.pathname === "/process.Process/SendInput",
			)
			assert.deepStrictEqual(input.body, {
				process: { pid: 9 },
				input: { pty: base64("1+1\n") },
			})
			const update = yield* findRequest(
				log,
				(seen) => seen.url.pathname === "/process.Process/Update",
			)
			assert.deepStrictEqual(update.body, {
				process: { pid: 9 },
				pty: { size: { rows: 50, cols: 100 } },
			})
		}),
	),
)

it.effect("E2B kills a command when its Scope closes before it ends", () =>
	Effect.gen(function* () {
		const { machine, log } = yield* attach((seen) => {
			if (seen.url.pathname !== "/process.Process/Start") return json({})
			const parts = [
				envelope({ event: { start: { pid: 42 } } }),
				envelope({ event: { data: { stdout: base64("partial") } } }),
			]
			return new Response(
				new ReadableStream({
					start(controller) {
						for (const part of parts) controller.enqueue(part)
					},
				}),
			)
		})
		yield* Effect.scoped(
			Effect.gen(function* () {
				const process = yield* machine.shell.start({
					command: "sleep 100",
					tty: false,
				})
				// Ctrl-D closes stdin when there is no terminal.
				yield* process.write(new Uint8Array([0x04]))
			}),
		)
		const close = yield* findRequest(
			log,
			(seen) => seen.url.pathname === "/process.Process/CloseStdin",
		)
		assert.deepStrictEqual(close.body, { process: { pid: 42 } })
		const kill = yield* findRequest(
			log,
			(seen) => seen.url.pathname === "/process.Process/SendSignal",
		)
		assert.deepStrictEqual(kill.body, {
			process: { pid: 42 },
			signal: "SIGNAL_SIGKILL",
		})
	}),
)

it.effect(
	"E2B does not wait for a pid when the stream ends before the command starts",
	() =>
		Effect.gen(function* () {
			const { machine, log } = yield* attach((seen) =>
				seen.url.pathname === "/process.Process/Start"
					? processStream([])
					: json({}),
			)
			// The test clock does not move, so a wait for the pid would never end.
			yield* Effect.scoped(
				Effect.gen(function* () {
					const process = yield* machine.shell.start({
						command: "true",
						tty: false,
					})
					assert.deepStrictEqual(yield* process.exit, {
						code: null,
						signal: null,
						error: "The stream ended early.",
					})
					const failure = yield* Effect.flip(
						process.write(new TextEncoder().encode("x")),
					)
					assert.strictEqual(failure.message, "The command did not start.")
				}),
			)
			// Without a pid, there is no process to kill.
			assert.ok(
				Option.isNone(
					Arr.findFirst(
						yield* log,
						(seen) => seen.url.pathname === "/process.Process/SendSignal",
					),
				),
			)
		}),
)

it.effect("E2B reads, writes, lists and removes files through envd", () =>
	Effect.gen(function* () {
		const { machine, log } = yield* attach((seen) => {
			if (seen.url.pathname === "/files" && seen.method === "GET")
				return new Response("héllo")
			if (seen.url.pathname === "/files" && seen.method === "POST")
				return json([{ path: "/home/user/a.txt", name: "a.txt", type: "file" }])
			if (seen.url.pathname === "/filesystem.Filesystem/ListDir")
				return json({
					entries: [
						{
							name: "src",
							type: "FILE_TYPE_DIRECTORY",
							size: "4096",
							modifiedTime: "2026-10-23T10:00:00Z",
						},
						{ name: "a.txt", type: "FILE_TYPE_FILE", size: "5" },
						{ name: "l", type: "FILE_TYPE_FILE", isSymlink: true },
					],
				})
			if (seen.url.pathname === "/filesystem.Filesystem/Remove") return json({})
			return json({ code: "not_found", message: "no route" }, 404)
		})
		const text = yield* machine.shell.read("a.txt", "utf8")
		assert.deepStrictEqual(text, {
			path: "a.txt",
			encoding: "utf8",
			content: "héllo",
		})
		const bytes = yield* machine.shell.read("a.txt", "base64")
		assert.strictEqual(bytes.content, base64("héllo"))
		const read = yield* findRequest(
			log,
			(seen) => seen.url.pathname === "/files",
		)
		assert.strictEqual(read.url.searchParams.get("path"), "a.txt")
		assert.strictEqual(read.url.searchParams.get("username"), "user")

		yield* machine.shell.write({
			path: "a.txt",
			encoding: "base64",
			content: base64("hi"),
		})
		const write = yield* findRequest(
			log,
			(seen) => seen.url.pathname === "/files" && seen.method === "POST",
		)
		const form = write.body
		assert.instanceOf(form, FormData)
		const file = form.get("file")
		assert.instanceOf(file, Blob)
		assert.strictEqual(yield* Effect.promise(() => file.text()), "hi")

		const entries = yield* machine.shell.list("/home/user")
		assert.deepStrictEqual(entries, [
			{
				name: "src",
				kind: "directory",
				size: 4096,
				modifiedAt: Date.parse("2026-10-23T10:00:00Z"),
			},
			{ name: "a.txt", kind: "file", size: 5, modifiedAt: 0 },
			{ name: "l", kind: "link", size: 0, modifiedAt: 0 },
		])
		yield* machine.shell.remove("/home/user/src")
		const remove = yield* findRequest(
			log,
			(seen) => seen.url.pathname === "/filesystem.Filesystem/Remove",
		)
		assert.deepStrictEqual(remove.body, { path: "/home/user/src" })
	}),
)

it.effect("E2B maps a missing file to a failure that a retry cannot fix", () =>
	Effect.gen(function* () {
		const { machine } = yield* attach(() =>
			json({ code: 404, message: "path '/x' does not exist" }, 404),
		)
		const error = yield* Effect.flip(machine.shell.read("/x", "utf8"))
		assert.strictEqual(error._tag, "ComputerCallFailed")
		assert.strictEqual(
			error._tag === "ComputerCallFailed" && error.missingPath,
			"/x",
		)
		assert.strictEqual(
			error._tag === "ComputerCallFailed" && error.retry,
			false,
		)
		assert.match(
			error._tag === "ComputerCallFailed" ? error.message : "",
			/is not there/,
		)
	}),
)

it.effect(
	"E2B pauses with memory kept, and resumes with connect on the next call",
	() =>
		Effect.gen(function* () {
			const { machine, log } = yield* attach((seen) => {
				if (seen.url.pathname === "/sandboxes/sbx1/pause")
					return new Response(null, { status: 204 })
				if (seen.url.pathname === "/sandboxes/sbx1/connect")
					return json({ ...running, envdAccessToken: "fresh-token" }, 201)
				return json({ entries: [] })
			})
			yield* machine.pausable!.pause
			const pause = yield* findRequest(
				log,
				(seen) => seen.url.pathname === "/sandboxes/sbx1/pause",
			)
			assert.strictEqual(pause.method, "POST")
			yield* machine.shell.list("/")
			const connect = yield* findRequest(
				log,
				(seen) => seen.url.pathname === "/sandboxes/sbx1/connect",
			)
			assert.deepStrictEqual(connect.body, { timeout: 3600 })
			const list = yield* findRequest(
				log,
				(seen) => seen.url.pathname === "/filesystem.Filesystem/ListDir",
			)
			assert.strictEqual(list.headers["x-access-token"], "fresh-token")
			assert.strictEqual(
				Arr.filter(
					yield* log,
					(seen) => seen.url.pathname === "/filesystem.Filesystem/ListDir",
				).length,
				1,
			)
		}),
)

it.effect(
	"E2B resumes a sandbox that the proxy reports away, and tries once more",
	() =>
		Effect.gen(function* () {
			let first = true
			const { machine, log } = yield* attach((seen) => {
				if (seen.url.pathname === "/sandboxes/sbx1/connect")
					return json(running)
				if (first) {
					first = false
					return json(
						{ sandboxId: "sbx1", message: "The sandbox is paused" },
						502,
					)
				}
				return json({ entries: [] })
			})
			assert.deepStrictEqual(yield* machine.shell.list("/"), [])
			assert.strictEqual(
				Arr.filter(
					yield* log,
					(seen) => seen.url.pathname === "/sandboxes/sbx1/connect",
				).length,
				1,
			)
		}),
)

it.effect(
	"E2B gives a port an address on the sandbox domain, and destroy ignores a gone sandbox",
	() =>
		Effect.gen(function* () {
			const { machine, log } = yield* attach(
				() => new Response(null, { status: 404 }),
			)
			assert.strictEqual(
				yield* machine.ports!.open(3000),
				"https://3000-sbx1.e2b.test",
			)
			yield* machine.destroy
			const destroy = yield* findRequest(
				log,
				(seen) => seen.method === "DELETE",
			)
			assert.strictEqual(destroy.url.pathname, "/sandboxes/sbx1")
			assert.strictEqual(machine.desktop, undefined)
		}),
)

it.effect("E2B maps a wrong key and a gone sandbox", () =>
	Effect.gen(function* () {
		const { client } = yield* fake((seen) =>
			seen.url.pathname === "/sandboxes"
				? json({ code: 401, message: "Invalid API key" }, 401)
				: json({ code: 404, message: "not found" }, 404),
		)
		const value = yield* provider(client)
		const denied = yield* Effect.flip(value.verify)
		assert.strictEqual(denied.retry, false)
		assert.match(denied.message, /API key/)
		const gone = yield* Effect.flip(value.attach("sbx404"))
		assert.strictEqual(gone._tag, "ComputerGone")
		const busy = yield* fake(() => json({ message: "slow down" }, 429))
		const later = yield* Effect.flip((yield* provider(busy.client)).verify)
		assert.strictEqual(later.retry, true)
	}),
)

it.effect("E2B reads the state of a sandbox", () =>
	Effect.gen(function* () {
		const { client } = yield* fake((seen) =>
			seen.url.pathname === "/sandboxes/sbx1"
				? json({ ...running, state: "paused" })
				: json({}, 404),
		)
		const value = yield* provider(client)
		const machine = yield* value.attach("sbx1")
		assert.strictEqual(yield* machine.state, "paused")
	}),
)

it.effect(
	"E2B takes a screenshot of the desktop with scrot and reads its size",
	() =>
		Effect.gen(function* () {
			const png = new Uint8Array(32)
			png.set([0x89, 0x50, 0x4e, 0x47], 0)
			new DataView(png.buffer).setUint32(16, 1024)
			new DataView(png.buffer).setUint32(20, 768)
			const { client, log } = yield* fake((seen) => {
				if (seen.url.pathname === "/sandboxes/sbx1")
					return json({ ...running, metadata: { "openbot-desktop": "true" } })
				if (seen.url.pathname === "/process.Process/Start")
					return processStream([
						{ start: { pid: 1 } },
						{ end: { exited: true } },
					])
				if (seen.url.pathname === "/files") return new Response(png)
				return json({}, 404)
			})
			const machine = yield* (yield* provider(client)).attach("sbx1")
			const shot = yield* machine.desktop!.screenshot
			assert.strictEqual(shot.width, 1024)
			assert.strictEqual(shot.height, 768)
			assert.strictEqual(shot.data, Buffer.from(png).toString("base64"))
			yield* machine.desktop!.act([
				{ _tag: "Click", x: 10, y: 20, double: true },
				{ _tag: "Key", keys: ["ctrl", "c"] },
				{ _tag: "Type", text: "it's" },
			])
			const scripts = yield* Effect.forEach(
				Arr.filter(
					yield* log,
					(seen) => seen.url.pathname === "/process.Process/Start",
				),
				(seen) =>
					Effect.map(envelopeJson(StartRequest, seen.body), (sent) =>
						Option.getOrElse(Arr.get(sent.process.args, 2), () => ""),
					),
			)
			const script = Option.getOrElse(Arr.last(scripts), () => "")
			assert.match(script, /xdotool mousemove --sync 10 20/)
			assert.match(script, /xdotool click --repeat 2 1/)
			assert.match(script, /xdotool key -- 'Control_L\+c'/)
			assert.match(script, /xdotool type --delay 12 -- 'it'\\''s'/)
		}),
)

it.effect(
	"E2B gives a typed failure when the sandbox address is not a valid URL",
	() =>
		Effect.gen(function* () {
			const { client } = yield* fake((seen) =>
				seen.method === "GET" && seen.url.pathname === "/sandboxes/sbx1"
					? json(running)
					: new Response(null, { status: 404 }),
			)
			const value = yield* E2bProvider.make({
				...credentials,
				sandboxDomain: "my domain",
			}).pipe(Effect.provideService(HttpClient.HttpClient, client))
			const machine = yield* value.attach("sbx1")
			const failure = yield* Effect.flip(machine.ports!.open(3000))
			assert.strictEqual(failure._tag, "ComputerCallFailed")
			assert.strictEqual(
				failure._tag === "ComputerCallFailed" && failure.retry,
				false,
			)
		}),
)

it("E2B desktop key names do not read names of the object prototype", () => {
	assert.strictEqual(Desktop.keyName("ctrl"), "Control_L")
	assert.strictEqual(Desktop.keyName("F5"), "F5")
	assert.strictEqual(Desktop.keyName("constructor"), "constructor")
	assert.strictEqual(Desktop.keyName("__proto__"), "__proto__")
})
