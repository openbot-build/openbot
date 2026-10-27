import { NodeSocket } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import {
	AuthApi,
	ChatView,
	ComputersApi,
	RequestsApi,
} from "@openbot-build/api"
import {
	Array as Arr,
	Effect,
	HashMap,
	Layer,
	Option,
	pipe,
	Redacted,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, Prompt, Response } from "effect/ai"
import { Base64 } from "effect/encoding"
import { HttpClient, HttpClientRequest, type HttpMethod } from "effect/http"
import { Socket } from "effect/socket"
import {
	ComputerCallFailed,
	Machine,
	type Process,
	Provider,
} from "../src/computers/Computer.ts"
import * as ProcessSink from "../src/computers/Process.ts"
import { Drivers } from "../src/computers/Drivers.ts"
import {
	keepNewestImage,
	names,
} from "../src/plugins/computers/ComputerPlugin.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import { settled, talk, type Send } from "./Messages.ts"
import { until } from "./Wait.ts"

const publicOrigin = "https://computers.example.com"
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}

/** Gives a value as JSON text. */
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const encodeMessage = Schema.encodeEffect(
	Schema.fromJsonString(ComputersApi.FromConnector),
)
const decodeMessage = Schema.decodeEffect(
	Schema.fromJsonString(ComputersApi.ToConnector),
)

/** A provider that keeps its sandboxes in memory, and writes down what happened. */
const fakeProvider = Effect.gen(function* () {
	const log = yield* Ref.make<ReadonlyArray<string>>([])
	const files = yield* Ref.make(HashMap.empty<string, string>())
	const next = yield* Ref.make(0)
	/** False while OpenBot cannot reach the provider. */
	const reachable = yield* Ref.make(true)
	const record = (line: string) => Ref.update(log, Arr.append(line))
	const machine = (ref: string) =>
		new Machine({
			shell: {
				start: (request) =>
					Effect.gen(function* () {
						yield* record("run " + ref + " " + request.command)
						const sink = yield* ProcessSink.make
						const process: Process = {
							output: sink.output,
							exit: sink.exit,
							// `cat` gives back its input until Ctrl-D, like the real one.
							write: (data) =>
								data.includes(4)
									? sink
											.push(data.filter((byte) => byte !== 4))
											.pipe(Effect.andThen(sink.end({ code: 0, signal: null })))
									: sink.push(data),
							resize: () => Effect.void,
							signal: (signal) => sink.end({ code: null, signal }),
						}
						if (request.command !== "cat") {
							yield* sink.push(
								new TextEncoder().encode(
									(request.tty ? "tty " : "") + "ran: " + request.command,
								),
							)
							yield* sink.end({ code: 0, signal: null })
						}
						return process
					}),
				read: (path, encoding) =>
					Effect.map(Ref.get(files), (current) => ({
						path,
						encoding,
						content: Option.getOrElse(HashMap.get(current, path), () => ""),
					})),
				write: (file) =>
					Ref.update(files, HashMap.set(file.path, file.content)),
				list: () =>
					Effect.map(Ref.get(files), (current) =>
						Arr.map(Arr.fromIterable(HashMap.keys(current)), (name) => ({
							name,
							kind: "file" as const,
							size: 1,
							modifiedAt: 0,
						})),
					),
				remove: (path) => Ref.update(files, HashMap.remove(path)),
			},
			pausable: {
				pause: record("pause " + ref),
				resume: record("resume " + ref),
			},
			desktop: {
				screenshot: Effect.succeed({
					mediaType: "image/png" as const,
					data: "aW1hZ2U=",
					width: 800,
					height: 600,
				}),
				act: (actions) => record("act " + actions.length),
				stream: Effect.succeed({
					url: "https://view.example.com/" + ref,
					expiresAt: null,
				}),
			},
			ports: {
				open: (port) => Effect.succeed(`https://${port}-${ref}.example.com`),
			},
			state: Effect.succeed("running"),
			destroy: record("destroy " + ref),
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
							Effect.gen(function* () {
								const ref =
									"sbx-" + (yield* Ref.getAndUpdate(next, (n) => n + 1))
								yield* record("create " + ref)
								return { ref }
							}),
						attach: (ref) =>
							Effect.flatMap(Ref.get(reachable), (up) =>
								up
									? Effect.succeed(machine(ref))
									: Effect.fail(
											ComputerCallFailed.make({
												message: "The Computer provider could not be reached",
												retry: true,
											}),
										),
							),
					}),
				),
		}),
	)
	return {
		log: Ref.get(log),
		layer,
		reachable: (up: boolean) => Ref.set(reachable, up),
	}
})

const isUser = (message: Prompt.Message): message is Prompt.UserMessage =>
	message.role === "user"

/** The text parts of a message of the person, as one text. */
const textOf = (message: Prompt.UserMessage) =>
	pipe(
		message.content,
		Arr.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		Arr.join(""),
	)

const answer = (text: string): Stream.Stream<Response.StreamPartEncoded> =>
	Stream.make(
		Response.makePart("text-start", { id: "answer" }),
		Response.makePart("text-delta", { id: "answer", delta: text }),
		Response.makePart("text-end", { id: "answer" }),
		Response.makePart("finish", { reason: "stop", usage }),
	)

/**
 * A scripted model. `run <id>` runs a command, `get <id>` asks for the Computer,
 * and `make <provider>` makes a Computer.
 * After a tool result, it answers with that result.
 */
const scriptedModel = Effect.gen(function* () {
	const calls = yield* Ref.make(0)
	const call = (
		name: string,
		params: Record<string, unknown>,
	): Stream.Stream<Response.StreamPartEncoded> =>
		Stream.unwrap(
			Effect.map(
				Ref.getAndUpdate(calls, (n) => n + 1),
				(count) =>
					Stream.make(
						Response.makePart("tool-call", {
							id: "call-" + count,
							name,
							params,
							providerExecuted: false,
						}),
						Response.makePart("finish", { reason: "tool-calls", usage }),
					),
			),
		)
	return yield* LanguageModel.make({
		generateText: () =>
			Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
		streamText: ({ prompt }) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const found = Arr.findLastIndex(prompt.content, isUser)
					const input = pipe(
						found,
						Option.flatMap((index) => Arr.get(prompt.content, index)),
						Option.filter(isUser),
						Option.map(textOf),
						Option.getOrElse(() => ""),
					)
					const after = Arr.drop(
						prompt.content,
						Option.getOrElse(found, () => -1) + 1,
					)
					const result = Arr.findLast(
						after,
						(message) => message.role === "tool",
					)
					const [verb, id] = Str.split(input, " ")
					// A tool result comes from JSON, so it always becomes JSON text again.
					if (Option.isSome(result))
						return answer(
							"Result: " +
								(yield* Effect.orDie(jsonText(result.value.content))),
						)
					if (verb === "run")
						return call(names.exec, { computer: id, command: "echo hi" })
					if (verb === "get")
						return call(names.acquire, { computer: id, reason: "I need it." })
					if (verb === "make")
						return call(names.create, {
							name: "Bot box",
							source: { _tag: "Provider", provider: id, template: null },
							pauseAfter: 600,
							reason: "I need a box.",
						})
					return answer("Hello.")
				}),
			),
	})
})

const client = (host: BrowserHost.Host) => {
	const send = (
		credential: Redacted.Redacted<string> | undefined,
		path: string,
		method: HttpMethod.HttpMethod = "GET",
		payload?: unknown,
		headers: Record<string, string> = {},
	): Caller.Call =>
		Effect.gen(function* () {
			const request = HttpClientRequest.make(method)(
				(yield* host.address) + path,
				{
					headers: {
						...(credential === undefined
							? {}
							: {
									cookie:
										AuthApi.SessionCookie +
										"=" +
										encodeURIComponent(Redacted.value(credential)),
								}),
						origin: publicOrigin,
						...headers,
					},
				},
			)
			return yield* HttpClient.execute(
				payload === undefined
					? request
					: yield* HttpClientRequest.bodyJson(request, payload),
			)
		})
	/** Reads the JSON body of an answer with a schema. The status must be 2xx. */
	const json = <S extends Schema.Constraint>(schema: S, call: Caller.Call) =>
		Effect.flatMap(call, Caller.json(schema))
	return { send, json }
}

it.layer(
	Layer.merge(
		BrowserHost.layerPlatform,
		NodeSocket.layerWebSocketConstructorWS,
	),
	{ excludeTestServices: true },
)((it) => {
	it.effect(
		"people add Computer providers, make Computers, and give Bots the right to use them",
		() =>
			Effect.gen(function* () {
				const fake = yield* fakeProvider
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scriptedModel,
					computerDrivers: fake.layer,
				})
				const { send, json } = client(host)
				const alice = yield* host.login("computers-alice")
				const bob = yield* host.login("computers-bob")

				const provider = yield* json(
					ComputersApi.ComputerProvider,
					send(alice.session, "/v1/computer-providers", "POST", {
						name: "Sandboxes",
						credentials: { kind: "e2b", apiKey: "e2b_test_key_123456" },
					}),
				)
				assert.deepStrictEqual(provider.credentials, {
					kind: "e2b",
					apiKey: { set: true, hint: "…3456" },
					apiUrl: null,
					sandboxDomain: null,
				})
				assert.strictEqual(
					(yield* send(bob.session, "/v1/computer-providers/" + provider.id))
						.status,
					404,
				)
				const shared = yield* send(
					bob.session,
					"/v1/computer-providers",
					"POST",
					{
						name: "Team",
						credentials: { kind: "e2b", apiKey: "e2b_test_key_654321" },
						shared: true,
					},
				)
				assert.strictEqual(shared.status, 403, yield* shared.text)

				const computer = yield* json(
					ComputersApi.Computer,
					send(alice.session, "/v1/computers", "POST", {
						name: "Box",
						source: { _tag: "Provider", provider: provider.id, template: null },
						desktop: true,
					}),
				)
				assert.strictEqual(computer.state, "running")
				assert.deepStrictEqual(computer.features, {
					pause: true,
					desktop: true,
					ports: true,
				})
				const path = "/v1/computers/" + computer.id
				assert.strictEqual((yield* send(bob.session, path)).status, 404)

				const ran = yield* json(
					ComputersApi.SessionOutput,
					send(alice.session, path + "/sessions", "POST", { command: "ls" }),
				)
				assert.deepStrictEqual(ran, {
					session: null,
					running: false,
					exitCode: 0,
					signal: null,
					output: "ran: ls",
					truncated: false,
				})
				const terminal = yield* json(
					ComputersApi.SessionOutput,
					send(alice.session, path + "/sessions", "POST", {
						command: "ls",
						tty: true,
					}),
				)
				assert.strictEqual(terminal.output, "tty ran: ls")

				// A command that waits for input keeps a session until its input ends.
				const opened = yield* json(
					ComputersApi.SessionOutput,
					send(alice.session, path + "/sessions", "POST", {
						command: "cat",
						yieldTimeMs: 250,
					}),
				)
				assert.strictEqual(opened.running, true)
				assert.ok(opened.session !== null)
				const sessionPath = path + "/sessions/" + opened.session
				const echoed = yield* json(
					ComputersApi.SessionOutput,
					send(alice.session, sessionPath + "/input", "POST", {
						chars: "hello\\n",
						yieldTimeMs: 250,
					}),
				)
				assert.strictEqual(echoed.output, "hello\n")
				assert.strictEqual(echoed.running, true)
				// Another member cannot use the session.
				assert.strictEqual(
					(yield* send(bob.session, sessionPath + "/input", "POST", {
						chars: "",
					})).status,
					404,
				)
				const closed = yield* json(
					ComputersApi.SessionOutput,
					send(alice.session, sessionPath + "/input", "POST", {
						chars: "bye\\x04",
					}),
				)
				assert.deepStrictEqual(
					{
						output: closed.output,
						running: closed.running,
						exitCode: closed.exitCode,
					},
					{ output: "bye", running: false, exitCode: 0 },
				)
				assert.strictEqual(
					(yield* send(alice.session, sessionPath + "/input", "POST", {
						chars: "",
					})).status,
					404,
				)
				const written = yield* send(alice.session, path + "/files", "PUT", {
					path: "/tmp/a.txt",
					encoding: "utf8",
					content: "hello",
				})
				assert.strictEqual(written.status, 204, yield* written.text)
				// Bad base64 is a bad input of the caller, not a failure of the provider.
				const badWrite = yield* send(alice.session, path + "/files", "PUT", {
					path: "/tmp/b.bin",
					encoding: "base64",
					content: "not base64!",
				})
				assert.strictEqual(badWrite.status, 400, yield* badWrite.text)
				const read = yield* json(
					ComputersApi.FileContent,
					send(alice.session, path + "/files?path=%2Ftmp%2Fa.txt"),
				)
				assert.strictEqual(read.content, "hello")
				const port = yield* json(
					ComputersApi.OpenPort,
					send(alice.session, path + "/ports/3000", "PUT"),
				)
				assert.strictEqual(port.url, "https://3000-sbx-0.example.com")
				const shot = yield* json(
					ComputersApi.Screenshot,
					send(alice.session, path + "/desktop/actions", "POST", {
						actions: [{ _tag: "Click", x: 1, y: 2 }],
					}),
				)
				assert.strictEqual(shot.width, 800)

				// A paused Computer resumes by itself for the next command.
				const paused = yield* json(
					ComputersApi.Computer,
					send(alice.session, path + "/pause", "POST"),
				)
				assert.strictEqual(paused.state, "paused")
				yield* json(
					ComputersApi.SessionOutput,
					send(alice.session, path + "/sessions", "POST", { command: "pwd" }),
				)
				assert.strictEqual(
					(yield* json(ComputersApi.Computer, send(alice.session, path))).state,
					"running",
				)
				assert.deepStrictEqual(
					Arr.filter(yield* fake.log, (line) =>
						/^(create|pause|resume)/.test(line),
					),
					["create sbx-0", "pause sbx-0", "resume sbx-0"],
				)
				const usageList = yield* json(
					Schema.Array(ComputersApi.ComputerUsage),
					send(alice.session, path + "/usage"),
				)
				assert.strictEqual(usageList.length, 2)
				assert.strictEqual(usageList[0]!.endedAt, null)

				// Alice gives her Bot the right to use the Computer, and takes it back.
				const bot = yield* host.defaultBot(alice.session)
				const granted = yield* json(
					ComputersApi.ComputerAccess,
					send(alice.session, path + "/bots/" + bot, "PUT"),
				)
				assert.strictEqual(granted.bot, bot)
				assert.deepStrictEqual(
					Arr.map(
						yield* json(
							Schema.Array(ComputersApi.Computer),
							send(alice.session, "/v1/computers?bot=" + bot),
						),
						(entry) => entry.id,
					),
					[computer.id],
				)
				assert.strictEqual(
					(yield* send(bob.session, path + "/bots/" + bot, "PUT")).status,
					404,
				)
				assert.strictEqual(
					(yield* send(alice.session, path + "/bots/" + bot, "DELETE")).status,
					204,
				)
				assert.deepStrictEqual(
					yield* json(
						Schema.Array(ComputersApi.ComputerAccess),
						send(alice.session, path + "/bots"),
					),
					[],
				)

				// The provider stays while a Computer uses it.
				assert.strictEqual(
					(yield* send(
						alice.session,
						"/v1/computer-providers/" + provider.id,
						"DELETE",
					)).status,
					409,
				)
				assert.strictEqual(
					(yield* send(alice.session, path, "DELETE")).status,
					204,
				)
				assert.ok(Arr.contains(yield* fake.log, "destroy sbx-0"))
				assert.strictEqual((yield* send(alice.session, path)).status, 404)
			}),
		{ timeout: 120000 },
	)

	it.effect(
		"a Computer stays when OpenBot cannot reach its provider to delete the sandbox",
		() =>
			Effect.gen(function* () {
				const fake = yield* fakeProvider
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scriptedModel,
					computerDrivers: fake.layer,
				})
				const { send, json } = client(host)
				const alice = yield* host.login("unreachable-alice")
				const provider = yield* json(
					ComputersApi.ComputerProvider,
					send(alice.session, "/v1/computer-providers", "POST", {
						name: "Sandboxes",
						credentials: { kind: "e2b", apiKey: "e2b_test_key_123456" },
					}),
				)
				const computer = yield* json(
					ComputersApi.Computer,
					send(alice.session, "/v1/computers", "POST", {
						name: "Box",
						source: { _tag: "Provider", provider: provider.id, template: null },
					}),
				)
				const path = "/v1/computers/" + computer.id

				yield* fake.reachable(false)
				const failed = yield* send(alice.session, path, "DELETE")
				assert.strictEqual(failed.status, 502, yield* failed.text)
				assert.strictEqual(
					(yield* json(ComputersApi.Computer, send(alice.session, path))).id,
					computer.id,
				)
				assert.ok(!Arr.contains(yield* fake.log, "destroy sbx-0"))

				// When the provider is back, the delete works and the sandbox goes.
				yield* fake.reachable(true)
				assert.strictEqual(
					(yield* send(alice.session, path, "DELETE")).status,
					204,
				)
				assert.ok(Arr.contains(yield* fake.log, "destroy sbx-0"))
				assert.strictEqual((yield* send(alice.session, path)).status, 404)
			}),
		{ timeout: 120000 },
	)

	it.effect(
		"a machine pairs with a code, connects, and runs a command",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scriptedModel,
				})
				const { send, json } = client(host)
				const alice = yield* host.login("pair-alice")
				const machine = {
					version: ComputersApi.connectorProtocolVersion,
					os: "linux",
					arch: "x64",
					desktop: false,
					hostname: "alice-laptop",
					machineId: "machine-0123456789abcdef",
				}
				const pair = json(
					ComputersApi.Pairing,
					send(undefined, "/v1/hooks/computers/pairings", "POST", machine),
				)
				const poll = (pairing: ComputersApi.Pairing, secret = pairing.secret) =>
					send(
						undefined,
						"/v1/hooks/computers/pairings/" + pairing.id + "/poll",
						"POST",
						undefined,
						{ authorization: "Bearer " + Redacted.value(secret) },
					)

				const pairing = yield* pair
				assert.match(pairing.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
				assert.deepStrictEqual(
					yield* json(ComputersApi.PairingStatus, poll(pairing)),
					{
						_tag: "Pending",
					},
				)
				assert.strictEqual(
					(yield* poll(pairing, Redacted.make("ocp_wrong"))).status,
					404,
				)
				// People may type the code in small letters and without the dash.
				const typed = pipe(pairing.code, Str.replace("-", ""), Str.toLowerCase)
				const shown = yield* json(
					ComputersApi.ComputerPairing,
					send(alice.session, "/v1/computer-pairings/" + typed),
				)
				assert.strictEqual(shown.hostname, "alice-laptop")
				const computer = yield* json(
					ComputersApi.Computer,
					send(
						alice.session,
						"/v1/computer-pairings/" + typed + "/approve",
						"POST",
						{},
					),
				)
				assert.strictEqual(computer.name, "alice-laptop")
				assert.strictEqual(computer.state, "offline")
				const approved = yield* json(ComputersApi.PairingStatus, poll(pairing))
				assert.strictEqual(approved._tag, "Approved")
				if (approved._tag !== "Approved") return
				assert.strictEqual(approved.computer, computer.id)
				// The token goes out only once.
				assert.strictEqual((yield* poll(pairing)).status, 404)

				// The machine connects and answers a command.
				const url =
					Str.replace(/^http/, "ws")(yield* host.address) +
					"/v1/hooks/computers/connect"
				const connect = (token: string) =>
					Socket.makeWebSocket(url, {
						headers: { authorization: "Bearer " + token },
					})
				const denied = yield* connect("oct_wrong").pipe(
					Effect.flatMap((socket) => socket.reader),
					Effect.scoped,
					Effect.as(false),
					Effect.catchReason("SocketError", "SocketOpenError", () =>
						Effect.succeed(true),
					),
				)
				assert.ok(denied)
				// An old connector cannot connect. It must update first.
				const refused = yield* Effect.gen(function* () {
					const old = yield* connect(Redacted.value(approved.token))
					const reader = yield* old.reader
					const writer = yield* old.writer
					yield* writer.write(
						yield* encodeMessage({
							_tag: "Hello",
							hello: { version: 1, os: "linux", arch: "x64", desktop: false },
						}),
					)
					return yield* Effect.forever(reader.pull)
				}).pipe(
					Effect.scoped,
					Effect.catchReason("SocketError", "SocketCloseError", (reason) =>
						Effect.succeed(reason.code),
					),
				)
				assert.strictEqual(refused, 4426)
				const path = "/v1/computers/" + computer.id
				yield* Effect.gen(function* () {
					const socket = yield* connect(Redacted.value(approved.token))
					const frames = yield* Socket.readerString(socket)
					const writer = yield* socket.writer
					const reply = (message: ComputersApi.FromConnector) =>
						Effect.flatMap(encodeMessage(message), writer.write)
					/** The laptop answers each command with its output, and then ends it. */
					const answerStart = Effect.fn("Computers.answerStart")(function* (
						frame: string,
					) {
						const message = yield* decodeMessage(frame)
						if (message._tag !== "Start") return
						yield* reply({
							_tag: "Output",
							session: message.session,
							seq: 0,
							data: Base64.encode("from the laptop"),
						})
						yield* reply({
							_tag: "Exit",
							session: message.session,
							code: 0,
							signal: null,
						})
					})
					const laptop = Effect.forever(
						Effect.flatMap(frames, (batch) =>
							Effect.forEach(batch, answerStart, { discard: true }),
						),
					)
					// The laptop never ends with success. It wins the race only when it
					// fails, and then the test fails at once with its cause.
					yield* Effect.raceFirst(
						Effect.gen(function* () {
							yield* reply({
								_tag: "Hello",
								hello: {
									version: ComputersApi.connectorProtocolVersion,
									os: "linux",
									arch: "x64",
									desktop: false,
								},
							})
							yield* until(
								"the machine is connected",
								Effect.map(
									json(ComputersApi.Computer, send(alice.session, path)),
									(current) =>
										Option.liftPredicate(
											current,
											(computer) => computer.state === "running",
										),
								),
							)
							const ran = yield* json(
								ComputersApi.SessionOutput,
								send(alice.session, path + "/sessions", "POST", {
									command: "uname",
								}),
							)
							assert.strictEqual(ran.output, "from the laptop")
							assert.strictEqual(ran.exitCode, 0)
						}),
						laptop,
					)
				}).pipe(Effect.scoped)
				// The socket closed with its scope.
				yield* until(
					"the machine is offline",
					Effect.map(
						json(ComputersApi.Computer, send(alice.session, path)),
						(current) =>
							Option.liftPredicate(
								current,
								(computer) => computer.state === "offline",
							),
					),
				)

				// The same machine pairs again and keeps its Computer. Of two approvals
				// at the same time, only one works.
				const again = yield* pair
				const approveAgain = send(
					alice.session,
					"/v1/computer-pairings/" + again.code + "/approve",
					"POST",
					{},
				)
				const answers = yield* Effect.all([approveAgain, approveAgain], {
					concurrency: 2,
				})
				const accepted = Arr.filter(answers, (answer) => answer.status === 201)
				assert.strictEqual(accepted.length, 1)
				assert.ok(Arr.some(answers, (answer) => answer.status === 404))
				const same = yield* Caller.json(ComputersApi.Computer)(
					Arr.getUnsafe(accepted, 0),
				)
				assert.strictEqual(same.id, computer.id)
				// A deny after the approval does nothing, and the machine still gets its token.
				assert.strictEqual(
					(yield* send(
						alice.session,
						"/v1/computer-pairings/" + again.code + "/deny",
						"POST",
					)).status,
					404,
				)
				const repaired = yield* json(ComputersApi.PairingStatus, poll(again))
				assert.strictEqual(repaired._tag, "Approved")

				// A denied pairing ends at once.
				const third = yield* pair
				assert.strictEqual(
					(yield* send(
						alice.session,
						"/v1/computer-pairings/" + third.code + "/deny",
						"POST",
					)).status,
					204,
				)
				assert.strictEqual((yield* poll(third)).status, 404)
			}),
		{ timeout: 120000 },
	)

	it.effect(
		"a Bot asks for a Computer, and uses it after its person allows it",
		() =>
			Effect.gen(function* () {
				const fake = yield* fakeProvider
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scriptedModel,
					computerDrivers: fake.layer,
				})
				const { send, json } = client(host)
				const alice = yield* host.login("tools-alice")
				const provider = yield* json(
					ComputersApi.ComputerProvider,
					send(alice.session, "/v1/computer-providers", "POST", {
						name: "Sandboxes",
						credentials: { kind: "e2b", apiKey: "e2b_test_key_123456" },
					}),
				)
				const computer = yield* json(
					ComputersApi.Computer,
					send(alice.session, "/v1/computers", "POST", {
						name: "Box",
						source: { _tag: "Provider", provider: provider.id, template: null },
					}),
				)
				const bot = yield* host.defaultBot(alice.session)
				const asAlice: Send = (path, method, payload) =>
					send(alice.session, path, method, payload)
				const lastText = (next: ChatView) => jsonText(next.response)
				const pendingRequests = json(
					Schema.Array(RequestsApi.CapabilityRequest),
					send(alice.session, "/v1/requests?status=pending"),
				)

				// Without the right, the command does not run.
				const denied = yield* talk(asAlice, bot, "run " + computer.id)
				assert.strictEqual(denied.view.status, "Completed")
				assert.match(yield* lastText(denied.view), /may not use the Computer/)
				assert.ok(!Arr.some(yield* fake.log, Str.startsWith("run ")))

				// The Bot asks. The request goes to Alice. The Turn does not wait for her.
				const asked = yield* talk(asAlice, bot, "get " + computer.id)
				assert.strictEqual(asked.view.status, "Completed")
				assert.strictEqual(asked.view.open.requests, 1)
				const request = yield* until(
					"a request",
					Effect.map(pendingRequests, (list) =>
						Arr.findFirst(
							list,
							(entry) => entry.capability.action === "computers.acquire",
						),
					),
				)
				assert.strictEqual(request.capability.target, computer.id)
				assert.strictEqual(request.chat, asked.receipt.chat)
				const resolved = yield* send(
					alice.session,
					"/v1/requests/" + request.id,
					"POST",
					{ expected: request.revision, decision: "allow" },
				)
				assert.strictEqual(resolved.status, 200, yield* resolved.text)
				// She allows it, and the call runs in a new Turn of the same Chat.
				const allowed = yield* until(
					"the allowed call runs",
					Effect.map(settled(asAlice, asked.receipt.chat), (current) =>
						Option.liftPredicate(
							current,
							(view) =>
								view.turn !== null && view.turn.id !== asked.view.turn?.id,
						),
					),
				)
				assert.strictEqual(allowed.status, "Completed")
				assert.strictEqual(allowed.open.requests, 0)

				const ran = yield* talk(asAlice, bot, "run " + computer.id)
				assert.strictEqual(ran.view.status, "Completed")
				assert.match(yield* lastText(ran.view), /ran: echo hi/)
				assert.ok(Arr.contains(yield* fake.log, "run sbx-0 echo hi"))

				// The Bot makes a Computer with the same fields as the route.
				yield* talk(asAlice, bot, "make " + provider.id)
				const making = yield* until(
					"a request to make a Computer",
					Effect.map(pendingRequests, (list) =>
						Arr.findFirst(
							list,
							(entry) => entry.capability.action === "computers.create",
						),
					),
				)
				assert.strictEqual(making.capability.target, provider.id)
				const made = yield* send(
					alice.session,
					"/v1/requests/" + making.id,
					"POST",
					{ expected: making.revision, decision: "allow" },
				)
				assert.strictEqual(made.status, 200, yield* made.text)
				const box = yield* until(
					"the new Computer",
					Effect.map(
						json(
							Schema.Array(ComputersApi.Computer),
							send(alice.session, "/v1/computers"),
						),
						(list) => Arr.findFirst(list, (entry) => entry.name === "Bot box"),
					),
				)
				assert.strictEqual(box.pauseAfter, 600)
			}),
		{ timeout: 120000 },
	)

	it.effect(
		"a Bot does not get the right to use a Computer that its person may not see",
		() =>
			Effect.gen(function* () {
				const fake = yield* fakeProvider
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scriptedModel,
					computerDrivers: fake.layer,
				})
				const { send, json } = client(host)
				// Alice signs in first, so she runs the organization and sees every Computer.
				const alice = yield* host.login("private-alice")
				const bob = yield* host.login("private-bob")
				const provider = yield* json(
					ComputersApi.ComputerProvider,
					send(alice.session, "/v1/computer-providers", "POST", {
						name: "Sandboxes",
						credentials: { kind: "e2b", apiKey: "e2b_test_key_123456" },
					}),
				)
				const computer = yield* json(
					ComputersApi.Computer,
					send(alice.session, "/v1/computers", "POST", {
						name: "Private box",
						source: { _tag: "Provider", provider: provider.id, template: null },
					}),
				)
				const bot = yield* host.defaultBot(bob.session)
				const asBob: Send = (path, method, payload) =>
					send(bob.session, path, method, payload)

				// Bob may not see the Computer, so the check fails and the call ends with a Deny.
				const asked = yield* talk(asBob, bot, "get " + computer.id)
				assert.strictEqual(asked.view.status, "Completed")
				assert.strictEqual(asked.view.open.requests, 0)
				assert.match(yield* jsonText(asked.view.response), /ComputerNotFound/)
				assert.deepStrictEqual(
					yield* json(
						Schema.Array(ComputersApi.ComputerAccess),
						send(alice.session, "/v1/computers/" + computer.id + "/bots"),
					),
					[],
				)
				const visible = yield* json(
					Schema.Array(ComputersApi.Computer),
					send(bob.session, "/v1/computers?bot=" + bot),
				)
				assert.deepStrictEqual(visible, [])
			}),
		{ timeout: 120000 },
	)
})

it.effect("the model sees only the newest screenshot", () =>
	Effect.sync(() => {
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
		assert.strictEqual(shown.content.length, prompt.content.length)
		const results = Arr.flatMap(shown.content, (message) =>
			message.role === "tool" ? message.content : [],
		)
		assert.deepStrictEqual(
			Arr.map(results, (part) =>
				part.type === "tool-result"
					? "openbot_image" in (part.result as object)
					: false,
			),
			[false, true],
		)
	}),
)
