import { NodeHttpClient, NodeSocket } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import {
	ChatSummary,
	ChatView,
	ChatExecutionBlocked,
	FilesApi,
	LiveApi,
	ModelProvidersApi,
	MessageReceipt,
	UserTokensApi,
} from "@openbot-build/api"
import { Chat, Live } from "@openbot-build/core"
import { eq } from "drizzle-orm"
import {
	Array as Arr,
	Effect,
	Fiber,
	Layer,
	Redacted,
	Option,
	pipe,
	Queue,
	Ref,
	Schema,
	Schedule,
	Stream,
	String as Str,
	SubscriptionRef,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { Socket } from "effect/socket"
import * as LiveBackends from "../src/models/LiveBackends.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import * as FileStorageFixture from "./FileStorageFixture.ts"
import * as Db from "../src/database/Database.ts"
import { chats as chatRows, files, fileRefs } from "../src/database/Schema.ts"
import { fileIdOf } from "../src/files/Refs.ts"
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

type ServerMessage = LiveApi.LiveServerMessage

const decodeServerMessage = Schema.decodeEffect(
	Schema.fromJsonString(LiveApi.LiveServerMessage),
)
const encodeServerMessages = Schema.encodeEffect(
	Schema.fromJsonString(Schema.Array(LiveApi.LiveServerMessage)),
)
const encodeClientMessage = Schema.encodeEffect(
	Schema.fromJsonString(LiveApi.LiveClientMessage),
)

/** An answer that names what went wrong. */
const Tagged = Schema.Struct({ _tag: Schema.String })
const Created = Schema.Struct({ id: Schema.String })
const Organizations = Schema.Struct({
	items: Schema.Array(Schema.Struct({ id: Schema.String })),
})
const TurnAnswer = Schema.Struct({
	turn: Schema.Struct({
		status: Schema.Struct({
			_tag: Schema.String,
			result: Schema.optionalKey(Schema.Struct({ text: Schema.String })),
		}),
	}),
})

/** The Live client did not get the message that it waited for. */
class NoSuchMessage extends Schema.TaggedError<
	NoSuchMessage,
	{ readonly brand: unique symbol }
>()("NoSuchMessage", { messages: Schema.String }) {
	override get message() {
		return "No such message: " + this.messages
	}
}

/** True for a server message of this type. */
const isType =
	<T extends ServerMessage["type"]>(type: T) =>
	(message: ServerMessage): message is Extract<ServerMessage, { type: T }> =>
		message.type === type

/**
 * A backend that hears one fixed question in any sound, and gives one fixed answer for
 * each answer request. It keeps every input that OpenBot sent.
 */
const fakeBackendWith = (capabilities: Live.Capabilities) =>
	Effect.gen(function* () {
		const inputs = yield* Ref.make<ReadonlyArray<Live.Input>>([])
		const answers = yield* Ref.make(0)
		const backend: LiveBackends.LiveBackend = {
			kind: "openai",
			make: ({ providerId, modelId }) =>
				Effect.succeed({
					provider: providerId,
					model: modelId,
					capabilities,
					connect: () =>
						Effect.gen(function* () {
							const events = yield* Queue.unbounded<
								Live.Event,
								Live.LiveError
							>()
							const send = (input: Live.Input) =>
								Effect.gen(function* () {
									yield* Live.check(capabilities, input)
									yield* Ref.update(inputs, Arr.append(input))
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
										const itemId =
											"answer_" +
											(yield* Ref.updateAndGet(answers, (count) => count + 1))
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
							return {
								send,
								events: Stream.fromQueue(events),
								loadContext: (prompt) =>
									Live.contextOf(prompt, capabilities).pipe(
										Effect.flatMap((items) =>
											send(Live.Input.Context({ id: "history", items })),
										),
									),
							}
						}),
				}),
		}
		return { backend, inputs: Ref.get(inputs) }
	})
const fakeBackend = fakeBackendWith(capabilities)

/**
 * Opens a Live client that keeps every message and every sound frame. It
 * gives the client when the socket is open. The socket closes at the latest
 * when the test ends.
 */
const connect = Effect.fn("Live.connect")(function* (
	url: string,
	headers: Record<string, string>,
) {
	const socket = yield* Socket.makeWebSocket(url, { headers })
	const reader = yield* socket.reader
	const writer = yield* socket.writer
	const messages = yield* SubscriptionRef.make<ReadonlyArray<ServerMessage>>([])
	const sounds = yield* Ref.make<ReadonlyArray<Uint8Array>>([])
	const receive = (frame: string | Uint8Array) =>
		typeof frame === "string"
			? Effect.flatMap(decodeServerMessage(frame), (received) =>
					SubscriptionRef.update(messages, Arr.append(received)),
				)
			: Ref.update(sounds, Arr.append(frame))
	// The pull fails when the socket closes, after a clean close too. That is
	// the normal end of the reading. Any other failure, such as a message that
	// does not decode, makes `until` fail at once.
	const reading = yield* reader.pull.pipe(
		Effect.flatMap((frames) =>
			Effect.forEach(frames, receive, { discard: true }),
		),
		Effect.forever,
		Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
		Effect.forkScoped,
	)
	/** Waits until the messages pass the test, at most 20 seconds. */
	const until = (test: (messages: ReadonlyArray<ServerMessage>) => boolean) =>
		SubscriptionRef.changes(messages).pipe(
			Stream.filter(test),
			Stream.runHead,
			Effect.asVoid,
			Effect.raceFirst(Effect.andThen(Fiber.join(reading), Effect.never)),
			Effect.timeoutOrElse({
				duration: "20 seconds",
				orElse: () =>
					SubscriptionRef.get(messages).pipe(
						Effect.flatMap(encodeServerMessages),
						Effect.flatMap((text) =>
							Effect.fail(NoSuchMessage.make({ messages: text })),
						),
					),
			}),
		)
	return {
		messages: SubscriptionRef.get(messages),
		sounds: Ref.get(sounds),
		until,
		send: writer.write,
		close: writer.write(new Socket.CloseEvent()),
	}
})

/** The status of a WebSocket handshake that the server refuses. */
const handshake = (
	client: HttpClient.HttpClient,
	url: string,
	headers: Record<string, string>,
) =>
	Effect.map(
		client.execute(
			HttpClientRequest.get(url, {
				headers: {
					connection: "Upgrade",
					upgrade: "websocket",
					"sec-websocket-version": "13",
					"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
					...headers,
				},
			}),
		),
		(response) => response.status,
	)

/** Reads the JSON body of an answer with a schema, and checks its status. */
const json = <S extends Schema.Constraint>(
	schema: S,
	call: Caller.Call,
	status = 200,
) => Effect.flatMap(call, Caller.json(schema, status))

/** Checks the status of an answer, and gives its body as text. */
const text = (call: Caller.Call, status = 200) =>
	Effect.gen(function* () {
		const response = yield* call
		const body = yield* response.text
		assert.strictEqual(response.status, status, body)
		return body
	})

layer(
	Layer.merge(BrowserHost.layerPlatform, NodeSocket.layerWebSocketConstructor),
	{
		excludeTestServices: true,
	},
)((it) => {
	it.effect(
		"Live images persist before a Turn, load after reconnect, and cannot switch to a text-only model",
		() =>
			Effect.gen(function* () {
				const fake = yield* fakeBackendWith({
					...capabilities,
					inputs: { text: true, image: true, imageMediaTypes: ["image/png"] },
				})
				const storage = yield* FileStorageFixture.make
				const host = yield* BrowserHost.start({
					publicOrigin,
					liveBackends: LiveBackends.layer([fake.backend]),
					platformFetch: storage.fetch,
					platformAdmins: ["root@example.com"],
					bots: { memory: false },
				})
				const address = yield* host.address
				const call = Caller.withCookie({ address, publicOrigin })
				const alice = yield* host.login("alice")
				const root = yield* host.login("root")
				const asAlice: Send = (path, method, payload) =>
					call(alice.session, path, method, payload)
				const settings = yield* json(
					Schema.Struct({ version: Schema.Finite }),
					call(root.session, "/v1/platform/settings"),
				)
				yield* text(
					call(root.session, "/v1/platform/settings", "PATCH", {
						expectedVersion: settings.version,
						files: {
							storage: {
								endpoint: FileStorageFixture.origin,
								publicEndpoint: null,
								region: "us-east-1",
								bucket: "openbot",
								accessKeyId: "test-access-key",
								secretAccessKey: "test-secret-access-key",
								forcePathStyle: true,
							},
						},
					}),
				)
				const model = yield* json(
					ModelProvidersApi.Model,
					asAlice("/v1/organization/models", "POST", {
						id: "vision-talk",
						type: "live",
						name: "Vision talk",
						reasoningEfforts: [],
						serviceTiers: [],
					}),
				)
				const provider = yield* json(
					Created,
					asAlice("/v1/organization/model_providers", "POST", {
						kind: "openai",
						name: "Vision",
						apiKey: "sk-live-0123456789",
						models: [{ model: model.id, modelOwner: "organization" }],
					}),
				)
				const selection = {
					_tag: "Config.Selection",
					provider: provider.id,
					model: model.id,
				}
				const bot = yield* host.defaultBot(alice.session)
				const receipt = yield* message(
					asAlice,
					bot,
					"Remember this conversation before looking at my image.",
				)
				const chat = receipt.chat
				const view = () => json(ChatView, asAlice(`/v1/chats/${chat}`, "GET"))
				const original = yield* settled(asAlice, chat)
				const unknown = yield* json(
					ChatExecutionBlocked,
					asAlice(`/v1/chats/${chat}/execution`, "PUT", {
						expected: original.chat.revision,
						mode: "live",
						model: selection,
					}),
					409,
				)
				assert.match(unknown.message, /context window/)
				assert.strictEqual((yield* view()).chat.execution.mode, "chat")
				const small = yield* json(
					ModelProvidersApi.Model,
					asAlice(`/v1/organization/models/${model.id}`, "PATCH", {
						expectedVersion: model.version,
						contextWindow: 1,
					}),
				)
				const afterUnknown = yield* view()
				const tooSmall = yield* json(
					ChatExecutionBlocked,
					asAlice(`/v1/chats/${chat}/execution`, "PUT", {
						expected: afterUnknown.chat.revision,
						mode: "live",
						model: selection,
					}),
					409,
				)
				assert.match(tooSmall.message, /too large/)
				assert.strictEqual((yield* view()).chat.execution.mode, "chat")
				yield* json(
					ModelProvidersApi.Model,
					asAlice(`/v1/organization/models/${model.id}`, "PATCH", {
						expectedVersion: small.version,
						contextWindow: 32000,
					}),
				)
				const beforeSwitch = yield* view()
				yield* json(
					ChatView,
					asAlice(`/v1/chats/${chat}/execution`, "PUT", {
						expected: beforeSwitch.chat.revision,
						mode: "live",
						model: selection,
					}),
				)
				const url =
					Str.replace(/^http/, "ws")(address) + `/v1/chats/${chat}/live`
				const headers = {
					cookie: Caller.sessionCookie(alice.session),
					origin: publicOrigin,
				}
				const client = yield* connect(url, headers)
				yield* client.until((all) => Arr.some(all, isType("session.ready")))
				yield* client.send(
					yield* encodeClientMessage({
						type: "input.image",
						mediaType: "image/png",
						data: "UE5HREFUQQ==",
					}),
				)
				const pending = yield* view().pipe(
					Effect.repeat({
						until: (value) => value.inbox === 1,
						schedule: Schedule.spaced("20 millis"),
						times: 100,
					}),
				)
				assert.strictEqual(pending.inbox, 1)
				assert.strictEqual(pending.status, "Completed")
				assert.strictEqual(
					Arr.filter(yield* fake.inputs, Live.Input.$is("Respond")).length,
					0,
				)
				assert.strictEqual(
					Arr.filter(yield* fake.inputs, Live.Input.$is("Image")).length,
					0,
				)
				const stored = yield* host.run(
					Effect.flatMap(Db.make, (db) => db.select().from(files)),
				)
				assert.strictEqual(stored.length, 1)
				const image = stored[0]!
				assert.isTrue(yield* storage.has(`/openbot/files/${image.id}`))
				const file = yield* json(
					FilesApi.FileObject,
					asAlice(`/v1/files/${image.id}`, "GET"),
				)
				assert.strictEqual(file.status, "ready")
				assert.strictEqual(file.bytes, 7)
				assert.strictEqual(
					yield* text(asAlice(`/v1/files/${image.id}/content`, "GET")),
					"PNGDATA",
				)
				const raw = (yield* host.run(
					Effect.flatMap(Db.make, (db) =>
						db
							.select({ body: chatRows.body })
							.from(chatRows)
							.where(eq(chatRows.id, chat)),
					),
				))[0]!
				const record = yield* Schema.decodeEffect(
					Schema.fromJsonString(
						Schema.Struct({ inbox: Schema.Array(Chat.InboxEntry) }),
					),
				)(raw.body)
				assert.strictEqual(record.inbox.length, 1)
				assert.strictEqual(record.inbox[0]!.passive, true)
				const first = record.inbox[0]!.content.content[0]
				assert.ok(first?.role === "user")
				const part = first.content[0]
				assert.ok(part?.type === "file" && part.data instanceof URL)
				assert.strictEqual(Option.getOrThrow(fileIdOf(part.data)), image.id)

				// The queued image is checked before it becomes history as well.
				const blocked = yield* json(
					ChatExecutionBlocked,
					asAlice(`/v1/chats/${chat}/execution`, "PUT", {
						expected: pending.chat.revision,
						mode: "chat",
					}),
					409,
				)
				assert.match(blocked.message, /image\/png/)
				assert.strictEqual((yield* view()).chat.execution.mode, "live")
				yield* client.send(
					yield* encodeClientMessage({
						type: "input.text",
						text: "What is in this image?",
					}),
				)
				yield* client.until((all) =>
					Arr.some(all, (entry) => entry.type === "output.transcript.delta"),
				)
				const completed = yield* settled(asAlice, chat)
				assert.strictEqual(completed.inbox, 0)
				const images = Arr.filter(yield* fake.inputs, Live.Input.$is("Image"))
				assert.strictEqual(images.length, 1)
				assert.strictEqual(images[0]!.mediaType, "image/png")
				assert.strictEqual(
					new TextDecoder().decode(images[0]!.bytes),
					"PNGDATA",
				)
				assert.strictEqual(
					Arr.filter(yield* fake.inputs, Live.Input.$is("Respond")).length,
					1,
				)
				const refs = yield* host.run(
					Effect.flatMap(Db.make, (db) =>
						db.select().from(fileRefs).where(eq(fileRefs.file, image.id)),
					),
				)
				assert.strictEqual(refs.length, 1)
				yield* client.close
				const disconnected = yield* view().pipe(
					Effect.repeat({
						until: (value) => value.chat.execution.phase === "selected",
						schedule: Schedule.spaced("20 millis"),
						times: 100,
					}),
				)
				assert.strictEqual(disconnected.chat.execution.phase, "selected")
				const resumed = yield* connect(url, headers)
				yield* resumed.until((all) => Arr.some(all, isType("session.ready")))
				const restored = Arr.findLast(
					yield* fake.inputs,
					Live.Input.$is("Context"),
				)
				assert.ok(Option.isSome(restored))
				const restoredImages = Arr.flatMap(restored.value.items, (item) =>
					item.type === "message"
						? Arr.filter(item.content, (content) => content.type === "image")
						: [],
				)
				assert.strictEqual(restoredImages.length, 1)
				assert.strictEqual(
					Arr.filter(yield* fake.inputs, Live.Input.$is("Image")).length,
					1,
				)
				assert.strictEqual(
					Arr.filter(yield* fake.inputs, Live.Input.$is("Respond")).length,
					1,
				)
				const beforeRejectedSwitch = yield* view()
				yield* json(
					ChatExecutionBlocked,
					asAlice(`/v1/chats/${chat}/execution`, "PUT", {
						expected: beforeRejectedSwitch.chat.revision,
						mode: "chat",
					}),
					409,
				)
				assert.strictEqual((yield* view()).chat.execution.mode, "live")
				yield* resumed.close
			}),
		180000,
	)

	it.effect(
		"a person talks with a Bot in a live Chat, and only the Live session starts its Turns",
		() =>
			Effect.gen(function* () {
				const fake = yield* fakeBackend
				const host = yield* BrowserHost.start({
					publicOrigin,
					liveBackends: LiveBackends.layer([fake.backend]),
					bots: { memory: false },
				})
				// The fetch client cannot send an upgrade request, so the
				// handshakes use the Undici client.
				const dispatcher = yield* NodeHttpClient.makeDispatcher
				const upgrades = yield* NodeHttpClient.makeUndici.pipe(
					Effect.provideService(NodeHttpClient.Dispatcher, dispatcher),
				)
				const address = yield* host.address
				const send = Caller.withCookie({ address, publicOrigin })
				const alice = yield* host.login("alice")
				const asAlice: Send = (path, method, payload) =>
					send(alice.session, path, method, payload)
				const botId = yield* host.defaultBot(alice.session)
				const direct = yield* message(asAlice, botId, "Hello")
				yield* settled(asAlice, direct.chat)
				const cookie = Caller.sessionCookie(alice.session)
				const urlOf = (chat: string) =>
					Str.replace(/^http/, "ws")(address) + `/v1/chats/${chat}/live`
				const knock = (url: string, headers: Record<string, string>) =>
					handshake(upgrades, Str.replace(/^ws/, "http")(url), headers)

				// Without a Live model, OpenBot makes no live Chat.
				const none = yield* json(
					Tagged,
					send(alice.session, `/v1/bots/${botId}/live`, "POST", {}),
					409,
				)
				assert.strictEqual(none._tag, "LiveUnavailable")

				// Alice adds a Live model with the key of her organization.
				yield* text(
					send(alice.session, "/v1/organization/models", "POST", {
						id: "talk",
						name: "Talk",
						type: "live",
						contextWindow: 32000,
						reasoningEfforts: [],
						serviceTiers: [],
					}),
				)
				const provider = yield* json(
					Created,
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
					yield* knock(urlOf(direct.chat), {
						cookie,
						origin: publicOrigin,
					}),
					409,
				)

				// A live Chat gets the Live model. Each call makes a new one.
				const created = yield* json(
					ChatView,
					send(alice.session, `/v1/bots/${botId}/live`, "POST", {}),
					201,
				)
				assert.strictEqual(created.chat.kind, "live")
				assert.strictEqual(created.chat.settings.model?.model, "talk")
				const chat: string = created.chat.id
				const liveUrl = urlOf(chat)

				// A live Chat takes only Live models, and other Chats never take them.
				const textModel = {
					_tag: "Config.Selection",
					provider: "fixture",
					model: "fixture-model",
				}
				const toText = yield* json(
					Tagged,
					send(alice.session, `/v1/chats/${chat}`, "PATCH", {
						expected: created.chat.revision,
						model: textModel,
					}),
					400,
				)
				assert.strictEqual(toText._tag, "ChatModelInvalid")
				const directView = yield* json(
					ChatView,
					send(alice.session, `/v1/chats/${direct.chat}`),
				)
				const toLive = yield* json(
					Tagged,
					send(alice.session, `/v1/chats/${direct.chat}`, "PATCH", {
						expected: directView.chat.revision,
						model: talk,
					}),
					400,
				)
				assert.strictEqual(toLive._tag, "ChatModelInvalid")

				// The default list has live Chats.
				const listed = yield* json(
					Schema.Array(ChatSummary),
					send(alice.session, "/v1/chats"),
				)
				assert.ok(Arr.some(listed, (summary) => summary.chat.id === chat))

				// While no Live session is open, a message waits in the inbox.
				const waiting = yield* json(
					MessageReceipt,
					send(alice.session, `/v1/chats/${chat}/messages`, "POST", {
						input: "Remember me",
					}),
					202,
				)
				assert.strictEqual(waiting.delivery, "queued")
				assert.strictEqual(waiting.turn, null)
				const idle = yield* json(
					ChatView,
					send(alice.session, `/v1/chats/${chat}`),
				)
				assert.strictEqual(idle.status, "Idle")

				// A page on another site cannot open the socket with the cookie.
				assert.strictEqual(
					yield* knock(liveUrl, {
						cookie,
						origin: "https://other.example.com",
					}),
					403,
				)
				// A format that the model does not have fails before the upgrade.
				assert.strictEqual(
					yield* knock(liveUrl + "?inputFormat=opus@48000", {
						cookie,
						origin: publicOrigin,
					}),
					409,
				)

				const client = yield* connect(liveUrl + "?voice=calm", {
					cookie,
					origin: publicOrigin,
				})
				yield* client.until((all) => Arr.some(all, isType("session.ready")))
				const ready = Arr.findFirst(
					yield* client.messages,
					isType("session.ready"),
				)
				assert.ok(Option.isSome(ready))
				assert.strictEqual(ready.value.model, "talk")
				assert.deepStrictEqual(ready.value.audio, { input: pcm, output: pcm })
				assert.strictEqual(ready.value.voice, "calm")

				// The session runs the message that waited, and the client hears the Turn.
				const completedTurns = (all: ReadonlyArray<ServerMessage>) =>
					Arr.filter(all, isType("turn.completed"))
				yield* client.until((all) => completedTurns(all).length === 1)
				assert.ok(
					Arr.some(
						yield* fake.inputs,
						(input) => input._tag === "Text" && input.text === "Remember me",
					),
				)
				assert.deepStrictEqual(yield* client.sounds, [answerSound])

				// Alice talks. The Bot answers with sound and text, in a Turn.
				yield* client.send(new Uint8Array([9, 9, 9, 9]))
				yield* client.until((all) => completedTurns(all).length === 2)
				const all = yield* client.messages
				const types = Arr.map(all, (received) => received.type)
				assert.ok(Arr.contains(types, "input.speech.started"))
				assert.ok(Arr.contains(types, "input.transcript"))
				assert.ok(Arr.contains(types, "turn.started"))
				const completed = Arr.get(completedTurns(all), 1)
				assert.ok(Option.isSome(completed))
				assert.strictEqual(completed.value.status, "Completed")
				assert.ok(
					pipe(
						all,
						Arr.flatMap((received) =>
							received.type === "output.transcript.delta"
								? [received.delta]
								: [],
						),
						Arr.join(""),
						Str.endsWith("It is noon."),
					),
				)
				assert.deepStrictEqual(yield* client.sounds, [answerSound, answerSound])

				// The Turn is in the history of the Chat, like a text Turn.
				const turn = yield* json(
					TurnAnswer,
					send(
						alice.session,
						`/v1/chats/${chat}/turns/${completed.value.turnId}`,
					),
				)
				assert.strictEqual(turn.turn.status._tag, "Completed")
				assert.strictEqual(turn.turn.status.result?.text, "It is noon.")
				const items = yield* text(
					send(
						alice.session,
						`/v1/chats/${chat}/turns/${completed.value.turnId}/items`,
					),
				)
				assert.match(items, /What time is it\?/)

				// The backend got the Bot instructions for a talk with sound, and the sound.
				const inputs = yield* fake.inputs
				const last = Arr.last(Arr.filter(inputs, Live.Input.$is("Configure")))
				assert.ok(Option.isSome(last))
				assert.match(last.value.config.instructions, /talk with sound/)
				assert.strictEqual(last.value.config.voice, "calm")
				assert.ok(Arr.some(inputs, Live.Input.$is("Audio")))
				// The person said the text, so it does not go to the backend again.
				assert.ok(
					!Arr.some(
						inputs,
						(input) =>
							input._tag === "Text" && input.text === "What time is it?",
					),
				)

				// Only one session for each live Chat.
				const second = yield* connect(liveUrl, {
					cookie,
					origin: publicOrigin,
				})
				yield* second.until((received) => Arr.some(received, isType("error")))
				yield* second.close

				// Typed text starts a Turn too, and goes to the backend as text.
				yield* client.send(
					yield* encodeClientMessage({ type: "input.text", text: "Thanks" }),
				)
				yield* client.until((received) => completedTurns(received).length === 3)
				assert.ok(
					Arr.some(
						yield* fake.inputs,
						(input) => input._tag === "Text" && input.text === "Thanks",
					),
				)
				// A message that the backend does not support gives an error, and the session stays open.
				yield* client.send(
					yield* encodeClientMessage({
						type: "output.truncate",
						itemId: "x",
						audioEndMs: 1,
					}),
				)
				yield* client.until((received) =>
					Arr.some(
						received,
						(item) => item.type === "error" && item.code === "unsupported",
					),
				)
				yield* client.close

				// A user token opens a Live session in the same way. The new session gets
				// the earlier messages of the Chat.
				const token = yield* json(
					UserTokensApi.CreatedToken,
					send(alice.session, "/v1/user/tokens", "POST", { name: "live" }),
					201,
				)
				const keyed = yield* connect(liveUrl, {
					authorization: "Bearer " + Redacted.value(token.secret),
				})
				yield* keyed.until((received) =>
					Arr.some(received, isType("session.ready")),
				)
				const history = Arr.findLast(
					yield* fake.inputs,
					Live.Input.$is("Context"),
				)
				assert.ok(Option.isSome(history))
				assert.ok(
					Arr.some(
						history.value.items,
						(item) =>
							item.type === "message" &&
							Arr.some(
								item.content,
								(part) =>
									part.type === "text" &&
									Str.includes("Remember me")(part.text),
							),
					),
				)
				yield* keyed.close

				// The same direct Chat switches in both directions. No switch creates a Turn.
				const before = yield* json(
					ChatView,
					send(alice.session, `/v1/chats/${direct.chat}`),
				)
				const switched = yield* json(
					ChatView,
					send(alice.session, `/v1/chats/${direct.chat}/execution`, "PUT", {
						expected: before.chat.revision,
						mode: "live",
						model: talk,
					}),
				)
				assert.strictEqual(switched.chat.id, direct.chat)
				assert.strictEqual(switched.chat.kind, "direct")
				assert.strictEqual(switched.chat.execution.mode, "live")
				assert.strictEqual(switched.chat.execution.phase, "selected")
				assert.deepStrictEqual(switched.turn, before.turn)
				const stale = yield* json(
					Tagged,
					send(alice.session, `/v1/chats/${direct.chat}/execution`, "PUT", {
						expected: before.chat.revision,
						mode: "chat",
					}),
					409,
				)
				assert.strictEqual(stale._tag, "ChatConflict")
				const mixed = yield* connect(urlOf(direct.chat), {
					cookie,
					origin: publicOrigin,
				})
				yield* mixed.until((received) =>
					Arr.some(received, isType("session.ready")),
				)
				const directHistory = Arr.findLast(
					yield* fake.inputs,
					Live.Input.$is("Context"),
				)
				assert.ok(Option.isSome(directHistory))
				assert.ok(
					Arr.some(
						directHistory.value.items,
						(item) =>
							item.type === "message" &&
							Arr.some(
								item.content,
								(part) => part.type === "text" && part.text === "Hello",
							),
					),
				)
				yield* mixed.send(
					yield* encodeClientMessage({
						type: "input.text",
						text: "Continue in Live",
					}),
				)
				yield* mixed.until((received) => completedTurns(received).length === 1)
				yield* settled(asAlice, direct.chat)
				const liveView = yield* json(
					ChatView,
					send(alice.session, `/v1/chats/${direct.chat}`),
				)
				// An idle socket can switch back using an API key. It loses ownership immediately.
				const normal = yield* json(
					ChatView,
					Caller.withToken(address)(
						token.secret,
						`/v1/chats/${direct.chat}/execution`,
						"PUT",
						{
							expected: liveView.chat.revision,
							mode: "chat",
						},
					),
				)
				assert.strictEqual(normal.chat.kind, "direct")
				assert.strictEqual(normal.chat.execution.mode, "chat")
				assert.strictEqual(
					normal.chat.execution.generation,
					switched.chat.execution.generation + 1,
				)
				yield* mixed.close
				yield* json(
					MessageReceipt,
					send(alice.session, `/v1/chats/${direct.chat}/messages`, "POST", {
						input: "Back to text",
					}),
					202,
				)
				const continued = yield* settled(asAlice, direct.chat)
				const again = yield* json(
					ChatView,
					send(alice.session, `/v1/chats/${direct.chat}/execution`, "PUT", {
						expected: continued.chat.revision,
						mode: "live",
					}),
				)
				assert.strictEqual(again.chat.execution.liveModel?.model, "talk")
				const resumed = yield* connect(urlOf(direct.chat), {
					cookie,
					origin: publicOrigin,
				})
				yield* resumed.until((received) =>
					Arr.some(received, isType("session.ready")),
				)
				const resumedHistory = Arr.findLast(
					yield* fake.inputs,
					Live.Input.$is("Context"),
				)
				assert.ok(Option.isSome(resumedHistory))
				assert.ok(
					Arr.some(
						resumedHistory.value.items,
						(item) =>
							item.type === "message" &&
							Arr.some(
								item.content,
								(part) => part.type === "text" && part.text === "Back to text",
							),
					),
				)
				yield* resumed.close
				const bob = yield* host.login("bob")
				const denied = yield* send(
					bob.session,
					`/v1/chats/${direct.chat}/execution`,
					"PUT",
					{ expected: again.chat.revision, mode: "chat" },
				)
				assert.strictEqual(denied.status, 404)

				// With a second organization, a browser names the organization in the query,
				// because it cannot send the header with a WebSocket.
				const listedOrganizations = yield* json(
					Organizations,
					send(alice.session, "/v1/organizations"),
				)
				const first = Arr.head(listedOrganizations.items)
				assert.ok(Option.isSome(first))
				yield* text(
					send(alice.session, "/v1/organizations", "POST", { name: "Second" }),
				)
				assert.strictEqual(
					yield* knock(liveUrl, {
						cookie,
						origin: publicOrigin,
					}),
					400,
				)
				const named = yield* connect(
					liveUrl + "?organization=" + first.value.id,
					{
						cookie,
						origin: publicOrigin,
					},
				)
				yield* named.until((received) =>
					Arr.some(received, isType("session.ready")),
				)
				yield* named.close
			}),
		180000,
	)
})
