import { Duration } from "effect"
import { LiveApi } from "@openbot-build/api"
import {
	ChatState,
	Live,
	LiveDriver,
	type Chat,
	Turn,
} from "@openbot-build/core"
import {
	Array as Arr,
	Cause,
	Effect,
	Option,
	Order,
	PubSub,
	Ref,
	Result,
	Schedule,
	Schema,
	Stream,
	String as Str,
	pipe,
} from "effect"
import { Base64 } from "effect/encoding"
import { Socket } from "effect/socket"
import type { Prompt } from "effect/ai"
import type * as Chats from "../Chats.ts"
import type { ResolvedLive } from "../../models/ModelRegistry.ts"
import * as Background from "../../app/Background.ts"
import { LiveSessions } from "./LiveSessions.ts"

/**
 * One Live session: one client WebSocket and one connection to a Live backend. The code
 * here knows no backend. It reads only the capabilities of the Live model.
 */

/** What the client asked for, checked against the capabilities of the model. */
export interface Plan {
	readonly audio: {
		readonly input: Live.AudioFormat
		readonly output: Live.AudioFormat
	}
	readonly turnDetection: Live.TurnDetection
	readonly voice?: string
}

/** Picks the formats and the turn detection. It gives a message when they do not fit. */
export const plan = (
	capabilities: Live.Capabilities,
	query: LiveApi.LiveQuery,
): Result.Result<Plan, string> => {
	const pick = (
		offered: ReadonlyArray<Live.AudioFormat>,
		asked: Live.AudioFormat | undefined,
	) =>
		asked === undefined
			? Arr.head(offered)
			: Arr.findFirst(offered, (format) => Live.sameFormat(format, asked))
	const input = pick(capabilities.audio.input, query.inputFormat)
	const output = pick(capabilities.audio.output, query.outputFormat)
	const turnDetection =
		query.turnDetection === undefined
			? Arr.head(capabilities.turnDetection)
			: Arr.findFirst(
					capabilities.turnDetection,
					(mode) => mode === query.turnDetection,
				)
	if (Option.isNone(input))
		return Result.fail("The Live model does not take this input format.")
	if (Option.isNone(output))
		return Result.fail("The Live model does not give this output format.")
	if (Option.isNone(turnDetection))
		return Result.fail("The Live model does not support this turn detection.")
	if (!capabilities.inputTranscription)
		return Result.fail(
			"The Live model does not give the text of what the person says, so OpenBot cannot keep the history.",
		)
	if (
		query.voice !== undefined &&
		capabilities.voices.length > 0 &&
		!Arr.contains(capabilities.voices, query.voice)
	)
		return Result.fail("The Live model does not have this voice.")
	return Result.succeed({
		audio: { input: input.value, output: output.value },
		turnDetection: turnDetection.value,
		...(query.voice === undefined ? {} : { voice: query.voice }),
	})
}

const encodeServer = Schema.encodeEffect(
	Schema.fromJsonString(LiveApi.LiveServerMessage),
)
const decodeClient = Schema.decodeUnknownOption(
	Schema.fromJsonString(LiveApi.LiveClientMessage),
)

/** How many old messages go to the Live model when the session starts. */
const historyLimit = 40
const bySeq = Order.mapInput(
	Order.Number,
	(item: { readonly seq: number }) => item.seq,
)

/** The user and assistant text of some Items, oldest first. */
const historyOf = (prompt: Prompt.Prompt): ReadonlyArray<Live.HistoryMessage> =>
	Arr.flatMap(prompt.content, (message): ReadonlyArray<Live.HistoryMessage> => {
		if (message.role !== "user" && message.role !== "assistant") return []
		const text = pipe(
			message.content,
			Arr.flatMap((part) => (part.type === "text" ? [part.text] : [])),
			Arr.join("\n"),
		)
		return text.length === 0 ? [] : [{ role: message.role, text }]
	})

/** How long the watcher waits before it reads the Chat again for changes of other servers. */
const watchEvery = Duration.seconds(2)

export const run = (input: {
	readonly socket: Socket.Socket
	readonly chats: typeof Chats.Chats.Service
	readonly chat: Chat.Id
	readonly author: Turn.Author
	readonly live: ResolvedLive
	readonly plan: Plan
}) =>
	Effect.scoped(
		Effect.gen(function* () {
			const { chats, chat, author, live } = input
			const capabilities = live.model.capabilities
			const sessions = yield* LiveSessions
			// The reader does the handshake, and the writer waits for it, so the reader comes first.
			const reader = yield* input.socket.reader
			const writer = yield* input.socket.writer
			const say = (message: LiveApi.LiveServerMessage) =>
				encodeServer(message).pipe(
					// The server makes each message from the schema, so a message that does not encode is a bug.
					Effect.orDie,
					Effect.flatMap((text) =>
						writer.write(text).pipe(Effect.ignore({ log: "Debug" })),
					),
				)
			const fail = (code: LiveApi.LiveErrorCode, message: string) =>
				say({ type: "error", code, message })

			const base: LiveDriver.Options["base"] = {
				audio: input.plan.audio,
				turnDetection: input.plan.turnDetection,
				...(input.plan.voice === undefined ? {} : { voice: input.plan.voice }),
			}
			const connected = yield* live.model
				.connect({ ...base, instructions: "", tools: [] })
				.pipe(Effect.result)
			if (Result.isFailure(connected)) {
				yield* fail(connected.failure.reason, connected.failure.message)
				return
			}
			const connection = connected.success
			// The hub ends with the session, also when the session is interrupted. A Turn that
			// waits for an answer then gets this failure and ends.
			const closed = Live.Event.Failure({
				error: Live.LiveError.make({
					reason: "closed",
					message: "The Live session closed.",
				}),
			})
			const events = yield* Effect.acquireRelease(
				PubSub.unbounded<Live.Event>(),
				(pubsub) => PubSub.end(pubsub, closed),
			)
			const driver = yield* LiveDriver.make({
				send: connection.send,
				events,
				base,
			})
			if (!(yield* sessions.register(chat, live.meter(driver.model)))) {
				yield* fail("chat", "This live Chat already has an open Live session.")
				return
			}

			const history = yield* chats.items(chat, { limit: historyLimit }).pipe(
				Effect.map((page) =>
					historyOf(ChatState.promptOf(Arr.sort(page.items, bySeq))),
				),
				Effect.catch((error) =>
					Effect.logWarning(
						"OpenBot could not read the history of a live Chat. The session starts without it.",
						Cause.fail(error),
					).pipe(Effect.as<ReadonlyArray<Live.HistoryMessage>>([])),
				),
			)
			if (history.length > 0)
				yield* connection.send(Live.Input.History({ messages: history }))

			yield* say({
				type: "session.ready",
				provider: live.model.provider,
				model: live.model.model,
				capabilities,
				audio: input.plan.audio,
				turnDetection: input.plan.turnDetection,
				...(input.plan.voice === undefined ? {} : { voice: input.plan.voice }),
			})

			/** The Turn of the Chat that runs now. */
			const running = yield* Ref.make(Option.none<Turn.Id>())
			const interrupt = chats
				.interrupt(chat)
				.pipe(
					Background.logFailure("A live Chat could not stop its running Turn."),
				)
			// The client or the backend is gone, or the session is interrupted. A running Turn must end.
			yield* Effect.addFinalizer(() =>
				Ref.get(running).pipe(
					Effect.flatMap((turn) =>
						Option.isSome(turn) ? interrupt : Effect.void,
					),
				),
			)

			const interruptRunning = Effect.gen(function* () {
				if (Option.isNone(yield* Ref.get(running))) return
				yield* say({ type: "output.stop" })
				if (capabilities.interruption)
					yield* connection
						.send(Live.Input.Cancel())
						.pipe(
							Background.logFailure(
								"The Live backend could not cancel its answer.",
								{ level: "Debug" },
							),
						)
				yield* interrupt
			})

			/** Gives what the person said to the Chat. The watcher reports the Turn. */
			const deliver = (text: string) =>
				chats
					.deliver(chat, { input: text, author })
					.pipe(
						Effect.catch((error) =>
							fail("chat", `OpenBot cannot take the input: ${error._tag}.`),
						),
					)

			/** The last Turn that the client heard of, and whether it heard that it ended. */
			const heard = yield* Ref.make<
				{ readonly id: Turn.Id; readonly ended: boolean } | undefined
			>(undefined)
			/**
			 * Follows the Chat. It reports each Turn to the client, whoever started it, and
			 * starts the Turns of input that waits, such as input that other servers gave
			 * while this process holds the session.
			 */
			const watch = Effect.gen(function* () {
				let view = yield* chats.get(chat)
				while (true) {
					const turn = view.turn
					let told = yield* Ref.get(heard)
					if (turn !== null && turn.id !== told?.id) {
						yield* say({ type: "turn.started", turnId: turn.id })
						told = { id: turn.id, ended: false }
					}
					if (turn !== null && told !== undefined && !told.ended) {
						if (Turn.isTerminal(turn.status)) {
							yield* Ref.set(running, Option.none())
							yield* say({
								type: "turn.completed",
								turnId: turn.id,
								status: turn.status._tag,
							})
							told = { id: turn.id, ended: true }
						} else yield* Ref.set(running, Option.some(turn.id))
					}
					yield* Ref.set(heard, told)
					if (turn === null || Turn.isTerminal(turn.status))
						yield* chats
							.drain(chat)
							.pipe(
								Background.logFailure(
									"A live Chat could not start the input that waits.",
								),
							)
					view = yield* chats.wait(chat, view.chat.revision, watchEvery)
				}
			}).pipe(
				// A short storage failure must not end the session.
				Effect.retry({
					while: (error) => error._tag === "ChatStorageUnavailable",
					schedule: Schedule.exponential("200 millis"),
					times: 5,
				}),
				// A session that cannot follow its Chat ends.
				Effect.tapError((error) =>
					fail("chat", `OpenBot cannot follow the Chat: ${error._tag}.`),
				),
			)

			const onEvent = (event: Live.Event) =>
				Live.Event.$match(event, {
					Ready: () => Effect.void,
					SpeechStarted: () =>
						say({ type: "input.speech.started" }).pipe(
							Effect.andThen(interruptRunning),
						),
					SpeechStopped: () => say({ type: "input.speech.stopped" }),
					Committed: () => Effect.void,
					InputTranscript: ({ itemId, text, final }) =>
						Effect.gen(function* () {
							yield* say({ type: "input.transcript", itemId, text, final })
							if (!final) return
							if (Str.isEmpty(Str.trim(text)))
								return yield* fail(
									"provider",
									"OpenBot did not get the text of what you said.",
								)
							yield* driver.expect(text)
							yield* deliver(text)
						}),
					OutputAudio: ({ bytes }) =>
						writer.write(bytes).pipe(Effect.ignore({ log: "Debug" })),
					OutputTranscript: ({ itemId, delta }) =>
						say({ type: "output.transcript.delta", itemId, delta }),
					OutputDone: ({ itemId }) => say({ type: "output.done", itemId }),
					ToolCall: () => Effect.void,
					ResponseDone: () => Effect.void,
					Failure: ({ error }) => fail(error.reason, error.message),
				})

			/** Events from the backend: to the driver, and to the client. */
			const fromBackend = connection.events.pipe(
				Stream.runForEach((event) =>
					PubSub.publish(events, event).pipe(Effect.andThen(onEvent(event))),
				),
				Effect.catch((error: Live.LiveError) =>
					PubSub.publish(events, Live.Event.Failure({ error })).pipe(
						Effect.andThen(fail(error.reason, error.message)),
					),
				),
			)

			const send = (value: Live.Input) =>
				connection
					.send(value)
					.pipe(Effect.catch((error) => fail(error.reason, error.message)))

			const onMessage = (message: LiveApi.LiveClientMessage) => {
				switch (message.type) {
					case "input.text":
						// The driver sends the text to the backend when the Turn starts.
						return deliver(message.text)
					case "input.image":
						return Result.match(Base64.decode(message.data), {
							onFailure: () =>
								fail("invalid_message", "The image data is not Base64."),
							onSuccess: (bytes) =>
								send(Live.Input.Image({ mediaType: message.mediaType, bytes })),
						})
					case "input.audio.commit":
						return send(Live.Input.Commit())
					case "input.audio.clear":
						return send(Live.Input.ClearAudio())
					case "response.cancel":
						return interruptRunning
					case "output.truncate":
						return send(
							Live.Input.Truncate({
								itemId: message.itemId,
								audioEndMs: message.audioEndMs,
							}),
						)
				}
			}

			/** Frames from the client: sound, or JSON messages. It ends when the client closes. */
			const fromClient = Effect.gen(function* () {
				while (true) {
					for (const frame of yield* reader.pull) {
						if (typeof frame !== "string") {
							yield* send(Live.Input.Audio({ bytes: frame }))
							continue
						}
						const message = decodeClient(frame)
						if (Option.isNone(message)) {
							yield* fail(
								"invalid_message",
								"OpenBot cannot read this message.",
							)
							continue
						}
						yield* onMessage(message.value)
					}
				}
			}).pipe(Effect.ignore({ log: "Debug" }))

			// The finalizers above end the running Turn and the hub.
			yield* Effect.raceAllFirst([fromClient, fromBackend, watch]).pipe(
				Effect.ensuring(
					writer
						.write(new Socket.CloseEvent(1000, "closed"))
						.pipe(Effect.ignore({ log: "Debug" })),
				),
			)
		}),
	)
