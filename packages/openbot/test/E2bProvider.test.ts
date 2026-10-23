import assert from "node:assert/strict"
import { test } from "node:test"
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
	Effect.runPromise(
		E2bProvider.make(credentials).pipe(
			Effect.provideService(HttpClient.HttpClient, client),
		),
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

const attach = async (
	answer: Answer,
): Promise<{ machine: Machine; log: Array<Seen>; provider: Provider }> => {
	const { log, client } = fake((seen) =>
		seen.method === "GET" && seen.url.pathname === "/sandboxes/sbx1"
			? json(running)
			: answer(seen),
	)
	const value = await provider(client)
	const machine = await Effect.runPromise(value.attach("sbx1"))
	return { machine, log, provider: value }
}

test("E2B makes a sandbox from the template, with labels and the desktop flag", async () => {
	const { log, client } = fake(() =>
		json({ sandboxID: "sbx9", envdAccessToken: "t" }, 201),
	)
	const value = await provider(client)
	const made = await Effect.runPromise(
		value.create({ desktop: true, labels: { computer: "c1" } }),
	)
	assert.deepEqual(made, { ref: "sbx9" })
	const seen = log[0]
	assert.equal(seen?.method, "POST")
	assert.equal(seen?.url.href, "https://api.e2b.test/sandboxes")
	assert.equal(seen?.headers["x-api-key"], "e2b-test-key")
	assert.deepEqual(seen?.body, {
		templateID: "desktop",
		timeout: 3600,
		autoPause: true,
		secure: true,
		metadata: { computer: "c1", "openbot-desktop": "true" },
		envVars: { DISPLAY: ":0" },
	})
	await Effect.runPromise(value.create({ desktop: false, labels: {} }))
	assert.equal((log[1]?.body as { templateID: string }).templateID, "base")
	await Effect.runPromise(
		value.create({ template: "my-template", desktop: false, labels: {} }),
	)
	assert.equal(
		(log[2]?.body as { templateID: string }).templateID,
		"my-template",
	)
})

test("E2B runs a command over the envd stream and keeps stdout, stderr and the exit code", async () => {
	const { machine, log } = await attach(() =>
		processStream([
			{ start: { pid: 7 } },
			{ data: { stdout: base64("hello\n") } },
			{ data: { stderr: base64("warn\n") } },
			{ keepalive: {} },
			{ end: { exitCode: 3, exited: true, status: "exit status 3" } },
		]),
	)
	const result = await Effect.runPromise(
		machine.shell.run({ command: "echo hello", cwd: "/tmp", env: { A: "1" } }),
	)
	assert.equal(result.exitCode, 3)
	assert.equal(result.stdout, "hello\n")
	assert.equal(result.stderr, "warn\n")
	assert.equal(result.truncated, false)
	const start = log.find(
		(seen) => seen.url.pathname === "/process.Process/Start",
	)
	assert.equal(start?.url.host, "49983-sbx1.e2b.test")
	assert.equal(start?.headers["x-access-token"], "envd-token")
	assert.equal(start?.headers["x-api-key"], undefined)
	assert.equal(start?.headers["content-type"], "application/connect+json")
	const sent = start?.body as Uint8Array
	assert.deepEqual(JSON.parse(new TextDecoder().decode(sent.subarray(5))), {
		process: {
			cmd: "/bin/bash",
			args: ["-l", "-c", "echo hello"],
			envs: { A: "1" },
			cwd: "/tmp",
		},
		stdin: false,
	})
})

test("E2B keeps only the end of long output, and a missing exit code is 0", async () => {
	const first = "a".repeat(80_000)
	const second = "b".repeat(70_000)
	const { machine } = await attach(() =>
		processStream([
			{ start: { pid: 7 } },
			{ data: { stdout: base64(first) } },
			{ data: { stdout: base64(second) } },
			{ end: { exited: true } },
		]),
	)
	const result = await Effect.runPromise(machine.shell.run({ command: "big" }))
	assert.equal(result.exitCode, 0)
	assert.equal(result.truncated, true)
	assert.equal(result.stdout.length, 100_000)
	assert.ok(result.stdout.endsWith(second))
})

test("E2B stops a command at its timeout, kills it and gives back the output so far", async () => {
	const { machine, log } = await attach((seen) => {
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
	const result = await Effect.runPromise(
		machine.shell.run({ command: "sleep 100", timeout: 1 }),
	)
	assert.equal(result.exitCode, null)
	assert.equal(result.stdout, "partial")
	const kill = log.find(
		(seen) => seen.url.pathname === "/process.Process/SendSignal",
	)
	assert.deepEqual(kill?.body, {
		process: { pid: 42 },
		signal: "SIGNAL_SIGKILL",
	})
})

test("E2B reads, writes, lists and removes files through envd", async () => {
	const { machine, log } = await attach(async (seen) => {
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
	const text = await Effect.runPromise(machine.shell.read("a.txt", "utf8"))
	assert.deepEqual(text, { path: "a.txt", encoding: "utf8", content: "héllo" })
	const bytes = await Effect.runPromise(machine.shell.read("a.txt", "base64"))
	assert.equal(bytes.content, base64("héllo"))
	const read = log.find((seen) => seen.url.pathname === "/files")
	assert.equal(read?.url.searchParams.get("path"), "a.txt")
	assert.equal(read?.url.searchParams.get("username"), "user")

	await Effect.runPromise(
		machine.shell.write({
			path: "a.txt",
			encoding: "base64",
			content: base64("hi"),
		}),
	)
	const write = log.find(
		(seen) => seen.url.pathname === "/files" && seen.method === "POST",
	)
	const file = (write?.body as FormData).get("file") as Blob
	assert.equal(await file.text(), "hi")

	const entries = await Effect.runPromise(machine.shell.list("/home/user"))
	assert.deepEqual(entries, [
		{
			name: "src",
			kind: "directory",
			size: 4096,
			modifiedAt: Date.parse("2026-10-23T10:00:00Z"),
		},
		{ name: "a.txt", kind: "file", size: 5, modifiedAt: 0 },
		{ name: "l", kind: "link", size: 0, modifiedAt: 0 },
	])
	await Effect.runPromise(machine.shell.remove("/home/user/src"))
	const remove = log.find(
		(seen) => seen.url.pathname === "/filesystem.Filesystem/Remove",
	)
	assert.deepEqual(remove?.body, { path: "/home/user/src" })
})

test("E2B maps a missing file to a failure that a retry cannot fix", async () => {
	const { machine } = await attach(() =>
		json({ code: 404, message: "path '/x' does not exist" }, 404),
	)
	const error = await Effect.runPromise(
		Effect.flip(machine.shell.read("/x", "utf8")),
	)
	assert.equal(error._tag, "ComputerCallFailed")
	assert.equal(error._tag === "ComputerCallFailed" && error.retry, false)
	assert.match(
		error._tag === "ComputerCallFailed" ? error.message : "",
		/does not exist/,
	)
})

test("E2B pauses with memory kept, and resumes with connect on the next call", async () => {
	let envdCalls = 0
	const { machine, log } = await attach((seen) => {
		if (seen.url.pathname === "/sandboxes/sbx1/pause")
			return new Response(null, { status: 204 })
		if (seen.url.pathname === "/sandboxes/sbx1/connect")
			return json({ ...running, envdAccessToken: "fresh-token" }, 201)
		envdCalls += 1
		return json({ entries: [] })
	})
	await Effect.runPromise(machine.pausable!.pause)
	const pause = log.find(
		(seen) => seen.url.pathname === "/sandboxes/sbx1/pause",
	)
	assert.equal(pause?.method, "POST")
	await Effect.runPromise(machine.shell.list("/"))
	const connect = log.find(
		(seen) => seen.url.pathname === "/sandboxes/sbx1/connect",
	)
	assert.deepEqual(connect?.body, { timeout: 3600 })
	const list = log.find(
		(seen) => seen.url.pathname === "/filesystem.Filesystem/ListDir",
	)
	assert.equal(list?.headers["x-access-token"], "fresh-token")
	assert.equal(envdCalls, 1)
})

test("E2B resumes a sandbox that the proxy reports away, and tries once more", async () => {
	let first = true
	const { machine, log } = await attach((seen) => {
		if (seen.url.pathname === "/sandboxes/sbx1/connect") return json(running)
		if (first) {
			first = false
			return json({ sandboxId: "sbx1", message: "The sandbox is paused" }, 502)
		}
		return json({ entries: [] })
	})
	assert.deepEqual(await Effect.runPromise(machine.shell.list("/")), [])
	assert.equal(
		log.filter((seen) => seen.url.pathname === "/sandboxes/sbx1/connect")
			.length,
		1,
	)
})

test("E2B gives a port an address on the sandbox domain, and destroy ignores a gone sandbox", async () => {
	const { machine, log } = await attach(
		() => new Response(null, { status: 404 }),
	)
	assert.equal(
		await Effect.runPromise(machine.ports!.open(3000)),
		"https://3000-sbx1.e2b.test",
	)
	await Effect.runPromise(machine.destroy)
	const destroy = log.find((seen) => seen.method === "DELETE")
	assert.equal(destroy?.url.pathname, "/sandboxes/sbx1")
	assert.equal(machine.desktop, undefined)
})

test("E2B maps a wrong key and a gone sandbox", async () => {
	const { client } = fake((seen) =>
		seen.url.pathname === "/sandboxes"
			? json({ code: 401, message: "Invalid API key" }, 401)
			: json({ code: 404, message: "not found" }, 404),
	)
	const value = await provider(client)
	const denied = await Effect.runPromise(Effect.flip(value.verify))
	assert.equal(denied.retry, false)
	assert.match(denied.message, /API key/)
	const gone = await Effect.runPromise(Effect.flip(value.attach("sbx404")))
	assert.equal(gone._tag, "ComputerGone")
	const busy = fake(() => json({ message: "slow down" }, 429))
	const later = await Effect.runPromise(
		Effect.flip((await provider(busy.client)).verify),
	)
	assert.equal(later.retry, true)
})

test("E2B reads the state of a sandbox", async () => {
	const { client } = fake((seen) =>
		seen.url.pathname === "/sandboxes/sbx1"
			? json({ ...running, state: "paused" })
			: json({}, 404),
	)
	const value = await provider(client)
	const machine = await Effect.runPromise(value.attach("sbx1"))
	assert.equal(await Effect.runPromise(machine.state), "paused")
})

test("E2B takes a screenshot of the desktop with scrot and reads its size", async () => {
	const png = new Uint8Array(32)
	png.set([0x89, 0x50, 0x4e, 0x47], 0)
	new DataView(png.buffer).setUint32(16, 1024)
	new DataView(png.buffer).setUint32(20, 768)
	const { client, log } = fake((seen) => {
		if (seen.url.pathname === "/sandboxes/sbx1")
			return json({ ...running, metadata: { "openbot-desktop": "true" } })
		if (seen.url.pathname === "/process.Process/Start")
			return processStream([{ start: { pid: 1 } }, { end: { exited: true } }])
		if (seen.url.pathname === "/files") return new Response(png)
		return json({}, 404)
	})
	const machine = await Effect.runPromise(
		(await provider(client)).attach("sbx1"),
	)
	const shot = await Effect.runPromise(machine.desktop!.screenshot)
	assert.equal(shot.width, 1024)
	assert.equal(shot.height, 768)
	assert.equal(shot.data, Buffer.from(png).toString("base64"))
	await Effect.runPromise(
		machine.desktop!.act([
			{ _tag: "Click", x: 10, y: 20, double: true },
			{ _tag: "Key", keys: ["ctrl", "c"] },
			{ _tag: "Type", text: "it's" },
		]),
	)
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
})
