import { assert, it } from "@effect/vitest"
import { AuthApi, LiveApi } from "@openbot-build/api"
import { Live } from "@openbot-build/core"
import { Effect, Redacted, Schema, Stream, Queue } from "effect"
import { request } from "node:http"
import * as LiveBackends from "../src/models/LiveBackends.ts"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie } from "./Caller.ts"
import { message, settled, type Send } from "./Messages.ts"

const publicOrigin = "https://live.example.com"
const pcm: Live.AudioFormat = { encoding: "pcm16", sampleRate: 24000 }
const capabilities: Live.Capabilities = {
	audio: { input: [pcm], output: [pcm] },
	turnDetection: ["server", "client"],
	inputTranscription: true,
	tools: true,
	interruption: true,
	truncate: false,
	inputs: { text: true, image: false },
	voices: ["calm"],
}
const answerSound = new Uint8Array([1, 2, 3, 4])

/**
 * A backend that hears one fixed question in any sound, and gives one fixed answer for
 * each answer request. It keeps every input that OpenBot sent.
 */
const fakeBackend = () => {
	const inputs: Array<Live.Input> = []
	let answers = 0
	const backend: LiveBackends.LiveBackend = {
		kind: "openai",
		make: ({ providerId, modelId }) =>
			Effect.succeed({
				provider: providerId,
				model: modelId,
				capabilities,
				connect: () =>
					Effect.gen(function* () {
						const events = yield* Queue.unbounded<Live.Event, Live.LiveError>()
						const send = (input: Live.Input) =>
							Effect.gen(function* () {
								const error = Live.unsupported(capabilities, input)
								if (error !== undefined) return yield* error
								inputs.push(input)
								if (input._tag === "Audio")
									yield* Queue.offerAll(events, [
										Live.Event.SpeechStarted(),
										Live.Event.SpeechStopped(),
										Live.Event.Committed({ itemId: "heard" }),
										Live.Event.InputTranscript({
											itemId: "heard",
											text: "What time is it?",
											final: true,
										}),
									])
								if (input._tag === "Respond") {
									answers++
									const itemId = "answer_" + answers
									yield* Queue.offerAll(events, [
										Live.Event.OutputAudio({ itemId, bytes: answerSound }),
										Live.Event.OutputTranscript({ itemId, delta: "It is " }),
										Live.Event.OutputTranscript({ itemId, delta: "noon." }),
										Live.Event.OutputDone({ itemId }),
										Live.Event.ResponseDone({
											status: "completed",
											usage: {
												input: { text: 5, audio: 7, image: 0, cached: 0 },
												output: { text: 3, audio: 9 },
											},
										}),
									])
								}
							})
						return { send, events: Stream.fromQueue(events) }
					}),
			}),
	}
	return { backend, inputs }
}

/** A Live client that keeps every message and every sound frame. */
const connect = (url: string, headers: Record<string, string>) => {
	const socket = new WebSocket(url, { headers } as never)
	socket.binaryType = "arraybuffer"
	const messages: Array<LiveApi.LiveServerMessage> = []
	const sounds: Array<Uint8Array> = []
	const waiters: Array<() => void> = []
	socket.onmessage = (event) => {
		if (typeof event.data === "string")
			messages.push(
				Schema.decodeSync(Schema.fromJsonString(LiveApi.LiveServerMessage))(
					event.data,
				),
			)
		else sounds.push(new Uint8Array(event.data as ArrayBuffer))
		for (const wake of waiters.splice(0)) wake()
	}
	const until = async (
		test: (messages: ReadonlyArray<LiveApi.LiveServerMessage>) => boolean,
	) => {
		const end = Date.now() + 20000
		while (!test(messages)) {
			if (Date.now() > end)
				throw new Error("No such message: " + JSON.stringify(messages))
			await new Promise<void>((resolve) => {
				waiters.push(resolve)
				setTimeout(resolve, 200)
			})
		}
	}
	const opened = new Promise<void>((resolve, reject) => {
		socket.onopen = () => resolve()
		socket.onerror = () => reject(new Error("The WebSocket did not open"))
	})
	return { socket, messages, sounds, until, opened }
}

/** The status of a WebSocket handshake that the server refuses. */
const handshake = (url: string, headers: Record<string, string>) =>
	new Promise<number>((resolve, reject) => {
		const call = request(url, {
			headers: {
				connection: "Upgrade",
				upgrade: "websocket",
				"sec-websocket-version": "13",
				"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
				...headers,
			},
		})
		call.on("response", (response) => resolve(response.statusCode ?? 0))
		call.on("upgrade", (response, socket) => {
			socket.destroy()
			resolve(response.statusCode ?? 0)
		})
		call.on("error", reject)
		call.end()
	})

it(
	"a person talks with a Bot in a live Chat, and only the Live session starts its Turns",
	{ timeout: 180000 },
	async () => {
		const fake = fakeBackend()
		const host = await BrowserHost.start({
			publicOrigin,
			liveBackends: LiveBackends.layer([fake.backend]),
			bots: { memory: false },
		})
		try {
			const send = withCookie({ address: host.address, publicOrigin })
			const json = async (response: Promise<Response>, status = 200) => {
				const value = await response
				const body = await value.text()
				assert.strictEqual(value.status, status, body)
				return body.length === 0 ? undefined : JSON.parse(body)
			}
			const alice = await host.login("alice")
			const asAlice: Send = (path, method, payload) =>
				send(alice.session, path, method, payload)
			const botId = await host.defaultBot(alice.session)
			const direct = await message(asAlice, botId, "Hello")
			await settled(asAlice, direct.chat)
			const cookie =
				AuthApi.SessionCookie +
				"=" +
				encodeURIComponent(Redacted.value(alice.session))
			const urlOf = (chat: string) =>
				host.address.replace(/^http/, "ws") + `/v1/chats/${chat}/live`

			// Without a Live model, OpenBot makes no live Chat.
			const none = await json(
				send(alice.session, `/v1/bots/${botId}/live`, "POST", {}),
				409,
			)
			assert.strictEqual(none._tag, "LiveUnavailable")

			// Alice adds a Live model with the key of her organization.
			await json(
				send(alice.session, "/v1/organization/models", "POST", {
					id: "talk",
					name: "Talk",
					type: "live",
					reasoningEfforts: [],
					serviceTiers: [],
				}),
			)
			const provider = await json(
				send(alice.session, "/v1/organization/model_providers", "POST", {
					kind: "openai",
					name: "Realtime",
					apiKey: "sk-live-0123456789",
					models: [{ model: "talk", modelOwner: "organization" }],
				}),
			)
			const talk = {
				_tag: "Config.Selection",
				provider: provider.id,
				model: "talk",
			}

			// Only a live Chat has a Live session.
			assert.strictEqual(
				await handshake(urlOf(direct.chat).replace(/^ws/, "http"), {
					cookie,
					origin: publicOrigin,
				}),
				409,
			)

			// A live Chat gets the Live model. Each call makes a new one.
			const created = await json(
				send(alice.session, `/v1/bots/${botId}/live`, "POST", {}),
				201,
			)
			assert.strictEqual(created.chat.kind, "live")
			assert.strictEqual(created.chat.settings.model.model, "talk")
			const chat: string = created.chat.id
			const liveUrl = urlOf(chat)

			// A live Chat takes only Live models, and other Chats never take them.
			const text = {
				_tag: "Config.Selection",
				provider: "fixture",
				model: "fixture-model",
			}
			const toText = await json(
				send(alice.session, `/v1/chats/${chat}`, "PATCH", {
					expected: created.chat.revision,
					model: text,
				}),
				400,
			)
			assert.strictEqual(toText._tag, "ChatModelInvalid")
			const directView = await json(
				send(alice.session, `/v1/chats/${direct.chat}`),
			)
			const toLive = await json(
				send(alice.session, `/v1/chats/${direct.chat}`, "PATCH", {
					expected: directView.chat.revision,
					model: talk,
				}),
				400,
			)
			assert.strictEqual(toLive._tag, "ChatModelInvalid")

			// The default list has live Chats.
			const listed = await json(send(alice.session, "/v1/chats"))
			assert.ok(
				listed.some(
					(summary: { readonly chat: { readonly id: string } }) =>
						summary.chat.id === chat,
				),
			)

			// While no Live session is open, a message waits in the inbox.
			const waiting = await json(
				send(alice.session, `/v1/chats/${chat}/messages`, "POST", {
					input: "Remember me",
				}),
				202,
			)
			assert.strictEqual(waiting.delivery, "queued")
			assert.strictEqual(waiting.turn, null)
			const idle = await json(send(alice.session, `/v1/chats/${chat}`))
			assert.strictEqual(idle.status, "Idle")

			// A page on another site cannot open the socket with the cookie.
			assert.strictEqual(
				await handshake(liveUrl.replace(/^ws/, "http"), {
					cookie,
					origin: "https://other.example.com",
				}),
				403,
			)
			// A format that the model does not have fails before the upgrade.
			assert.strictEqual(
				await handshake(
					liveUrl.replace(/^ws/, "http") + "?inputFormat=opus@48000",
					{ cookie, origin: publicOrigin },
				),
				409,
			)

			const client = connect(liveUrl + "?voice=calm", {
				cookie,
				origin: publicOrigin,
			})
			await client.opened
			await client.until((all) => all.some((m) => m.type === "session.ready"))
			const ready = client.messages.find((m) => m.type === "session.ready")
			assert.ok(ready?.type === "session.ready")
			assert.strictEqual(ready.model, "talk")
			assert.deepStrictEqual(ready.audio, { input: pcm, output: pcm })
			assert.strictEqual(ready.voice, "calm")

			// The session runs the message that waited, and the client hears the Turn.
			const completedTurns = () =>
				client.messages.filter((m) => m.type === "turn.completed")
			await client.until(() => completedTurns().length === 1)
			assert.ok(
				fake.inputs.some(
					(input) => input._tag === "Text" && input.text === "Remember me",
				),
			)
			assert.deepStrictEqual(client.sounds, [answerSound])

			// Alice talks. The Bot answers with sound and text, in a Turn.
			client.socket.send(new Uint8Array([9, 9, 9, 9]))
			await client.until(() => completedTurns().length === 2)
			const types = client.messages.map((m) => m.type)
			assert.ok(types.includes("input.speech.started"))
			assert.ok(types.includes("input.transcript"))
			assert.ok(types.includes("turn.started"))
			const completed = completedTurns()[1]
			assert.ok(completed?.type === "turn.completed")
			assert.strictEqual(completed.status, "Completed")
			assert.ok(
				client.messages
					.flatMap((m) =>
						m.type === "output.transcript.delta" ? [m.delta] : [],
					)
					.join("")
					.endsWith("It is noon."),
			)
			assert.deepStrictEqual(client.sounds, [answerSound, answerSound])

			// The Turn is in the history of the Chat, like a text Turn.
			const turn = await json(
				send(alice.session, `/v1/chats/${chat}/turns/${completed.turnId}`),
			)
			assert.strictEqual(turn.turn.status._tag, "Completed")
			assert.strictEqual(turn.turn.status.result.text, "It is noon.")
			const items = JSON.stringify(
				await json(
					send(
						alice.session,
						`/v1/chats/${chat}/turns/${completed.turnId}/items`,
					),
				),
			)
			assert.match(items, /What time is it\?/)

			// The backend got the Bot instructions for a talk with sound, and the sound.
			const configured = fake.inputs.filter(
				(input) => input._tag === "Configure",
			)
			const last = configured.at(-1)
			assert.ok(last?._tag === "Configure")
			assert.match(last.config.instructions, /talk with sound/)
			assert.strictEqual(last.config.voice, "calm")
			assert.ok(fake.inputs.some((input) => input._tag === "Audio"))
			// The person said the text, so it does not go to the backend again.
			assert.ok(
				!fake.inputs.some(
					(input) => input._tag === "Text" && input.text === "What time is it?",
				),
			)

			// Only one session for each live Chat.
			const second = connect(liveUrl, { cookie, origin: publicOrigin })
			await second.opened
			await second.until((all) => all.some((m) => m.type === "error"))
			second.socket.close()

			// Typed text starts a Turn too, and goes to the backend as text.
			client.socket.send(JSON.stringify({ type: "input.text", text: "Thanks" }))
			await client.until(() => completedTurns().length === 3)
			assert.ok(
				fake.inputs.some(
					(input) => input._tag === "Text" && input.text === "Thanks",
				),
			)
			// A message that the backend does not support gives an error, and the session stays open.
			client.socket.send(
				JSON.stringify({ type: "output.truncate", itemId: "x", audioEndMs: 1 }),
			)
			await client.until((all) =>
				all.some((m) => m.type === "error" && m.code === "unsupported"),
			)
			client.socket.close()

			// A user token opens a Live session in the same way. The new session gets
			// the earlier messages of the Chat.
			const token = await json(
				send(alice.session, "/v1/user/tokens", "POST", { name: "live" }),
				201,
			)
			const keyed = connect(liveUrl, {
				authorization: "Bearer " + token.secret,
			})
			await keyed.opened
			await keyed.until((all) => all.some((m) => m.type === "session.ready"))
			const history = fake.inputs.find((input) => input._tag === "History")
			assert.ok(history?._tag === "History")
			assert.strictEqual(history.messages[0]?.text, "Remember me")
			keyed.socket.close()
		} finally {
			await host.close()
		}
	},
)
