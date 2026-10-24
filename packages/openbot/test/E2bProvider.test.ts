import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import {
	HttpClient,
	type HttpClientRequest,
	HttpClientResponse,
} from "effect/http"
import type { Machine, Provider } from "../src/computers/Computer.ts"
import * as E2bProvider from "../src/computers/e2b/E2bProvider.ts"
import { envelope } from "../src/computers/e2b/Envd.ts"

interface Seen {
	readonly method: string
	readonly url: URL
	readonly headers: Readonly<Record<string, string>>
	readonly body: unknown
}

type Answer = (seen: Seen) => Response | Promise<Response>

const bodyOf = async (request: HttpClientRequest.HttpClientRequest) => {
	const body = request.body
	if (body._tag === "Uint8Array") {
		const text = new TextDecoder().decode(body.body)
		try {
			return JSON.parse(text)
		} catch {
			return body.body
		}
	}
	if (body._tag === "FormData") return body.formData
	return undefined
}

/** A fake E2B: one function answers every request, and the test keeps a log. */
const fake = (answer: Answer) => {
	const log: Array<Seen> = []
	const client = HttpClient.make((request, url) =>
		Effect.promise(async () => {
			const seen: Seen = {
				method: request.method,
				url,
				headers: request.headers,
				body: await bodyOf(request),
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

const credentials: E2bProvider.Credentials = {
	kind: "e2b",
	apiKey: "e2b-test-key",
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
		...events.map((event) => envelope({ event })),
		envelope(end, 0x02),
	]
	return new Response(Buffer.concat(parts), {
		headers: { "content-type": "application/connect+json" },
	})
}

const attach = (answer: Answer) =>
	Effect.gen(function* () {
		const { log, client } = fake((seen) =>
			seen.method === "GET" && seen.url.pathname === "/sandboxes/sbx1"
				? json(running)
				: answer(seen),
		)
		const value: Provider = yield* provider(client)
		const machine: Machine = yield* value.attach("sbx1")
		return { machine, log, provider: value }
	})

it.effect(
	"E2B makes a sandbox from the template, with labels and the desktop flag",
	() =>
		Effect.gen(function* () {
			const { log, client } = fake(() =>
				json({ sandboxID: "sbx9", envdAccessToken: "t" }, 201),
			)
			const value = yield* provider(client)
			const made = yield* value.create({
				desktop: true,
				labels: { computer: "c1" },
			})
			assert.deepStrictEqual(made, { ref: "sbx9" })
			const seen = log[0]
			assert.strictEqual(seen?.method, "POST")
			assert.strictEqual(seen?.url.href, "https://api.e2b.test/sandboxes")
			assert.strictEqual(seen?.headers["x-api-key"], "e2b-test-key")
			assert.deepStrictEqual(seen?.body, {
				templateID: "desktop",
				timeout: 3600,
				autoPause: true,
				secure: true,
				metadata: { computer: "c1", "openbot-desktop": "true" },
				envVars: { DISPLAY: ":0" },
			})
			yield* value.create({ desktop: false, labels: {} })
			assert.strictEqual(
				(log[1]?.body as { templateID: string }).templateID,
				"base",
			)
			yield* value.create({
				template: "my-template",
				desktop: false,
				labels: {},
			})
			assert.strictEqual(
				(log[2]?.body as { templateID: string }).templateID,
				"my-template",
			)
		}),
)

it.effect(
	"E2B runs a command over the envd stream and keeps stdout, stderr and the exit code",
	() =>
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
			const result = yield* machine.shell.run({
				command: "echo hello",
				cwd: "/tmp",
				env: { A: "1" },
			})
			assert.strictEqual(result.exitCode, 3)
			assert.strictEqual(result.stdout, "hello\n")
			assert.strictEqual(result.stderr, "warn\n")
			assert.strictEqual(result.truncated, false)
			const start = log.find(
				(seen) => seen.url.pathname === "/process.Process/Start",
			)
			assert.strictEqual(start?.url.host, "49983-sbx1.e2b.test")
			assert.strictEqual(start?.headers["x-access-token"], "envd-token")
			assert.strictEqual(start?.headers["x-api-key"], undefined)
			assert.strictEqual(
				start?.headers["content-type"],
				"application/connect+json",
			)
			const sent = start?.body as Uint8Array
			assert.deepStrictEqual(
				JSON.parse(new TextDecoder().decode(sent.subarray(5))),
				{
					process: {
						cmd: "/bin/bash",
						args: ["-l", "-c", "echo hello"],
						envs: { A: "1" },
						cwd: "/tmp",
					},
					stdin: false,
				},
			)
		}),
)

it.effect(
	"E2B keeps only the end of long output, and a missing exit code is 0",
	() =>
		Effect.gen(function* () {
			const first = "a".repeat(80_000)
			const second = "b".repeat(70_000)
			const { machine } = yield* attach(() =>
				processStream([
					{ start: { pid: 7 } },
					{ data: { stdout: base64(first) } },
					{ data: { stdout: base64(second) } },
					{ end: { exited: true } },
				]),
			)
			const result = yield* machine.shell.run({ command: "big" })
			assert.strictEqual(result.exitCode, 0)
			assert.strictEqual(result.truncated, true)
			assert.strictEqual(result.stdout.length, 100_000)
			assert.ok(result.stdout.endsWith(second))
		}),
)

it.live(
	"E2B stops a command at its timeout, kills it and gives back the output so far",
	() =>
		Effect.gen(function* () {
			const { machine, log } = yield* attach((seen) => {
				if (seen.url.pathname === "/process.Process/SendSignal") return json({})
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
			const result = yield* machine.shell.run({
				command: "sleep 100",
				timeout: 1,
			})
			assert.strictEqual(result.exitCode, null)
			assert.strictEqual(result.stdout, "partial")
			const kill = log.find(
				(seen) => seen.url.pathname === "/process.Process/SendSignal",
			)
			assert.deepStrictEqual(kill?.body, {
				process: { pid: 42 },
				signal: "SIGNAL_SIGKILL",
			})
		}),
)

it.effect("E2B reads, writes, lists and removes files through envd", () =>
	Effect.gen(function* () {
		const { machine, log } = yield* attach(async (seen) => {
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
		const read = log.find((seen) => seen.url.pathname === "/files")
		assert.strictEqual(read?.url.searchParams.get("path"), "a.txt")
		assert.strictEqual(read?.url.searchParams.get("username"), "user")

		yield* machine.shell.write({
			path: "a.txt",
			encoding: "base64",
			content: base64("hi"),
		})
		const write = log.find(
			(seen) => seen.url.pathname === "/files" && seen.method === "POST",
		)
		const file = (write?.body as FormData).get("file") as Blob
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
		const remove = log.find(
			(seen) => seen.url.pathname === "/filesystem.Filesystem/Remove",
		)
		assert.deepStrictEqual(remove?.body, { path: "/home/user/src" })
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
			error._tag === "ComputerCallFailed" && error.retry,
			false,
		)
		assert.match(
			error._tag === "ComputerCallFailed" ? error.message : "",
			/does not exist/,
		)
	}),
)

it.effect(
	"E2B pauses with memory kept, and resumes with connect on the next call",
	() =>
		Effect.gen(function* () {
			let envdCalls = 0
			const { machine, log } = yield* attach((seen) => {
				if (seen.url.pathname === "/sandboxes/sbx1/pause")
					return new Response(null, { status: 204 })
				if (seen.url.pathname === "/sandboxes/sbx1/connect")
					return json({ ...running, envdAccessToken: "fresh-token" }, 201)
				envdCalls += 1
				return json({ entries: [] })
			})
			yield* machine.pausable!.pause
			const pause = log.find(
				(seen) => seen.url.pathname === "/sandboxes/sbx1/pause",
			)
			assert.strictEqual(pause?.method, "POST")
			yield* machine.shell.list("/")
			const connect = log.find(
				(seen) => seen.url.pathname === "/sandboxes/sbx1/connect",
			)
			assert.deepStrictEqual(connect?.body, { timeout: 3600 })
			const list = log.find(
				(seen) => seen.url.pathname === "/filesystem.Filesystem/ListDir",
			)
			assert.strictEqual(list?.headers["x-access-token"], "fresh-token")
			assert.strictEqual(envdCalls, 1)
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
				log.filter((seen) => seen.url.pathname === "/sandboxes/sbx1/connect")
					.length,
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
			const destroy = log.find((seen) => seen.method === "DELETE")
			assert.strictEqual(destroy?.url.pathname, "/sandboxes/sbx1")
			assert.strictEqual(machine.desktop, undefined)
		}),
)

it.effect("E2B maps a wrong key and a gone sandbox", () =>
	Effect.gen(function* () {
		const { client } = fake((seen) =>
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
		const busy = fake(() => json({ message: "slow down" }, 429))
		const later = yield* Effect.flip((yield* provider(busy.client)).verify)
		assert.strictEqual(later.retry, true)
	}),
)

it.effect("E2B reads the state of a sandbox", () =>
	Effect.gen(function* () {
		const { client } = fake((seen) =>
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
			const { client, log } = fake((seen) => {
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
			const script = log
				.filter((seen) => seen.url.pathname === "/process.Process/Start")
				.map((seen) => {
					const sent = seen.body as Uint8Array
					return JSON.parse(new TextDecoder().decode(sent.subarray(5))).process
						.args[2] as string
				})
				.at(-1)
			assert.match(script ?? "", /xdotool mousemove --sync 10 20/)
			assert.match(script ?? "", /xdotool click --repeat 2 1/)
			assert.match(script ?? "", /xdotool key -- 'Control_L\+c'/)
			assert.match(script ?? "", /xdotool type --delay 12 -- 'it'\\''s'/)
		}),
)
