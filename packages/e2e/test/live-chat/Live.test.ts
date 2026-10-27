import {
	BrowserHost,
	Caller,
	Devices,
	Messages,
	Wait,
} from "@openbot-build/openbot/testing"
import { NodeHttpClient, NodeSocket } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import {
	ChatSummary,
	ChatView,
	LiveApi,
	ChatCommandReceipt,
	UserTokensApi,
} from "@openbot-build/api"
import { Execution } from "@openbot-build/domain"
import { Live } from "@openbot-build/core"
import {
	Array as Arr,
	Effect,
	Deferred,
	type Scope,
	Fiber,
	Layer,
	Redacted,
	Option,
	pipe,
	Queue,
	Ref,
	Schema,
	Stream,
	String as Str,
	SubscriptionRef,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { Socket } from "effect/socket"

const { until } = Wait
const { message, settled } = Messages
type Send = Messages.Send

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
const fakeBackendWith = (
	acquire: Effect.Effect<void, never, Scope.Scope> = Effect.void,
) =>
	Effect.gen(function* () {
		const inputs = yield* Ref.make<ReadonlyArray<Live.Input>>([])
		const answers = yield* Ref.make(0)
		const backend = Devices.liveBackend(({ providerId, modelId }) =>
			Effect.succeed({
				provider: providerId,
				model: modelId,
				capabilities,
				connect: () =>
					Effect.gen(function* () {
						yield* acquire
						const events = yield* Queue.unbounded<Live.Event, Live.LiveError>()
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
												input: {
													total: 12,
													text: 5,
													audio: 7,
													image: 0,
													cached: 0,
												},
												output: { total: 12, text: 3, audio: 9 },
											},
										}),
									])
								}
							})
						return { send, events: Stream.fromQueue(events) }
					}),
			}),
		)
		return { backend, inputs: Ref.get(inputs) }
	})

const fakeBackend = fakeBackendWith()

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
	for (const opening of [false, true]) {
		it.effect(
			`Chat delete waits for a Live connection that is ${opening ? "opening" : "idle"}`,
			() =>
				Effect.gen(function* () {
					const opened = yield* Deferred.make<void>()
					const closing = yield* Deferred.make<void>()
					const release = yield* Deferred.make<void>()
					const fake = yield* fakeBackendWith(
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() =>
								Deferred.succeed(closing, undefined).pipe(
									Effect.andThen(Deferred.await(release)),
								),
							)
							yield* Deferred.succeed(opened, undefined)
							if (opening) return yield* Effect.never
						}),
					)
					const host = yield* BrowserHost.start({
						publicOrigin,
						liveBackends: fake.backend,
						bots: { memory: false },
					})
					const alice = yield* host.login("live-delete")
					const bot = yield* host.defaultBot(alice.session)
					const address = yield* host.address
					const call = Caller.withCookie({ address, publicOrigin })
					const send: Send = (path, method, payload) =>
						call(alice.session, path, method, payload)
					yield* text(
						send("/v1/organization/models", "POST", {
							id: "talk",
							name: "Talk",
							type: "live",
							reasoningEfforts: [],
							serviceTiers: [],
						}),
					)
					yield* json(
						Created,
						send("/v1/organization/model_providers", "POST", {
							kind: "openai",
							name: "Voice",
							apiKey: "test-voice-key",
							models: [{ model: "talk", modelOwner: "organization" }],
						}),
					)
					const created = yield* json(
						ChatView,
						send(`/v1/bots/${bot}/live`, "POST", {}),
						201,
					)
					const path = `/v1/chats/${created.chat.id}`
					yield* Effect.gen(function* () {
						const connection = yield* connect(
							Str.replace(/^http/, "ws")(address) + path + "/live",
							{
								cookie: Caller.sessionCookie(alice.session),
								origin: publicOrigin,
							},
						)
						yield* Deferred.await(opened)
						if (!opening)
							yield* connection.until((messages) =>
								Arr.some(messages, isType("session.ready")),
							)
						const receipt = yield* json(
							Execution.Receipt,
							send(path, "DELETE", { commandKey: "delete-live" }),
							202,
						)
						yield* Deferred.await(closing)
						assert.equal((yield* send(path, "GET")).status, 200)
						const progress = yield* json(
							Execution.Record,
							send(`/v1/executions/${receipt.executionId}`, "GET"),
						)
						assert.isFalse(Execution.isTerminal(progress.status))
						yield* Deferred.succeed(release, undefined)
						yield* until(
							"the Live Chat delete",
							json(
								Execution.Record,
								send(`/v1/executions/${receipt.executionId}`, "GET"),
							).pipe(
								Effect.map((record) =>
									record.status === "completed"
										? Option.some(record)
										: Option.none(),
								),
							),
						)
						assert.equal((yield* send(path, "GET")).status, 404)
					}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
				}),
			60000,
		)
	}
	it.effect(
		"a Live connection runs saved Turns and restores history",
		() =>
			Effect.gen(function* () {
				const fake = yield* fakeBackend
				const host = yield* BrowserHost.start({
					publicOrigin,
					liveBackends: fake.backend,
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
				const noUpgrade = yield* json(
					LiveApi.LiveUnavailable,
					send(alice.session, `/v1/chats/${chat}/live`),
					409,
				)
				assert.strictEqual(
					noUpgrade.message,
					"Open this address as a WebSocket.",
				)

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
					ChatCommandReceipt,
					send(alice.session, `/v1/chats/${chat}/messages`, "POST", {
						input: "Remember me",
						commandKey: "remember",
					}),
					202,
				)
				assert.ok(waiting.executionId.length > 0)
				assert.ok(waiting.turn.length > 0)
				const idle = yield* json(
					ChatView,
					send(alice.session, `/v1/chats/${chat}`),
				)
				assert.strictEqual(idle.status, "Running")

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
					yield* encodeClientMessage({
						type: "input.text",
						text: "Thanks",
						commandKey: Execution.CommandKey.make("thanks"),
					}),
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
				yield* keyed.send(
					yield* encodeClientMessage({
						type: "input.text",
						text: "Again",
						commandKey: Execution.CommandKey.make("again"),
					}),
				)
				yield* keyed.until((received) => {
					const accepted = Arr.findFirst(
						received,
						(item) =>
							item.type === "command.accepted" &&
							item.receipt.commandKey === "again",
					)
					if (
						Option.isNone(accepted) ||
						accepted.value.type !== "command.accepted"
					)
						return false
					const id = accepted.value.receipt.executionId
					return Arr.some(
						received,
						(item) => item.type === "turn.completed" && item.executionId === id,
					)
				})
				const history = Arr.findFirst(
					yield* fake.inputs,
					Live.Input.$is("History"),
				)
				assert.ok(Option.isSome(history))
				assert.strictEqual(
					Arr.filter(
						history.value.messages,
						(message) =>
							"text" in message &&
							message.role === "user" &&
							message.text === "Remember me",
					).length,
					1,
				)
				assert.ok(
					!Arr.some(
						history.value.messages,
						(message) => "text" in message && message.text === "Again",
					),
				)
				yield* keyed.close

				// A saved Turn keeps model A after the Chat changes to model B.
				yield* text(
					send(alice.session, "/v1/organization/models", "POST", {
						id: "talk-next",
						name: "Next voice",
						type: "live",
						reasoningEfforts: [],
						serviceTiers: [],
					}),
				)
				const nextProvider = yield* json(
					Created,
					send(alice.session, "/v1/organization/model_providers", "POST", {
						kind: "openai",
						name: "Next voice",
						apiKey: "sk-live-next-0123456789",
						models: [{ model: "talk-next", modelOwner: "organization" }],
					}),
				)
				const pending = yield* json(
					ChatCommandReceipt,
					send(alice.session, `/v1/chats/${chat}/messages`, "POST", {
						input: "Keep this model",
						commandKey: "keep-model",
					}),
					202,
				)
				const beforeModelChange = yield* json(
					ChatView,
					send(alice.session, `/v1/chats/${chat}`),
				)
				yield* json(
					ChatView,
					send(alice.session, `/v1/chats/${chat}`, "PATCH", {
						expected: beforeModelChange.chat.revision,
						model: {
							_tag: "Config.Selection",
							provider: nextProvider.id,
							model: "talk-next",
						},
					}),
				)
				const restored = yield* connect(liveUrl, {
					cookie,
					origin: publicOrigin,
				})
				yield* restored.until((all) =>
					Arr.some(
						all,
						(event) =>
							event.type === "turn.completed" &&
							event.executionId === pending.executionId,
					),
				)
				assert.ok(
					Arr.some(
						yield* restored.messages,
						(event) => event.type === "session.ready" && event.model === "talk",
					),
				)
				yield* restored.until((all) =>
					Arr.some(all, isType("session.reconnect")),
				)
				yield* restored.close
				const idleConnection = yield* connect(liveUrl, {
					cookie,
					origin: publicOrigin,
				})
				yield* idleConnection.until((all) =>
					Arr.some(
						all,
						(event) =>
							event.type === "session.ready" && event.model === "talk-next",
					),
				)
				// An idle socket must hear a model change when input arrives through HTTP.
				const beforeHttp = yield* json(
					ChatView,
					send(alice.session, `/v1/chats/${chat}`),
				)
				yield* json(
					ChatView,
					send(alice.session, `/v1/chats/${chat}`, "PATCH", {
						expected: beforeHttp.chat.revision,
						model: talk,
					}),
				)
				const fromHttp = yield* json(
					ChatCommandReceipt,
					send(alice.session, `/v1/chats/${chat}/messages`, "POST", {
						input: "Change from HTTP",
						commandKey: "http-model",
					}),
					202,
				)
				yield* idleConnection.until((all) =>
					Arr.some(all, isType("session.reconnect")),
				)
				yield* idleConnection.close
				const finalConnection = yield* connect(liveUrl, {
					cookie,
					origin: publicOrigin,
				})
				yield* finalConnection.until((all) =>
					Arr.some(
						all,
						(event) =>
							event.type === "turn.completed" &&
							event.executionId === fromHttp.executionId,
					),
				)
				yield* finalConnection.close

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
