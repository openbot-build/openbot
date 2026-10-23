import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import {
	HttpClient,
	type HttpClientRequest,
	HttpClientResponse,
} from "effect/http"
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
	Effect.runPromise(
		DaytonaProvider.make(credentials).pipe(
			Effect.provideService(HttpClient.HttpClient, client),
		),
	)

const sandbox = (state: string, desktop = false) => ({
	id: "sb1",
	state,
	toolboxProxyUrl: "https://proxy.daytona.test/toolbox/",
	labels: { "openbot-desktop": desktop ? "true" : "false" },
})

const toolbox = "/toolbox/sb1"

/** Attaches to a started sandbox. Other calls go to `answer`. */
const attach = async (answer: Answer, desktop = false) => {
	const { log, client } = fake((seen) =>
		seen.method === "GET" && seen.url.pathname === "/api/sandbox/sb1"
			? json(sandbox("started", desktop))
			: answer(seen),
	)
	const machine = await Effect.runPromise(
		(await provider(client)).attach("sb1"),
	)
	return { machine, log }
}

/** Answers the wrapped command like bash would, with the marker of the request. */
const executed = (seen: Seen, stdout: string, stderr: string, code: number) => {
	const command = (seen.body as { command: string }).command
	const mark = /__OPENBOT_[0-9a-f]+__/.exec(command)?.[0] ?? ""
	return json({ exitCode: 0, result: `${stdout}\n${mark}${code}\n${stderr}` })
}

test("Daytona makes a sandbox from a snapshot, in the target, with labels", async () => {
	const { log, client } = fake(() => json(sandbox("creating")))
	const value = await provider(client)
	const made = await Effect.runPromise(
		value.create({
			template: "my-snapshot",
			desktop: true,
			labels: { computer: "c1" },
		}),
	)
	assert.deepEqual(made, { ref: "sb1" })
	assert.equal(log[0]?.url.href, "https://daytona.test/api/sandbox")
	assert.equal(log[0]?.headers["authorization"], "Bearer dtn-test-key")
	assert.deepEqual(log[0]?.body, {
		snapshot: "my-snapshot",
		target: "eu",
		labels: { computer: "c1", "openbot-desktop": "true" },
	})
})

test("Daytona runs a command through the toolbox and splits stdout and stderr", async () => {
	const { machine, log } = await attach((seen) =>
		executed(seen, "hello", "warn", 3),
	)
	const result = await Effect.runPromise(
		machine.shell.run({
			command: "echo hello",
			cwd: "/tmp",
			env: { A: "1" },
			timeout: 5,
		}),
	)
	assert.equal(result.exitCode, 3)
	assert.equal(result.stdout, "hello")
	assert.equal(result.stderr, "warn")
	assert.equal(result.truncated, false)
	const call = log.find((seen) =>
		seen.url.pathname.endsWith("/process/execute"),
	)
	assert.equal(
		call?.url.href,
		`https://proxy.daytona.test${toolbox}/process/execute`,
	)
	assert.equal(call?.headers["authorization"], "Bearer dtn-test-key")
	const body = call?.body as {
		command: string
		cwd: string
		envs: unknown
		timeout: number
	}
	assert.equal(body.cwd, "/tmp")
	assert.deepEqual(body.envs, { A: "1" })
	assert.equal(body.timeout, 35)
	assert.match(body.command, /timeout -k 5 5 bash -lc/)
	assert.match(body.command, /echo hello/)
})

test("Daytona marks a command that `timeout` stopped, and keeps only the end of long output", async () => {
	const long = "x".repeat(150_000)
	const { machine } = await attach((seen) =>
		executed(
			seen,
			long,
			"",
			(seen.body as { timeout: number }).timeout === 31 ? 124 : 0,
		),
	)
	const stopped = await Effect.runPromise(
		machine.shell.run({ command: "sleep 9", timeout: 1 }),
	)
	assert.equal(stopped.exitCode, null)
	assert.equal(stopped.truncated, true)
	assert.equal(stopped.stdout.length, 100_000)
})

test("Daytona reads, writes, lists and removes files through the toolbox", async () => {
	const { machine, log } = await attach((seen) => {
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
	assert.equal(
		(await Effect.runPromise(machine.shell.read("a.txt", "utf8"))).content,
		"héllo",
	)
	assert.equal(
		(await Effect.runPromise(machine.shell.read("a.txt", "base64"))).content,
		Buffer.from("héllo").toString("base64"),
	)
	await Effect.runPromise(
		machine.shell.write({
			path: "/home/daytona/a.txt",
			encoding: "utf8",
			content: "hi",
		}),
	)
	const upload = log.find((seen) =>
		seen.url.pathname.endsWith("/files/bulk-upload"),
	)
	const form = upload?.body as FormData
	assert.equal(form.get("files[0].path"), "/home/daytona/a.txt")
	assert.equal(await (form.get("files[0].file") as Blob).text(), "hi")
	assert.deepEqual(await Effect.runPromise(machine.shell.list("/home")), [
		{
			name: "src",
			kind: "directory",
			size: 4096,
			modifiedAt: Date.parse("2026-10-23T10:00:00Z"),
		},
		{ name: "a.txt", kind: "file", size: 5, modifiedAt: 0 },
		{ name: "l", kind: "link", size: 1, modifiedAt: 0 },
	])
	await Effect.runPromise(machine.shell.remove("/home/src"))
	const remove = log.find((seen) => seen.method === "DELETE")
	assert.equal(remove?.url.searchParams.get("path"), "/home/src")
	assert.equal(remove?.url.searchParams.get("recursive"), "true")
	const missing = await Effect.runPromise(
		Effect.flip(machine.shell.read("/nope", "utf8")),
	)
	assert.equal(missing._tag, "ComputerCallFailed")
	assert.equal(missing._tag === "ComputerCallFailed" && missing.retry, false)
})

test("Daytona stops the sandbox to pause it, and starts it again on the next call", async () => {
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
		return executed(seen, "ok", "", 0)
	})
	const machine = await Effect.runPromise(
		(await provider(client)).attach("sb1"),
	)
	await Effect.runPromise(machine.pausable!.pause)
	assert.equal(await Effect.runPromise(machine.state), "paused")
	const result = await Effect.runPromise(machine.shell.run({ command: "true" }))
	assert.equal(result.stdout, "ok")
	assert.equal(
		log.filter((seen) => seen.url.pathname === "/api/sandbox/sb1/start").length,
		1,
	)
	assert.equal(await Effect.runPromise(machine.state), "running")
})

test("Daytona gives a port a signed preview link, and destroy ignores a gone sandbox", async () => {
	const { machine, log } = await attach((seen) =>
		seen.url.pathname === "/api/sandbox/sb1/ports/3000/signed-preview-url"
			? json({
					sandboxId: "sb1",
					port: 3000,
					token: "tk",
					url: "https://3000-tk.proxy.daytona.test/",
				})
			: new Response(null, { status: 404 }),
	)
	assert.equal(
		await Effect.runPromise(machine.ports!.open(3000)),
		"https://3000-tk.proxy.daytona.test",
	)
	const link = log.find((seen) =>
		seen.url.pathname.endsWith("/signed-preview-url"),
	)
	assert.equal(link?.url.searchParams.get("expiresInSeconds"), "86400")
	await Effect.runPromise(machine.destroy)
	assert.equal(log.at(-1)?.method, "DELETE")
	assert.equal(machine.desktop, undefined)
})

test("Daytona maps a wrong key and a gone sandbox", async () => {
	const { client } = fake((seen) =>
		seen.url.pathname === "/api/api-keys/current"
			? json({ statusCode: 401, message: "Unauthorized" }, 401)
			: json({ statusCode: 404, message: "Sandbox not found" }, 404),
	)
	const value = await provider(client)
	const denied = await Effect.runPromise(Effect.flip(value.verify))
	assert.equal(denied.retry, false)
	assert.match(denied.message, /API key/)
	const gone = await Effect.runPromise(Effect.flip(value.attach("sb404")))
	assert.equal(gone._tag, "ComputerGone")
	const failed = fake(() => json({ message: "down" }, 503))
	const later = await Effect.runPromise(
		Effect.flip(
			(await provider(failed.client)).create({ desktop: false, labels: {} }),
		),
	)
	assert.equal(later.retry, true)
})

test("Daytona starts computer use first, then takes a screenshot and does actions", async () => {
	const png = new Uint8Array(32)
	png.set([0x89, 0x50, 0x4e, 0x47], 0)
	new DataView(png.buffer).setUint32(16, 1280)
	new DataView(png.buffer).setUint32(20, 720)
	let active = false
	const { machine, log } = await attach((seen) => {
		const path = seen.url.pathname.slice(toolbox.length)
		if (path === "/computeruse/status")
			return json({ status: active ? "active" : "inactive" })
		if (path === "/computeruse/start") {
			active = true
			return json({ message: "started" })
		}
		if (path === "/computeruse/screenshot")
			return json({ screenshot: Buffer.from(png).toString("base64") })
		if (seen.url.pathname === "/api/sandbox/sb1/ports/6080/signed-preview-url")
			return json({ url: "https://6080-tk.proxy.daytona.test" })
		return json({})
	}, true)
	const shot = await Effect.runPromise(machine.desktop!.screenshot)
	assert.equal(shot.width, 1280)
	assert.equal(shot.height, 720)
	assert.equal(
		log.filter((seen) => seen.url.pathname.endsWith("/computeruse/start"))
			.length,
		1,
	)
	await Effect.runPromise(
		machine.desktop!.act([
			{ _tag: "Click", x: 1, y: 2, button: "right" },
			{ _tag: "Scroll", x: 5, y: 5, deltaX: 0, deltaY: -3 },
			{ _tag: "Key", keys: ["ctrl", "c"] },
			{ _tag: "Key", keys: ["enter"] },
		]),
	)
	const sent = log
		.filter(
			(seen) =>
				seen.url.pathname.includes("/computeruse/mouse/") ||
				seen.url.pathname.includes("/computeruse/keyboard/"),
		)
		.map((seen) => [seen.url.pathname.slice(toolbox.length), seen.body])
	assert.deepEqual(sent, [
		[
			"/computeruse/mouse/click",
			{ x: 1, y: 2, button: "right", double: false },
		],
		["/computeruse/mouse/scroll", { x: 5, y: 5, direction: "up", amount: 3 }],
		["/computeruse/keyboard/hotkey", { keys: "ctrl+c" }],
		["/computeruse/keyboard/key", { key: "enter" }],
	])
	const stream = await Effect.runPromise(machine.desktop!.stream)
	assert.equal(
		stream.url,
		"https://6080-tk.proxy.daytona.test/vnc.html?autoconnect=true&resize=scale",
	)
	assert.ok(stream.expiresAt !== null && stream.expiresAt > Date.now())
})
