import { Duration } from "effect"
import { LiveApi } from "@openbot-build/api"
import { Live, LiveDriver, type Chat, Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Crypto,
	Effect,
	Option,
	PubSub,
	Ref,
	Result,
	Schedule,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { Base64 } from "effect/encoding"
import { Socket } from "effect/socket"
import { Prompt } from "effect/ai"
import type * as Chats from "../Chats.ts"
import type { ResolvedLive } from "../../models/ModelRegistry.ts"
import * as Background from "../../app/Background.ts"
import * as Failures from "../../app/Failures.ts"
import { LiveSessions } from "./LiveSessions.ts"
import * as LiveLease from "./LiveLease.ts"

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

/** How long the watcher waits before it reads the Chat again for changes of other servers. */
const watchEvery = Duration.seconds(2)

export const run = (input: {
	readonly socket: Socket.Socket
	readonly chats: typeof Chats.Chats.Service
	readonly chat: Chat.Id
	readonly author: Turn.Author
	readonly live: ResolvedLive
	readonly plan: Plan
	readonly generation: number
	readonly prepareContext: (
		prompt: Prompt.Prompt,
	) => Effect.Effect<Prompt.Prompt, Live.LiveError>
	readonly storeImage: (
		mediaType: string,
		bytes: Uint8Array,
	) => Effect.Effect<Prompt.Prompt, Live.LiveError>
}) =>
	Effect.scoped(
		Effect.gen(function* () {
			const { chats, chat, author, live } = input
			const capabilities = live.model.capabilities
			const sessions = yield* LiveSessions
			const crypto = yield* Crypto.Crypto
			const owner: LiveLease.Owner = {
				chat,
				generation: input.generation,
				sessionId: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
			}
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
			const claimed = yield* LiveLease.claim(chats, owner).pipe(Effect.result)
			if (Result.isFailure(claimed)) {
				yield* fail(
					"chat",
					"The Chat already has a Live connection or changed execution.",
				)
				return
			}
			yield* Effect.addFinalizer(() =>
				LiveLease.release(chats, owner).pipe(
					Background.logFailure(
						"A Live connection could not release its lease.",
					),
				),
			)
			const guard = Effect.gen(function* () {
				while (true) {
					if (!(yield* LiveLease.valid(chats, owner)))
						return yield* Live.LiveError.make({
							reason: "closed",
							message: "The Chat changed execution.",
						})
					const view = yield* chats.get(chat)
					if (view.chat.execution.phase !== "switching") return
					yield* chats.wait(chat, view.chat.revision, Duration.millis(200))
				}
			}).pipe(
				Failures.replace(
					"A Live connection could not confirm its ownership.",
					() =>
						Live.LiveError.make({
							reason: "closed",
							message: "The Live connection no longer owns this Chat.",
						}),
				),
			)
			yield* Background.repeat(LiveLease.update(chats, owner), {
				schedule: Schedule.spaced(LiveLease.renewEveryMillis),
				message: "A Live connection could not renew its lease.",
			})

			const base: LiveDriver.Options["base"] = {
				audio: input.plan.audio,
				turnDetection: input.plan.turnDetection,
				...(input.plan.voice === undefined ? {} : { voice: input.plan.voice }),
			}
			const connected = yield* live.model
				.connect({ ...base, instructions: "", tools: [] })
				.pipe(
					Effect.timeoutOrElse({
						duration: "30 seconds",
						orElse: () =>
							Effect.fail(
								Live.LiveError.make({
									reason: "provider",
									message: "The Live model did not connect in time.",
								}),
							),
					}),
					Effect.result,
				)
			if (Result.isFailure(connected)) {
				yield* fail(connected.failure.reason, connected.failure.message)
				return
			}
			const connection = connected.success
			const ownedSend = (value: Live.Input) =>
				guard.pipe(Effect.andThen(connection.send(value)))
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
				send: ownedSend,
				events,
				base,
				capabilities,
			})
			const loaded = yield* Effect.gen(function* () {
				if (connection.loadContext === undefined)
					return yield* Live.LiveError.make({
						reason: "unsupported",
						message: "This Live backend cannot load shared context.",
					})
				const snapshot = yield* chats.executionContext(chat)
				const prompt = yield* input.prepareContext(snapshot.prompt)
				yield* Live.validateContext(prompt, capabilities)
				yield* guard
				yield* connection.loadContext(prompt)
				yield* driver.loaded(snapshot.prompt)
				yield* guard
			}).pipe(Effect.result)
			if (Result.isFailure(loaded)) {
				yield* fail(
					"chat",
					"OpenBot could not load the full context into this Live model.",
				)
				yield* Effect.logWarning(
					"A Live context could not load.",
					loaded.failure,
				)
				return
			}
			if (
				!(yield* sessions.register(chat, live.meter(driver.model), {
					generation: owner.generation,
					sessionId: owner.sessionId,
					check: LiveLease.valid(chats, owner).pipe(
						Effect.orElseSucceed(() => false),
					),
				}))
			) {
				yield* fail("chat", "This Chat already has an open Live session.")
				return
			}
			yield* LiveLease.update(chats, owner, { phase: "ready" })

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
			const lastOutput = yield* Ref.make(Option.none<string>())
			const audioPending = yield* Ref.make(false)
			const busy = (value: boolean) =>
				Effect.gen(function* () {
					yield* guard
					if ((yield* Ref.get(audioPending)) === value) return
					yield* LiveLease.update(chats, owner, { busy: value })
					yield* Ref.set(audioPending, value)
				})
			const recordPlayback = (itemId: string, audioEndMs?: number) =>
				Effect.gen(function* () {
					yield* guard
					if (!Option.contains(yield* Ref.get(lastOutput), itemId)) return
					const turn = yield* Ref.get(running)
					yield* chats.change(chat, (state) => {
						if (
							state.execution?.generation !== owner.generation ||
							state.execution.lease?.sessionId !== owner.sessionId
						)
							return state
						const previous = state.playback ?? []
						return {
							...state,
							playback: [
								...Arr.filter(previous, (item) => item.itemId !== itemId),
								{
									itemId,
									incomplete: true as const,
									...(Option.isSome(turn) ? { turnId: turn.value } : {}),
									...(audioEndMs === undefined ? {} : { audioEndMs }),
								},
							],
						}
					})
				})
			const interrupt = Effect.gen(function* () {
				if (!(yield* LiveLease.valid(chats, owner))) return
				const expected = yield* Ref.get(running)
				if (Option.isSome(expected))
					yield* chats.interruptExecution(
						chat,
						owner.generation,
						expected.value,
					)
			}).pipe(
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
				const last = yield* Ref.get(lastOutput)
				if (Option.isSome(last)) yield* recordPlayback(last.value)
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
			const deliver = (content: string | Prompt.Prompt, passive = false) =>
				guard.pipe(
					Effect.andThen(
						chats.deliver(chat, {
							input: content,
							author,
							expectedExecution: {
								generation: owner.generation,
								sessionId: owner.sessionId,
							},
							...(passive ? { passive: true } : {}),
						}),
					),
					Effect.tapError((error) =>
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
					yield* guard
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
						busy(true).pipe(
							Effect.andThen(say({ type: "input.speech.started" })),
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
							yield* busy(false)
						}),
					OutputAudio: ({ bytes }) =>
						writer.write(bytes).pipe(Effect.ignore({ log: "Debug" })),
					OutputTranscript: ({ itemId, delta }) =>
						Ref.set(lastOutput, Option.some(itemId)).pipe(
							Effect.andThen(
								say({ type: "output.transcript.delta", itemId, delta }),
							),
						),
					OutputDone: ({ itemId }) => say({ type: "output.done", itemId }),
					ToolCall: () => Effect.void,
					ResponseDone: () => Effect.void,
					Failure: ({ error }) => fail(error.reason, error.message),
				})

			/** Events from the backend: to the driver, and to the client. */
			const fromBackend = connection.events.pipe(
				Stream.runForEach((event) =>
					guard.pipe(
						Effect.andThen(PubSub.publish(events, event)),
						Effect.andThen(onEvent(event)),
					),
				),
				Effect.catch((error) => {
					const failure = Schema.is(Live.LiveError)(error)
						? error
						: Live.LiveError.make({
								reason: "closed",
								message: "The Live connection could not follow its Chat.",
							})
					return PubSub.publish(
						events,
						Live.Event.Failure({ error: failure }),
					).pipe(Effect.andThen(fail(failure.reason, failure.message)))
				}),
			)

			const send = (value: Live.Input) =>
				ownedSend(value).pipe(
					Effect.catch((error) => fail(error.reason, error.message)),
				)

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
								Effect.gen(function* () {
									yield* guard
									yield* Live.check(
										capabilities,
										Live.Input.Image({ mediaType: message.mediaType, bytes }),
									)
									const prompt = yield* input.storeImage(
										message.mediaType,
										bytes,
									)
									yield* deliver(prompt, true)
								}).pipe(
									Effect.catch((error) => fail("unsupported", error.message)),
								),
						})
					case "input.audio.commit":
						return send(Live.Input.Commit())
					case "input.audio.clear":
						return send(Live.Input.ClearAudio()).pipe(
							Effect.andThen(busy(false)),
						)
					case "response.cancel":
						return interruptRunning
					case "output.truncate":
						return Effect.gen(function* () {
							yield* guard
							if (!Option.contains(yield* Ref.get(lastOutput), message.itemId))
								return yield* fail(
									"unsupported",
									"Only the current spoken answer can be cut short.",
								)
							yield* recordPlayback(message.itemId, message.audioEndMs)
							yield* send(
								Live.Input.Truncate({
									itemId: message.itemId,
									audioEndMs: message.audioEndMs,
								}),
							)
						})
				}
			}

			/** Frames from the client: sound, or JSON messages. It ends when the client closes. */
			const fromClient = Effect.gen(function* () {
				while (true) {
					for (const frame of yield* reader.pull) {
						if (typeof frame !== "string") {
							yield* busy(true)
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
