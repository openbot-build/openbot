import { Redacted } from "effect"
import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Clock,
	DateTime,
	Effect,
	Fiber,
	pipe,
	type Predicate,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { Base64 } from "effect/encoding"
import { TestClock } from "effect/testing"
import {
	type HttpBody,
	HttpClient,
	type HttpClientRequest,
	HttpServerResponse,
} from "effect/http"
import type { Process } from "../src/computers/Computer.ts"
import * as DaytonaProvider from "../src/computers/daytona/DaytonaProvider.ts"

interface Seen {
	readonly method: string
	readonly url: URL
	readonly headers: Readonly<Record<string, string>>
	readonly body: unknown
}

type Answer = (
	seen: Seen,
) => Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	HttpBody.HttpBodyError
>

const decoder = new TextDecoder()

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))

const bodyOf = (request: HttpClientRequest.HttpClientRequest) => {
	const body = request.body
	if (body._tag === "Uint8Array") return decodeJson(decoder.decode(body.body))
	if (body._tag === "FormData") return Effect.succeed(body.formData)
	return Effect.void
}

/** A fake Daytona: one function answers every request, and the test keeps a log. */
const fake = (answer: Answer) =>
	Effect.gen(function* () {
		const requests = yield* Ref.make<ReadonlyArray<Seen>>([])
		const client = HttpClient.make((request, url) =>
			Effect.gen(function* () {
				const seen: Seen = {
					method: request.method,
					url,
					headers: request.headers,
					body: yield* bodyOf(request),
				}
				yield* Ref.update(requests, Arr.append(seen))
				const response = yield* answer(seen)
				return HttpServerResponse.toClientResponse(response, { request })
			}).pipe(Effect.orDie),
		)
		/** Every request so far, the oldest first. */
		const log = Ref.get(requests)
		/** The first request that matches. It fails when no request matches. */
		const find = (predicate: Predicate.Predicate<Seen>) =>
			Effect.flatMap(log, (seen) =>
				Effect.fromOption(Arr.findFirst(seen, predicate)),
			)
		return { log, find, client }
	})

const json = (value: unknown, status = 200) =>
	HttpServerResponse.json(value, { status })

const text = (body: string) => Effect.succeed(HttpServerResponse.text(body))

const empty = (status: number) =>
	Effect.succeed(HttpServerResponse.empty({ status }))

const credentials: DaytonaProvider.Credentials = {
	kind: "daytona",
	apiKey: Redacted.make("dtn-test-key"),
	apiUrl: "https://daytona.test",
	target: "eu",
}

const provider = (client: HttpClient.HttpClient) =>
	DaytonaProvider.make(credentials).pipe(
		Effect.provideService(HttpClient.HttpClient, client),
	)

const sandbox = (state: string, desktop = false) => ({
	id: "sb1",
	state,
	toolboxProxyUrl: "https://proxy.daytona.test/toolbox/",
	labels: { "openbot-desktop": desktop ? "true" : "false" },
})

const toolbox = "/toolbox/sb1"

/** The path of a request after the toolbox of the sandbox. */
const toolboxPath = (seen: Seen) => Str.slice(toolbox.length)(seen.url.pathname)

const pathEndsWith = (end: string) => (seen: Seen) =>
	Str.endsWith(end)(seen.url.pathname)

/** Attaches to a started sandbox. Other calls go to `answer`. */
const attach = (answer: Answer, desktop = false) =>
	Effect.gen(function* () {
		const { log, find, client } = yield* fake((seen) =>
			seen.method === "GET" && seen.url.pathname === "/api/sandbox/sb1"
				? json(sandbox("started", desktop))
				: answer(seen),
		)
		const machine = yield* (yield* provider(client)).attach("sb1")
		return { machine, log, find }
	})

/** Answers the session routes of the toolbox: a command that gives `output` and ends with `code`. */
const session = (seen: Seen, output: string, code: number) => {
	const path = toolboxPath(seen)
	if (/^\/process\/session\/[^/]+\/exec$/.test(path))
		return json({ cmdId: "cmd1" })
	if (Str.endsWith("/command/cmd1/logs")(path)) return text(output)
	if (Str.endsWith("/command/cmd1")(path))
		return json({ id: "cmd1", exitCode: code })
	return json({})
}

const collect = (process: Process) =>
	Effect.gen(function* () {
		const output = yield* process.output.pipe(
			Stream.decodeText,
			Stream.mkString,
		)
		return { output, exit: yield* process.exit }
	})

const SessionBody = Schema.Struct({ sessionId: Schema.String })

const ExecBody = Schema.Struct({
	command: Schema.String,
	runAsync: Schema.Boolean,
})

it.effect(
	"Daytona makes a sandbox from a snapshot, in the target, with labels",
	() =>
		Effect.gen(function* () {
			const { log, client } = yield* fake(() => json(sandbox("creating")))
			const value = yield* provider(client)
			const made = yield* value.create({
				template: "my-snapshot",
				desktop: true,
				labels: { computer: "c1" },
			})
			assert.deepStrictEqual(made, { ref: "sb1" })
			const request = yield* Effect.fromOption(Arr.head(yield* log))
			assert.strictEqual(request.url.href, "https://daytona.test/api/sandbox")
			assert.strictEqual(
				request.headers["authorization"],
				"Bearer dtn-test-key",
			)
			assert.deepStrictEqual(request.body, {
				snapshot: "my-snapshot",
				target: "eu",
				labels: { computer: "c1", "openbot-desktop": "true" },
			})
		}),
)

it.effect(
	"Daytona runs a command in a toolbox session and gives its output and exit code",
	() =>
		Effect.gen(function* () {
			const { machine, find } = yield* attach((seen) =>
				session(seen, "hello\nwarn\n", 3),
			)
			const process = yield* machine.shell.start({
				command: "echo hello",
				cwd: "/tmp",
				env: { A: "1" },
				tty: false,
			})
			yield* process.write(new TextEncoder().encode("input"))
			const result = yield* collect(process)
			assert.strictEqual(result.output, "hello\nwarn\n")
			assert.deepStrictEqual(result.exit, { code: 3, signal: null })
			const created = yield* find(pathEndsWith("/process/session"))
			assert.strictEqual(
				created.headers["authorization"],
				"Bearer dtn-test-key",
			)
			const { sessionId } = yield* Schema.decodeUnknownEffect(SessionBody)(
				created.body,
			)
			const exec = yield* find(
				pathEndsWith(`/process/session/${sessionId}/exec`),
			)
			const body = yield* Schema.decodeUnknownEffect(ExecBody)(exec.body)
			assert.strictEqual(body.runAsync, true)
			assert.match(
				body.command,
				/^cd '\/tmp' && export A='1'; bash -lc 'echo hello'$/,
			)
			const input = yield* find(pathEndsWith("/input"))
			assert.deepStrictEqual(input.body, { data: "input" })
		}),
)

it.effect("Daytona gives no terminal to a command", () =>
	Effect.gen(function* () {
		const { machine, log } = yield* attach((seen) => session(seen, "", 0))
		const error = yield* Effect.flip(
			machine.shell.start({ command: "python3", tty: true }),
		)
		assert.ok(error._tag === "ComputerCallFailed")
		assert.strictEqual(error.retry, false)
		assert.isFalse(Arr.some(yield* log, pathEndsWith("/process/session")))
	}),
)

it.effect(
	"Daytona reads, writes, lists and removes files through the toolbox",
	() =>
		Effect.gen(function* () {
			const { machine, find } = yield* attach((seen) => {
				const path = toolboxPath(seen)
				if (path === "/files/download")
					return seen.url.searchParams.get("path") === "/nope"
						? json({ message: "file not found" }, 404)
						: text("héllo")
				if (path === "/files/bulk-upload") return empty(200)
				if (path === "/files" && seen.method === "GET")
					return json([
						{
							name: "src",
							isDir: true,
							size: 4096,
							mode: "drwxr-xr-x",
							modTime: "2026-10-23T10:00:00Z",
						},
						{ name: "a.txt", isDir: false, size: 5, mode: "-rw-r--r--" },
						{ name: "l", isDir: false, size: 1, mode: "Lrwxrwxrwx" },
					])
				if (path === "/files" && seen.method === "DELETE") return empty(204)
				return json({ message: "no route" }, 404)
			})
			assert.strictEqual(
				(yield* machine.shell.read("a.txt", "utf8")).content,
				"héllo",
			)
			assert.strictEqual(
				(yield* machine.shell.read("a.txt", "base64")).content,
				Base64.encode("héllo"),
			)
			yield* machine.shell.write({
				path: "/home/daytona/a.txt",
				encoding: "utf8",
				content: "hi",
			})
			const upload = yield* find(pathEndsWith("/files/bulk-upload"))
			const form = upload.body
			assert.instanceOf(form, FormData)
			assert.strictEqual(form.get("files[0].path"), "/home/daytona/a.txt")
			const file = form.get("files[0].file")
			assert.instanceOf(file, Blob)
			assert.strictEqual(yield* Effect.promise(() => file.text()), "hi")
			assert.deepStrictEqual(yield* machine.shell.list("/home"), [
				{
					name: "src",
					kind: "directory",
					size: 4096,
					modifiedAt: DateTime.toEpochMillis(
						DateTime.makeUnsafe("2026-10-23T10:00:00Z"),
					),
				},
				{ name: "a.txt", kind: "file", size: 5, modifiedAt: 0 },
				{ name: "l", kind: "link", size: 1, modifiedAt: 0 },
			])
			yield* machine.shell.remove("/home/src")
			const remove = yield* find((seen) => seen.method === "DELETE")
			assert.strictEqual(remove.url.searchParams.get("path"), "/home/src")
			assert.strictEqual(remove.url.searchParams.get("recursive"), "true")
			const missing = yield* Effect.flip(machine.shell.read("/nope", "utf8"))
			assert.strictEqual(missing._tag, "ComputerCallFailed")
			assert.strictEqual(
				missing._tag === "ComputerCallFailed" && missing.missingPath,
				"/nope",
			)
			assert.strictEqual(
				missing._tag === "ComputerCallFailed" && missing.retry,
				false,
			)
		}),
)

it.effect(
	"Daytona stops the sandbox to pause it, and starts it again on the next call",
	() =>
		Effect.gen(function* () {
			const state = yield* Ref.make("started")
			const { log, client } = yield* fake((seen) => {
				const path = seen.url.pathname
				if (path === "/api/sandbox/sb1")
					return Effect.flatMap(Ref.get(state), (current) =>
						json(sandbox(current)),
					)
				if (path === "/api/sandbox/sb1/stop")
					return Effect.andThen(
						Ref.set(state, "stopped"),
						json(sandbox("stopped")),
					)
				if (path === "/api/sandbox/sb1/start")
					return Effect.andThen(
						Ref.set(state, "started"),
						json(sandbox("starting")),
					)
				return session(seen, "ok", 0)
			})
			const machine = yield* (yield* provider(client)).attach("sb1")
			yield* machine.pausable!.pause
			assert.strictEqual(yield* machine.state, "paused")
			// OpenBot waits one second between two reads of the sandbox state.
			const fiber = yield* Effect.forkChild(
				Effect.scoped(
					Effect.flatMap(
						machine.shell.start({ command: "true", tty: false }),
						collect,
					),
				),
			)
			yield* TestClock.adjust("1 second")
			const result = yield* Fiber.join(fiber)
			assert.strictEqual(result.output, "ok")
			assert.strictEqual(
				Arr.filter(
					yield* log,
					(seen) => seen.url.pathname === "/api/sandbox/sb1/start",
				).length,
				1,
			)
			assert.strictEqual(yield* machine.state, "running")
		}),
)

it.effect(
	"Daytona gives a port a signed preview link, and destroy ignores a gone sandbox",
	() =>
		Effect.gen(function* () {
			const { machine, log, find } = yield* attach((seen) =>
				seen.url.pathname === "/api/sandbox/sb1/ports/3000/signed-preview-url"
					? json({
							sandboxId: "sb1",
							port: 3000,
							token: "tk",
							url: "https://3000-tk.proxy.daytona.test/",
						})
					: empty(404),
			)
			assert.strictEqual(
				yield* machine.ports!.open(3000),
				"https://3000-tk.proxy.daytona.test",
			)
			const link = yield* find(pathEndsWith("/signed-preview-url"))
			assert.strictEqual(link.url.searchParams.get("expiresInSeconds"), "86400")
			yield* machine.destroy
			const last = yield* Effect.fromOption(Arr.last(yield* log))
			assert.strictEqual(last.method, "DELETE")
			assert.strictEqual(machine.desktop, undefined)
		}),
)

it.effect("Daytona maps a wrong key and a gone sandbox", () =>
	Effect.gen(function* () {
		const { client } = yield* fake((seen) =>
			seen.url.pathname === "/api/api-keys/current"
				? json({ statusCode: 401, message: "Unauthorized" }, 401)
				: json({ statusCode: 404, message: "Sandbox not found" }, 404),
		)
		const value = yield* provider(client)
		const denied = yield* Effect.flip(value.verify)
		assert.strictEqual(denied.retry, false)
		assert.match(denied.message, /API key/)
		const gone = yield* Effect.flip(value.attach("sb404"))
		assert.strictEqual(gone._tag, "ComputerGone")
		const failed = yield* fake(() => json({ message: "down" }, 503))
		const later = yield* Effect.flip(
			(yield* provider(failed.client)).create({ desktop: false, labels: {} }),
		)
		assert.strictEqual(later.retry, true)
	}),
)

it.effect(
	"Daytona starts computer use first, then takes a screenshot and does actions",
	() =>
		Effect.gen(function* () {
			const png = new Uint8Array(32)
			png.set([0x89, 0x50, 0x4e, 0x47], 0)
			new DataView(png.buffer).setUint32(16, 1280)
			new DataView(png.buffer).setUint32(20, 720)
			const active = yield* Ref.make(false)
			const { machine, log } = yield* attach((seen) => {
				const path = toolboxPath(seen)
				if (path === "/computeruse/status")
					return Effect.flatMap(Ref.get(active), (on) =>
						json({ status: on ? "active" : "inactive" }),
					)
				if (path === "/computeruse/start")
					return Effect.andThen(
						Ref.set(active, true),
						json({ message: "started" }),
					)
				if (path === "/computeruse/screenshot")
					return json({ screenshot: Base64.encode(png) })
				if (
					seen.url.pathname === "/api/sandbox/sb1/ports/6080/signed-preview-url"
				)
					return json({ url: "https://6080-tk.proxy.daytona.test" })
				return json({})
			}, true)
			const shot = yield* machine.desktop!.screenshot
			assert.strictEqual(shot.width, 1280)
			assert.strictEqual(shot.height, 720)
			assert.strictEqual(
				Arr.filter(yield* log, pathEndsWith("/computeruse/start")).length,
				1,
			)
			yield* machine.desktop!.act([
				{ _tag: "Click", x: 1, y: 2, button: "right" },
				{ _tag: "Scroll", x: 5, y: 5, deltaX: 0, deltaY: -3 },
				{ _tag: "Key", keys: ["ctrl", "c"] },
				{ _tag: "Key", keys: ["enter"] },
			])
			const sent = pipe(
				yield* log,
				Arr.filter(
					(seen) =>
						Str.includes("/computeruse/mouse/")(seen.url.pathname) ||
						Str.includes("/computeruse/keyboard/")(seen.url.pathname),
				),
				Arr.map((seen) => [toolboxPath(seen), seen.body]),
			)
			assert.deepStrictEqual(sent, [
				[
					"/computeruse/mouse/click",
					{ x: 1, y: 2, button: "right", double: false },
				],
				[
					"/computeruse/mouse/scroll",
					{ x: 5, y: 5, direction: "up", amount: 3 },
				],
				["/computeruse/keyboard/hotkey", { keys: "ctrl+c" }],
				["/computeruse/keyboard/key", { key: "enter" }],
			])
			const stream = yield* machine.desktop!.stream!
			assert.strictEqual(
				stream.url,
				"https://6080-tk.proxy.daytona.test/vnc.html?autoconnect=true&resize=scale",
			)
			const now = yield* Clock.currentTimeMillis
			assert.ok(stream.expiresAt !== null && stream.expiresAt > now)
		}),
)

it.effect(
	"Daytona ends a command with a short message when it cannot read the output",
	() =>
		Effect.gen(function* () {
			const { machine } = yield* attach((seen) =>
				Str.endsWith("/command/cmd1/logs")(toolboxPath(seen))
					? json({ message: "toolbox down" }, 500)
					: session(seen, "", 0),
			)
			const result = yield* Effect.scoped(
				Effect.flatMap(
					machine.shell.start({ command: "true", tty: false }),
					collect,
				),
			)
			assert.deepStrictEqual(result.exit, {
				code: null,
				signal: null,
				error: "Reading the output failed with HTTP 500: toolbox down",
			})
		}),
)

it.effect(
	"Daytona closes a command session once, and does not start a stopped sandbox for it",
	() =>
		Effect.gen(function* () {
			const state = yield* Ref.make("started")
			const { log, client } = yield* fake((seen) => {
				const path = seen.url.pathname
				if (path === "/api/sandbox/sb1")
					return Effect.flatMap(Ref.get(state), (current) =>
						json(sandbox(current)),
					)
				if (path === "/api/sandbox/sb1/start")
					return Effect.andThen(
						Ref.set(state, "started"),
						json(sandbox("starting")),
					)
				return session(seen, "done", 0)
			})
			const machine = yield* (yield* provider(client)).attach("sb1")
			yield* Effect.scoped(
				Effect.gen(function* () {
					const process = yield* machine.shell.start({
						command: "true",
						tty: false,
					})
					yield* collect(process)
					// The sandbox stops, and OpenBot no longer knows that it runs.
					yield* Ref.set(state, "stopped")
					yield* TestClock.adjust("2 minutes")
					yield* process.signal("SIGKILL")
				}),
			)
			const requests = yield* log
			assert.strictEqual(
				Arr.filter(
					requests,
					(seen) =>
						seen.method === "DELETE" &&
						/^\/process\/session\/openbot-[0-9a-f]{16}$/.test(
							toolboxPath(seen),
						),
				).length,
				1,
			)
			assert.strictEqual(
				Arr.filter(requests, pathEndsWith("/api/sandbox/sb1/start")).length,
				0,
			)
		}),
)

it.effect(
	"Daytona fails when it gets no preview link or no toolbox address",
	() =>
		Effect.gen(function* () {
			const { machine } = yield* attach((seen) =>
				Str.endsWith("/signed-preview-url")(seen.url.pathname)
					? json({ sandboxId: "sb1", port: 3000 })
					: empty(404),
			)
			const link = yield* Effect.flip(machine.ports!.open(3000))
			assert.strictEqual(link._tag, "ComputerCallFailed")
			assert.strictEqual(
				link._tag === "ComputerCallFailed" && link.message,
				"Daytona did not give a preview link.",
			)
			const { client } = yield* fake((seen) =>
				seen.url.pathname === "/api/sandbox/sb1"
					? json({ ...sandbox("started"), toolboxProxyUrl: "" })
					: seen.url.pathname === "/api/sandbox/sb1/toolbox-proxy-url"
						? json({})
						: session(seen, "", 0),
			)
			const other = yield* (yield* provider(client)).attach("sb1")
			const address = yield* Effect.flip(other.shell.list("/home"))
			assert.strictEqual(address._tag, "ComputerCallFailed")
			assert.strictEqual(
				address._tag === "ComputerCallFailed" && address.message,
				"Daytona did not give the toolbox address.",
			)
		}),
)
