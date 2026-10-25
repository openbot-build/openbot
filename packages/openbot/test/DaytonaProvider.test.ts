import { assert, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import {
	HttpClient,
	type HttpClientRequest,
	HttpClientResponse,
} from "effect/http"
import type { Process } from "../src/computers/Computer.ts"
import * as DaytonaProvider from "../src/computers/daytona/DaytonaProvider.ts"

interface Seen {
	readonly method: string
	readonly url: URL
	readonly headers: Readonly<Record<string, string>>
	readonly body: unknown
}

type Answer = (seen: Seen) => Response | Promise<Response>

const bodyOf = (request: HttpClientRequest.HttpClientRequest) => {
	const body = request.body
	if (body._tag === "Uint8Array")
		return JSON.parse(new TextDecoder().decode(body.body))
	if (body._tag === "FormData") return body.formData
	return undefined
}

/** A fake Daytona: one function answers every request, and the test keeps a log. */
const fake = (answer: Answer) => {
	const log: Array<Seen> = []
	const client = HttpClient.make((request, url) =>
		Effect.promise(async () => {
			const seen: Seen = {
				method: request.method,
				url,
				headers: request.headers,
				body: bodyOf(request),
			}
			log.push(seen)
			return HttpClientResponse.fromWeb(request, await answer(seen))
		}),
	)
	return { log, client }
}

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	})

const credentials: DaytonaProvider.Credentials = {
	kind: "daytona",
	apiKey: "dtn-test-key",
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

/** Attaches to a started sandbox. Other calls go to `answer`. */
const attach = (answer: Answer, desktop = false) =>
	Effect.gen(function* () {
		const { log, client } = fake((seen) =>
			seen.method === "GET" && seen.url.pathname === "/api/sandbox/sb1"
				? json(sandbox("started", desktop))
				: answer(seen),
		)
		const machine = yield* (yield* provider(client)).attach("sb1")
		return { machine, log }
	})

/** Answers the session routes of the toolbox: a command that gives `output` and ends with `code`. */
const session = (seen: Seen, output: string, code: number) => {
	const path = seen.url.pathname.slice(toolbox.length)
	if (/^\/process\/session\/[^/]+\/exec$/.test(path))
		return json({ cmdId: "cmd1" })
	if (path.endsWith("/command/cmd1/logs")) return new Response(output)
	if (path.endsWith("/command/cmd1"))
		return json({ id: "cmd1", exitCode: code })
	return json({})
}

const collect = (process: Process) =>
	Effect.gen(function* () {
		const chunks = yield* Stream.runCollect(process.output)
		return {
			output: chunks.map((chunk) => new TextDecoder().decode(chunk)).join(""),
			exit: yield* process.exit,
		}
	})

it.effect(
	"Daytona makes a sandbox from a snapshot, in the target, with labels",
	() =>
		Effect.gen(function* () {
			const { log, client } = fake(() => json(sandbox("creating")))
			const value = yield* provider(client)
			const made = yield* value.create({
				template: "my-snapshot",
				desktop: true,
				labels: { computer: "c1" },
			})
			assert.deepStrictEqual(made, { ref: "sb1" })
			assert.strictEqual(log[0]?.url.href, "https://daytona.test/api/sandbox")
			assert.strictEqual(
				log[0]?.headers["authorization"],
				"Bearer dtn-test-key",
			)
			assert.deepStrictEqual(log[0]?.body, {
				snapshot: "my-snapshot",
				target: "eu",
				labels: { computer: "c1", "openbot-desktop": "true" },
			})
		}),
)

it.effect(
	"Daytona runs a command in a toolbox session and gives its output and exit code",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const { machine, log } = yield* attach((seen) =>
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
				const created = log.find((seen) =>
					seen.url.pathname.endsWith("/process/session"),
				)
				assert.strictEqual(
					created?.headers["authorization"],
					"Bearer dtn-test-key",
				)
				const id = (created?.body as { sessionId: string }).sessionId
				const exec = log.find((seen) =>
					seen.url.pathname.endsWith(`/process/session/${id}/exec`),
				)
				const body = exec?.body as { command: string; runAsync: boolean }
				assert.strictEqual(body.runAsync, true)
				assert.match(
					body.command,
					/^cd '\/tmp' && export A='1'; bash -lc 'echo hello'$/,
				)
				const input = log.find((seen) => seen.url.pathname.endsWith("/input"))
				assert.deepStrictEqual(input?.body, { data: "input" })
			}),
		),
)

it.effect("Daytona gives no terminal to a command", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const { machine } = yield* attach((seen) => session(seen, "", 0))
			const exit = yield* Effect.exit(
				machine.shell.start({ command: "python3", tty: true }),
			)
			assert.strictEqual(exit._tag, "Failure")
		}),
	),
)

it.effect(
	"Daytona reads, writes, lists and removes files through the toolbox",
	() =>
		Effect.gen(function* () {
			const { machine, log } = yield* attach((seen) => {
				const path = seen.url.pathname.slice(toolbox.length)
				if (path === "/files/download")
					return seen.url.searchParams.get("path") === "/nope"
						? json({ message: "file not found" }, 404)
						: new Response("héllo")
				if (path === "/files/bulk-upload")
					return new Response(null, { status: 200 })
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
				if (path === "/files" && seen.method === "DELETE")
					return new Response(null, { status: 204 })
				return json({ message: "no route" }, 404)
			})
			assert.strictEqual(
				(yield* machine.shell.read("a.txt", "utf8")).content,
				"héllo",
			)
			assert.strictEqual(
				(yield* machine.shell.read("a.txt", "base64")).content,
				Buffer.from("héllo").toString("base64"),
			)
			yield* machine.shell.write({
				path: "/home/daytona/a.txt",
				encoding: "utf8",
				content: "hi",
			})
			const upload = log.find((seen) =>
				seen.url.pathname.endsWith("/files/bulk-upload"),
			)
			const form = upload?.body as FormData
			assert.strictEqual(form.get("files[0].path"), "/home/daytona/a.txt")
			assert.strictEqual(
				yield* Effect.promise(() => (form.get("files[0].file") as Blob).text()),
				"hi",
			)
			assert.deepStrictEqual(yield* machine.shell.list("/home"), [
				{
					name: "src",
					kind: "directory",
					size: 4096,
					modifiedAt: Date.parse("2026-10-23T10:00:00Z"),
				},
				{ name: "a.txt", kind: "file", size: 5, modifiedAt: 0 },
				{ name: "l", kind: "link", size: 1, modifiedAt: 0 },
			])
			yield* machine.shell.remove("/home/src")
			const remove = log.find((seen) => seen.method === "DELETE")
			assert.strictEqual(remove?.url.searchParams.get("path"), "/home/src")
			assert.strictEqual(remove?.url.searchParams.get("recursive"), "true")
			const missing = yield* Effect.flip(machine.shell.read("/nope", "utf8"))
			assert.strictEqual(missing._tag, "ComputerCallFailed")
			assert.strictEqual(
				missing._tag === "ComputerCallFailed" && missing.retry,
				false,
			)
		}),
)

it.live(
	"Daytona stops the sandbox to pause it, and starts it again on the next call",
	() =>
		Effect.gen(function* () {
			let state = "started"
			const { log, client } = fake((seen) => {
				const path = seen.url.pathname
				if (path === "/api/sandbox/sb1") return json(sandbox(state))
				if (path === "/api/sandbox/sb1/stop") {
					state = "stopped"
					return json(sandbox(state))
				}
				if (path === "/api/sandbox/sb1/start") {
					state = "started"
					return json(sandbox("starting"))
				}
				return session(seen, "ok", 0)
			})
			const machine = yield* (yield* provider(client)).attach("sb1")
			yield* machine.pausable!.pause
			assert.strictEqual(yield* machine.state, "paused")
			const result = yield* Effect.scoped(
				Effect.flatMap(
					machine.shell.start({ command: "true", tty: false }),
					collect,
				),
			)
			assert.strictEqual(result.output, "ok")
			assert.strictEqual(
				log.filter((seen) => seen.url.pathname === "/api/sandbox/sb1/start")
					.length,
				1,
			)
			assert.strictEqual(yield* machine.state, "running")
		}),
)

it.effect(
	"Daytona gives a port a signed preview link, and destroy ignores a gone sandbox",
	() =>
		Effect.gen(function* () {
			const { machine, log } = yield* attach((seen) =>
				seen.url.pathname === "/api/sandbox/sb1/ports/3000/signed-preview-url"
					? json({
							sandboxId: "sb1",
							port: 3000,
							token: "tk",
							url: "https://3000-tk.proxy.daytona.test/",
						})
					: new Response(null, { status: 404 }),
			)
			assert.strictEqual(
				yield* machine.ports!.open(3000),
				"https://3000-tk.proxy.daytona.test",
			)
			const link = log.find((seen) =>
				seen.url.pathname.endsWith("/signed-preview-url"),
			)
			assert.strictEqual(
				link?.url.searchParams.get("expiresInSeconds"),
				"86400",
			)
			yield* machine.destroy
			assert.strictEqual(log.at(-1)?.method, "DELETE")
			assert.strictEqual(machine.desktop, undefined)
		}),
)

it.effect("Daytona maps a wrong key and a gone sandbox", () =>
	Effect.gen(function* () {
		const { client } = fake((seen) =>
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
		const failed = fake(() => json({ message: "down" }, 503))
		const later = yield* Effect.flip(
			(yield* provider(failed.client)).create({ desktop: false, labels: {} }),
		)
		assert.strictEqual(later.retry, true)
	}),
)

it.live(
	"Daytona starts computer use first, then takes a screenshot and does actions",
	() =>
		Effect.gen(function* () {
			const png = new Uint8Array(32)
			png.set([0x89, 0x50, 0x4e, 0x47], 0)
			new DataView(png.buffer).setUint32(16, 1280)
			new DataView(png.buffer).setUint32(20, 720)
			let active = false
			const { machine, log } = yield* attach((seen) => {
				const path = seen.url.pathname.slice(toolbox.length)
				if (path === "/computeruse/status")
					return json({ status: active ? "active" : "inactive" })
				if (path === "/computeruse/start") {
					active = true
					return json({ message: "started" })
				}
				if (path === "/computeruse/screenshot")
					return json({ screenshot: Buffer.from(png).toString("base64") })
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
				log.filter((seen) => seen.url.pathname.endsWith("/computeruse/start"))
					.length,
				1,
			)
			yield* machine.desktop!.act([
				{ _tag: "Click", x: 1, y: 2, button: "right" },
				{ _tag: "Scroll", x: 5, y: 5, deltaX: 0, deltaY: -3 },
				{ _tag: "Key", keys: ["ctrl", "c"] },
				{ _tag: "Key", keys: ["enter"] },
			])
			const sent = log
				.filter(
					(seen) =>
						seen.url.pathname.includes("/computeruse/mouse/") ||
						seen.url.pathname.includes("/computeruse/keyboard/"),
				)
				.map((seen) => [seen.url.pathname.slice(toolbox.length), seen.body])
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
			const stream = yield* machine.desktop!.stream
			assert.strictEqual(
				stream.url,
				"https://6080-tk.proxy.daytona.test/vnc.html?autoconnect=true&resize=scale",
			)
			assert.ok(stream.expiresAt !== null && stream.expiresAt > Date.now())
		}),
)
