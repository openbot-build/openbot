import assert from "node:assert/strict"
import { test } from "node:test"
import { Session } from "@openbot-build/core"
import { ComputersApi, RequestsApi, SessionView } from "@openbot-build/api"
import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Response } from "effect/ai"
import { Machine, Provider } from "../src/computers/Computer.ts"
import { Drivers } from "../src/computers/Drivers.ts"
import {
	keepNewestImage,
	names,
} from "../src/plugins/computers/ComputerPlugin.ts"
import * as BrowserHost from "./BrowserHost.ts"

const publicOrigin = "https://computers.example.com"
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}

/** A provider that keeps its sandboxes in memory, and writes down what happened. */
const fakeProvider = () => {
	const log: Array<string> = []
	const files = new Map<string, string>()
	let next = 0
	const machine = (ref: string) =>
		new Machine({
			shell: {
				run: (request) =>
					Effect.sync(() => {
						log.push("run " + ref + " " + request.command)
						return {
							exitCode: 0,
							stdout: "ran: " + request.command,
							stderr: "",
							truncated: false,
							durationMs: 1,
						}
					}),
				read: (path, encoding) =>
					Effect.succeed({ path, encoding, content: files.get(path) ?? "" }),
				write: (file) =>
					Effect.sync(() => {
						files.set(file.path, file.content)
					}),
				list: () =>
					Effect.succeed(
						[...files.keys()].map((name) => ({
							name,
							kind: "file" as const,
							size: 1,
							modifiedAt: 0,
						})),
					),
				remove: (path) =>
					Effect.sync(() => {
						files.delete(path)
					}),
			},
			pausable: {
				pause: Effect.sync(() => {
					log.push("pause " + ref)
				}),
				resume: Effect.sync(() => {
					log.push("resume " + ref)
				}),
			},
			desktop: {
				screenshot: Effect.succeed({
					mediaType: "image/png" as const,
					data: "aW1hZ2U=",
					width: 800,
					height: 600,
				}),
				act: (actions) =>
					Effect.sync(() => {
						log.push("act " + actions.length)
					}),
				stream: Effect.succeed({
					url: "https://view.example.com/" + ref,
					expiresAt: null,
				}),
			},
			ports: {
				open: (port) => Effect.succeed(`https://${port}-${ref}.example.com`),
			},
			state: Effect.succeed("running"),
			destroy: Effect.sync(() => {
				log.push("destroy " + ref)
			}),
		})
	const layer = Layer.succeed(
		Drivers,
		Drivers.of({
			make: () =>
				Effect.succeed(
					new Provider({
						kind: "e2b",
						verify: Effect.void,
						create: () =>
							Effect.sync(() => {
								const ref = "sbx-" + next++
								log.push("create " + ref)
								return { ref }
							}),
						attach: (ref) => Effect.succeed(machine(ref)),
					}),
				),
		}),
	)
	return { log, layer }
}

const textOf = (message: Prompt.Message) =>
	typeof message.content === "string"
		? message.content
		: message.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("")

let calls = 0
const call = (name: string, params: Record<string, unknown>) =>
	Stream.make(
		Response.makePart("tool-call", {
			id: "call-" + calls++,
			name,
			params,
			providerExecuted: false,
		}),
		Response.makePart("finish", { reason: "tool-calls", usage }),
	)
const answer = (text: string) =>
	Stream.make(
		Response.makePart("text-start", { id: "answer" }),
		Response.makePart("text-delta", { id: "answer", delta: text }),
		Response.makePart("text-end", { id: "answer" }),
		Response.makePart("finish", { reason: "stop", usage }),
	)

/**
 * A scripted model. `run <id>` runs a command, `get <id>` asks for the Computer.
 * After a tool result, it answers with that result.
 */
const model = Effect.runSync(
	LanguageModel.make({
		generateText: () =>
			Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
		streamText: ({ prompt }) =>
			Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
				const last = prompt.content.findLastIndex(
					(message) => message.role === "user",
				)
				const input = textOf(prompt.content[last]!)
				const after = prompt.content.slice(last + 1)
				const result = after.findLast((message) => message.role === "tool")
				const [verb, id] = input.split(" ")
				if (result !== undefined)
					return answer("Result: " + JSON.stringify(result.content))
				if (verb === "run")
					return call(names.run, { computer: id, command: "echo hi" })
				if (verb === "get")
					return call(names.acquire, { computer: id, reason: "I need it." })
				return answer("Hello.")
			}),
	}),
)

const client = (host: Awaited<ReturnType<typeof BrowserHost.start>>) => {
	const send = (
		credential: Redacted.Redacted<string> | undefined,
		path: string,
		method = "GET",
		payload?: unknown,
		headers: Record<string, string> = {},
	) =>
		fetch(host.address + path, {
			method,
			headers: {
				...(credential === undefined
					? {}
					: {
							cookie:
								"__Host-openbot-session=" +
								encodeURIComponent(Redacted.value(credential)),
						}),
				origin: publicOrigin,
				...(payload === undefined
					? {}
					: { "content-type": "application/json" }),
				...headers,
			},
			...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
		})
	const json = async <A, I>(
		schema: Schema.Codec<A, I>,
		response: Promise<globalThis.Response>,
	): Promise<A> => {
		const value = await response
		const body = await value.text()
		assert.ok(value.ok, value.status + " " + body)
		return Schema.decodeUnknownSync(schema)(JSON.parse(body))
	}
	const pause = () => new Promise((resolve) => setTimeout(resolve, 25))
	const until = async <A>(
		label: string,
		check: () => Promise<A | undefined>,
	): Promise<A> => {
		for (let tries = 0; tries < 400; tries++) {
			const value = await check()
			if (value !== undefined) return value
			await pause()
		}
		throw new Error("Timed out: " + label)
	}
	return { send, json, until }
}

test(
	"people add Computer providers, make Computers, and give Bots the right to use them",
	{ timeout: 120000 },
	async () => {
		const fake = fakeProvider()
		const host = await BrowserHost.start({
			publicOrigin,
			model,
			computerDrivers: fake.layer,
		})
		try {
			const { send, json } = client(host)
			const alice = await host.login("computers-alice")
			const bob = await host.login("computers-bob")

			const provider = await json(
				ComputersApi.ComputerProvider,
				send(alice.session, "/v1/computer-providers", "POST", {
					name: "Sandboxes",
					credentials: { kind: "e2b", apiKey: "e2b_test_key_123456" },
				}),
			)
			assert.deepEqual(provider.credentials, {
				kind: "e2b",
				apiKey: { set: true, hint: "…3456" },
				apiUrl: null,
				sandboxDomain: null,
			})
			assert.equal(
				(await send(bob.session, "/v1/computer-providers/" + provider.id))
					.status,
				404,
			)
			const shared = await send(bob.session, "/v1/computer-providers", "POST", {
				name: "Team",
				credentials: { kind: "e2b", apiKey: "e2b_test_key_654321" },
				shared: true,
			})
			assert.equal(shared.status, 403, await shared.clone().text())

			const computer = await json(
				ComputersApi.Computer,
				send(alice.session, "/v1/computers", "POST", {
					name: "Box",
					source: { _tag: "Provider", provider: provider.id, template: null },
					desktop: true,
				}),
			)
			assert.equal(computer.state, "running")
			assert.deepEqual(computer.features, {
				pause: true,
				desktop: true,
				ports: true,
			})
			const path = "/v1/computers/" + computer.id
			assert.equal((await send(bob.session, path)).status, 404)

			const ran = await json(
				ComputersApi.CommandResult,
				send(alice.session, path + "/commands", "POST", { command: "ls" }),
			)
			assert.equal(ran.stdout, "ran: ls")
			const written = await send(alice.session, path + "/files", "PUT", {
				path: "/tmp/a.txt",
				encoding: "utf8",
				content: "hello",
			})
			assert.equal(written.status, 204, await written.clone().text())
			const read = await json(
				ComputersApi.FileContent,
				send(alice.session, path + "/files?path=%2Ftmp%2Fa.txt"),
			)
			assert.equal(read.content, "hello")
			const port = await json(
				ComputersApi.OpenPort,
				send(alice.session, path + "/ports/3000", "PUT"),
			)
			assert.equal(port.url, "https://3000-sbx-0.example.com")
			const shot = await json(
				ComputersApi.Screenshot,
				send(alice.session, path + "/desktop/actions", "POST", {
					actions: [{ _tag: "Click", x: 1, y: 2 }],
				}),
			)
			assert.equal(shot.width, 800)

			// A paused Computer resumes by itself for the next command.
			const paused = await json(
				ComputersApi.Computer,
				send(alice.session, path + "/pause", "POST"),
			)
			assert.equal(paused.state, "paused")
			await json(
				ComputersApi.CommandResult,
				send(alice.session, path + "/commands", "POST", { command: "pwd" }),
			)
			assert.equal(
				(await json(ComputersApi.Computer, send(alice.session, path))).state,
				"running",
			)
			assert.deepEqual(
				fake.log.filter((line) => /^(create|pause|resume)/.test(line)),
				["create sbx-0", "pause sbx-0", "resume sbx-0"],
			)
			const usageList = await json(
				Schema.Array(ComputersApi.ComputerUsage),
				send(alice.session, path + "/usage"),
			)
			assert.equal(usageList.length, 2)
			assert.equal(usageList[0]!.endedAt, null)

			// Alice gives her Bot the right to use the Computer, and takes it back.
			const bot = await host.defaultBot(alice.session)
			const granted = await json(
				ComputersApi.ComputerAccess,
				send(alice.session, path + "/bots/" + bot, "PUT"),
			)
			assert.equal(granted.bot, bot)
			assert.deepEqual(
				(
					await json(
						Schema.Array(ComputersApi.Computer),
						send(alice.session, "/v1/computers?bot=" + bot),
					)
				).map((entry) => entry.id),
				[computer.id],
			)
			assert.equal(
				(await send(bob.session, path + "/bots/" + bot, "PUT")).status,
				404,
			)
			assert.equal(
				(await send(alice.session, path + "/bots/" + bot, "DELETE")).status,
				204,
			)
			assert.deepEqual(
				await json(
					Schema.Array(ComputersApi.ComputerAccess),
					send(alice.session, path + "/bots"),
				),
				[],
			)

			// The provider stays while a Computer uses it.
			assert.equal(
				(
					await send(
						alice.session,
						"/v1/computer-providers/" + provider.id,
						"DELETE",
					)
				).status,
				400,
			)
			assert.equal((await send(alice.session, path, "DELETE")).status, 204)
			assert.ok(fake.log.includes("destroy sbx-0"))
			assert.equal((await send(alice.session, path)).status, 404)
		} finally {
			await host.close()
		}
	},
)

test(
	"a machine pairs with a code, connects, and runs a command",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, until } = client(host)
			const alice = await host.login("pair-alice")
			const machine = {
				version: "1.0.0",
				os: "linux",
				arch: "x64",
				desktop: false,
				hostname: "alice-laptop",
				machineId: "machine-0123456789abcdef",
			}
			const start = () =>
				json(
					ComputersApi.Pairing,
					send(undefined, "/v1/hooks/computers/pairings", "POST", machine),
				)
			const poll = (pairing: ComputersApi.Pairing, secret = pairing.secret) =>
				send(
					undefined,
					"/v1/hooks/computers/pairings/" + pairing.id + "/poll",
					"POST",
					undefined,
					{ authorization: "Bearer " + secret },
				)

			const pairing = await start()
			assert.match(pairing.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
			assert.deepEqual(await json(ComputersApi.PairingStatus, poll(pairing)), {
				_tag: "Pending",
			})
			assert.equal((await poll(pairing, "ocp_wrong")).status, 404)
			// People may type the code in small letters and without the dash.
			const typed = pairing.code.replace("-", "").toLowerCase()
			const shown = await json(
				ComputersApi.ComputerPairing,
				send(alice.session, "/v1/computer-pairings/" + typed),
			)
			assert.equal(shown.hostname, "alice-laptop")
			const computer = await json(
				ComputersApi.Computer,
				send(
					alice.session,
					"/v1/computer-pairings/" + typed + "/approve",
					"POST",
					{},
				),
			)
			assert.equal(computer.name, "alice-laptop")
			assert.equal(computer.state, "offline")
			const approved = await json(ComputersApi.PairingStatus, poll(pairing))
			assert.equal(approved._tag, "Approved")
			if (approved._tag !== "Approved") return
			assert.equal(approved.computer, computer.id)
			// The token goes out only once.
			assert.equal((await poll(pairing)).status, 404)

			// The machine connects and answers a command.
			const url =
				host.address.replace(/^http/, "ws") + "/v1/hooks/computers/connect"
			const denied = await new Promise<boolean>((resolve) => {
				const socket = new WebSocket(url, {
					headers: { authorization: "Bearer oct_wrong" },
				} as never)
				socket.onopen = () => resolve(false)
				socket.onerror = () => resolve(true)
			})
			assert.ok(denied)
			const socket = new WebSocket(url, {
				headers: { authorization: "Bearer " + approved.token },
			} as never)
			const seen: Array<unknown> = []
			socket.onmessage = (event) => {
				const message = JSON.parse(String(event.data)) as {
					_tag: string
					call?: { id: string; operation: { _tag: string } }
				}
				seen.push(message)
				if (message._tag === "Call" && message.call !== undefined)
					socket.send(
						JSON.stringify({
							_tag: "Reply",
							reply: {
								id: message.call.id,
								result: {
									_tag: "Done",
									value: {
										exitCode: 0,
										stdout: "from the laptop",
										stderr: "",
										truncated: false,
										durationMs: 2,
									},
								},
							},
						}),
					)
			}
			await new Promise<void>((resolve) => {
				socket.onopen = () => resolve()
			})
			socket.send(
				JSON.stringify({
					_tag: "Hello",
					hello: { version: "1.0.0", os: "linux", arch: "x64", desktop: false },
				}),
			)
			const path = "/v1/computers/" + computer.id
			await until("the machine is connected", async () => {
				const current = await json(
					ComputersApi.Computer,
					send(alice.session, path),
				)
				return current.state === "running" ? current : undefined
			})
			const ran = await json(
				ComputersApi.CommandResult,
				send(alice.session, path + "/commands", "POST", { command: "uname" }),
			)
			assert.equal(ran.stdout, "from the laptop")
			socket.close()
			await until("the machine is offline", async () => {
				const current = await json(
					ComputersApi.Computer,
					send(alice.session, path),
				)
				return current.state === "offline" ? current : undefined
			})

			// The same machine pairs again and keeps its Computer.
			const again = await start()
			const same = await json(
				ComputersApi.Computer,
				send(
					alice.session,
					"/v1/computer-pairings/" + again.code + "/approve",
					"POST",
					{},
				),
			)
			assert.equal(same.id, computer.id)

			// A denied pairing ends at once.
			const third = await start()
			assert.equal(
				(
					await send(
						alice.session,
						"/v1/computer-pairings/" + third.code + "/deny",
						"POST",
					)
				).status,
				204,
			)
			assert.equal((await poll(third)).status, 404)
		} finally {
			await host.close()
		}
	},
)

test(
	"a Bot asks for a Computer, and uses it after its person allows it",
	{ timeout: 120000 },
	async () => {
		const fake = fakeProvider()
		const host = await BrowserHost.start({
			publicOrigin,
			model,
			computerDrivers: fake.layer,
		})
		try {
			const { send, json, until } = client(host)
			const alice = await host.login("tools-alice")
			const provider = await json(
				ComputersApi.ComputerProvider,
				send(alice.session, "/v1/computer-providers", "POST", {
					name: "Sandboxes",
					credentials: { kind: "e2b", apiKey: "e2b_test_key_123456" },
				}),
			)
			const computer = await json(
				ComputersApi.Computer,
				send(alice.session, "/v1/computers", "POST", {
					name: "Box",
					source: { _tag: "Provider", provider: provider.id, template: null },
				}),
			)
			await host.defaultBot(alice.session)
			const created = await json(
				SessionView,
				send(alice.session, "/v1/sessions", "POST", {}),
			)
			const path = "/v1/sessions/" + created.session.id
			const view = () => json(SessionView, send(alice.session, path))
			// Work after a Turn, such as Session memory, can move the revision, so try again.
			const start = (input: string) =>
				until("the Turn starts", async () => {
					const current = await view()
					const started = await send(alice.session, path + "/turns", "POST", {
						expected: current.session.revision,
						input,
					})
					if (started.status === 409) return undefined
					assert.equal(started.status, 202, await started.clone().text())
					return current.session.turns.length
				})
			const status = (tag: string, turns: number) =>
				until("the Turn is " + tag, async () => {
					const next = await view()
					return next.session.turns.length > turns &&
						Session.status(next.session)._tag === tag
						? next
						: undefined
				})
			const lastText = (next: SessionView) =>
				JSON.stringify(next.session.turns.at(-1))

			// Without the right, the command does not run.
			const denied = await status(
				"Completed",
				await start("run " + computer.id),
			)
			assert.match(lastText(denied), /may not use the Computer/)
			assert.ok(!fake.log.some((line) => line.startsWith("run ")))

			// The Bot asks. The request goes to Alice, and she allows it.
			const asked = await start("get " + computer.id)
			await status("Waiting", asked)
			const request = await until("a request", async () => {
				const list = await json(
					Schema.Array(RequestsApi.CapabilityRequest),
					send(alice.session, "/v1/requests?status=pending"),
				)
				return list.find(
					(entry) => entry.capability.action === "computers.acquire",
				)
			})
			assert.equal(request.capability.target, computer.id)
			const resolved = await send(
				alice.session,
				"/v1/requests/" + request.id,
				"POST",
				{ expected: request.revision, decision: "allow" },
			)
			assert.equal(resolved.status, 200, await resolved.clone().text())
			await status("Completed", asked)

			const ran = await status("Completed", await start("run " + computer.id))
			assert.match(lastText(ran), /ran: echo hi/)
			assert.ok(fake.log.includes("run sbx-0 echo hi"))
		} finally {
			await host.close()
		}
	},
)

test("the model sees only the newest screenshot", () => {
	const shot = (id: string) =>
		Prompt.makeMessage("tool", {
			content: [
				Prompt.toolResultPart({
					id,
					name: names.screenshot,
					isFailure: false,
					providerExecuted: false,
					result: {
						width: 1,
						height: 1,
						openbot_image: { mediaType: "image/png", data: id },
					},
				}),
			],
		})
	const prompt = Prompt.fromMessages([
		Prompt.makeMessage("user", {
			content: [Prompt.makePart("text", { text: "hi" })],
		}),
		shot("first"),
		shot("second"),
	])
	const shown = keepNewestImage(prompt)
	assert.equal(shown.content.length, prompt.content.length)
	const results = shown.content.flatMap((message) =>
		message.role === "tool" ? message.content : [],
	)
	assert.deepEqual(
		results.map((part) =>
			part.type === "tool-result"
				? "openbot_image" in (part.result as object)
				: false,
		),
		[false, true],
	)
})
