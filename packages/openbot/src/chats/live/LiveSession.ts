import { Live as LiveProtocol } from "@openbot-build/domain"

import { Live, Config, LiveDriver, type Chat, Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Cause,
	Deferred,
	Effect,
	Option,
	PubSub,
	Ref,
	Result,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { Base64 } from "effect/encoding"
import { Socket } from "effect/socket"
import {
	Authorization,
	Execution,
	type ExecutionIdentity,
} from "@openbot-build/domain"
import { Crypto, FiberMap } from "effect"
import { Prompt, type LanguageModel } from "effect/ai"
import { ownerKey } from "../../apps/StoredConnections.ts"
import * as Check from "../../authorization/Check.ts"
import { Commands } from "../../execution/Commands.ts"
import * as Report from "../../errors/Report.ts"
import { InputCommands } from "../InputCommands.ts"
import * as ChatRecords from "../ChatRecords.ts"
import type { ResolvedLive } from "../../models/ModelRegistry.ts"
import { LiveConnections } from "./LiveConnections.ts"

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
	query: LiveProtocol.LiveQuery,
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
	Schema.fromJsonString(LiveProtocol.LiveServerMessage),
)
const decodeClient = Schema.decodeUnknownOption(
	Schema.fromJsonString(LiveProtocol.LiveClientMessage),
)

/** The connection owns sound and observation. The execution engine owns each Turn. */
export const make = Effect.gen(function* () {
	const sessions = yield* LiveConnections
	const inputs = yield* InputCommands
	const commands = yield* Commands
	const records = yield* ChatRecords.make
	const checks = yield* Check.make
	const save = yield* Report.make
	const saveFailure = (operation: string, cause: Cause.Cause<unknown>) =>
		Cause.hasInterruptsOnly(cause)
			? Effect.failCause(
					Cause.fromReasons<never>(
						Arr.filter(cause.reasons, Cause.isInterruptReason),
					),
				)
			: save(operation, cause)
	const crypto = yield* Crypto.Crypto
	const run = (input: {
		readonly socket: Socket.Socket
		readonly chat: Chat.Id
		readonly identity: ExecutionIdentity
		readonly selection: import("@openbot-build/core").Config.Selection
		readonly live: ResolvedLive
		readonly plan: Plan
	}) =>
		Effect.scoped(
			Effect.gen(function* () {
				const { chat, identity, live } = input
				const namespace = ownerKey(identity.owner)
				const chats = records(namespace)
				const capabilities = live.model.capabilities
				const connectionId = yield* crypto.randomUUIDv4()
				const key = Effect.map(crypto.randomUUIDv4(), Execution.CommandKey.make)
				const allowed = Effect.gen(function* () {
					const resource = Authorization.Chat.make({
						...identity.owner,
						ownerUserId: identity.owner.userId,
						id: chat,
					})
					yield* Check.execution(checks, identity, { action: "run", resource })
					yield* Check.execution(checks, identity, { action: "read", resource })
					yield* Check.model(checks, identity, input.selection)
				})
				yield* allowed
				// The reader does the handshake, and the writer waits for it, so the reader comes first.
				const reader = yield* input.socket.reader
				const writer = yield* input.socket.writer
				const say = (message: LiveProtocol.LiveServerMessage) =>
					encodeServer(message).pipe(
						// The server makes each message from the schema, so a message that does not encode is a bug.
						Effect.orDie,
						Effect.flatMap((text) =>
							writer.write(text).pipe(
								Effect.catchCause((cause) =>
									saveFailure("live.writeText", cause),
								),
								Effect.asVoid,
							),
						),
					)
				const fail = (code: LiveProtocol.LiveErrorCode, message: string) =>
					say({ type: "error", code, message })

				const report = (
					cause: Cause.Cause<unknown>,
					code: LiveProtocol.LiveErrorCode = "chat",
				) =>
					saveFailure("live.request", cause).pipe(
						Effect.flatMap((failure) =>
							say({
								type: "error",
								code,
								message: "The Live request could not finish.",
								failure,
							}),
						),
					)

				const reconnect = yield* Deferred.make<void>()
				const sameModel = Schema.toEquivalence(Config.Selection)
				const running = yield* Ref.make(Option.none<Execution.Id>())
				const watchers = yield* FiberMap.make<Execution.Id, void, never>()
				const follow = (executionId: Execution.Id) =>
					FiberMap.run(
						watchers,
						executionId,
						Effect.gen(function* () {
							const saved = yield* commands.get(executionId, identity.actor)
							if (saved.resource.kind !== "Turn")
								return yield* Execution.Conflict.make({ id: executionId })
							const turnId = Turn.Id.make(saved.resource.id)
							if (Execution.isTerminal(saved.status)) return
							yield* allowed
							const current = yield* chats.read(chat)
							const pendingModel =
								current.chat.turn?.id === turnId &&
								!Turn.isTerminal(current.chat.turn.status)
									? current.chat.turn.settings.model
									: undefined
							if (
								pendingModel !== undefined &&
								!sameModel(pendingModel, input.selection)
							) {
								yield* say({
									type: "session.reconnect",
									message:
										"The next Turn uses another model. Open a new Live connection.",
								})
								yield* Deferred.succeed(reconnect, undefined)
								return
							}
							yield* say({ type: "turn.started", executionId, turnId })
							if (!Execution.isTerminal(saved.status))
								yield* Ref.set(running, Option.some(executionId))
							yield* commands.observe(executionId, identity.actor, 0).pipe(
								Stream.runForEach((event) =>
									Effect.gen(function* () {
										yield* allowed
										if (
											event.body._tag === "State" &&
											Execution.isTerminal(event.body.status)
										) {
											yield* Ref.update(running, (value) =>
												Option.contains(executionId)(value)
													? Option.none()
													: value,
											)
											yield* say({
												type: "turn.completed",
												executionId,
												turnId,
												status:
													event.body.status === "completed"
														? "Completed"
														: event.body.status === "failed"
															? "Failed"
															: "Interrupted",
											})
											const current = yield* chats.read(chat)
											const nextModel =
												current.chat.turn !== undefined &&
												!Turn.isTerminal(current.chat.turn.status)
													? current.chat.turn.settings.model
													: current.chat.settings.model
											if (
												nextModel !== undefined &&
												!sameModel(nextModel, input.selection)
											) {
												yield* say({
													type: "session.reconnect",
													message:
														"The next Turn uses another model. Open a new Live connection.",
												})
												yield* Deferred.succeed(reconnect, undefined)
											}
										}
									}),
								),
							)
						}).pipe(Effect.catchCause((cause) => report(cause))),
						{ onlyIfMissing: true },
					).pipe(Effect.asVoid)
				const readyModel = yield* Deferred.make<LanguageModel.LanguageModel>()
				yield* sessions
					.use(
						{
							identity,
							chat,
							selection: input.selection,
							model: Deferred.await(readyModel),
							started: (execution) => follow(execution.id),
						},
						() =>
							Effect.gen(function* () {
								const base: LiveDriver.Options["base"] = {
									audio: input.plan.audio,
									turnDetection: input.plan.turnDetection,
									...(input.plan.voice === undefined
										? {}
										: { voice: input.plan.voice }),
								}
								yield* allowed
								const connected = yield* live.model
									.connect({ ...base, instructions: "", tools: [] })
									.pipe(Effect.result)
								if (Result.isFailure(connected)) {
									yield* report(
										Cause.fail(connected.failure),
										connected.failure.reason,
									)
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

								yield* Deferred.succeed(readyModel, driver.model)
								yield* say({
									type: "session.ready",
									provider: live.model.provider,
									model: live.model.model,
									capabilities,
									audio: input.plan.audio,
									turnDetection: input.plan.turnDetection,
									...(input.plan.voice === undefined
										? {}
										: { voice: input.plan.voice }),
								})
								const current = yield* chats.read(chat)
								const active = yield* chats.executionId(current.chat.turn?.id)
								if (active !== null) yield* follow(active)
								const interruptRunning = (commandKey?: Execution.CommandKey) =>
									Effect.gen(function* () {
										yield* allowed
										const execution = yield* Ref.get(running)
										if (Option.isNone(execution)) return
										const receipt = yield* commands.cancel(
											execution.value,
											identity.actor,
											commandKey ?? (yield* key),
										)
										yield* say({ type: "command.accepted", receipt })
										yield* say({ type: "output.stop" })
										if (capabilities.interruption)
											yield* connection.send(Live.Input.Cancel())
									}).pipe(Effect.catchCause((cause) => report(cause)))
								const deliver = (
									text: string,
									commandKey: Execution.CommandKey,
								) =>
									Effect.gen(function* () {
										yield* allowed
										const receipt = yield* inputs.message(
											namespace,
											commandKey,
											{
												chat,
												caller: identity.actor,
												content: Prompt.make(text),
												queue: false,
											},
										)
										yield* say({ type: "command.accepted", receipt })
										yield* follow(receipt.executionId)
									}).pipe(Effect.catchCause((cause) => report(cause)))

								const onEvent = (event: Live.Event) =>
									Live.Event.$match(event, {
										Ready: () => Effect.void,
										SpeechStarted: () =>
											say({ type: "input.speech.started" }).pipe(
												Effect.andThen(interruptRunning()),
											),
										SpeechStopped: () => say({ type: "input.speech.stopped" }),
										Committed: () => Effect.void,
										InputTranscript: ({ itemId, text, final }) =>
											Effect.gen(function* () {
												yield* say({
													type: "input.transcript",
													itemId,
													text,
													final,
												})
												if (!final) return
												if (Str.isEmpty(Str.trim(text)))
													return yield* fail(
														"provider",
														"OpenBot did not get the text of what you said.",
													)
												yield* driver.expect(text)
												yield* deliver(
													text,
													Execution.CommandKey.make(
														`live:${connectionId}:${itemId}`,
													),
												)
											}),
										OutputAudio: ({ bytes }) =>
											writer.write(bytes).pipe(
												Effect.catchCause((cause) =>
													saveFailure("live.writeAudio", cause),
												),
												Effect.asVoid,
											),
										OutputTranscript: ({ itemId, delta }) =>
											say({ type: "output.transcript.delta", itemId, delta }),
										OutputDone: ({ itemId }) =>
											say({ type: "output.done", itemId }),
										ToolCall: () => Effect.void,
										ResponseDone: () => Effect.void,
										Failure: ({ error }) =>
											report(Cause.fail(error), error.reason),
									})

								/** Events from the backend: to the driver, and to the client. */
								const fromBackend = connection.events.pipe(
									Stream.runForEach((event) =>
										allowed.pipe(
											Effect.andThen(PubSub.publish(events, event)),
											Effect.andThen(onEvent(event)),
										),
									),
									Effect.catchTag("LiveError", (error) =>
										PubSub.publish(events, Live.Event.Failure({ error })).pipe(
											Effect.andThen(report(Cause.fail(error), error.reason)),
										),
									),
								)

								const send = (value: Live.Input) =>
									allowed.pipe(
										Effect.andThen(connection.send(value)),
										Effect.catchCause((cause) => report(cause)),
									)

								const onMessage = (message: LiveProtocol.LiveClientMessage) => {
									switch (message.type) {
										case "input.text":
											// The driver sends the text to the backend when the Turn starts.
											return deliver(message.text, message.commandKey)
										case "input.image":
											if (!capabilities.inputs.image)
												return fail(
													"unsupported",
													"The Live model does not take images.",
												)
											return Result.match(Base64.decode(message.data), {
												onFailure: () =>
													fail(
														"invalid_message",
														"The image data is not Base64.",
													),
												onSuccess: (bytes) =>
													send(
														Live.Input.Image({
															mediaType: message.mediaType,
															bytes,
														}),
													),
											})
										case "input.audio.commit":
											return send(Live.Input.Commit())
										case "input.audio.clear":
											return send(Live.Input.ClearAudio())
										case "response.cancel":
											return interruptRunning(message.commandKey)
										case "output.truncate":
											if (!capabilities.truncate)
												return fail(
													"unsupported",
													"The Live model cannot cut the sound output.",
												)
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
								}).pipe(
									Effect.catchCause((cause) =>
										saveFailure("live.readClient", cause),
									),
									Effect.asVoid,
								)

								// Closing sound does not claim that an outside action stopped. The call log keeps its outcome.
								yield* Effect.raceAllFirst([
									fromClient,
									fromBackend,
									Deferred.await(reconnect),
								]).pipe(
									Effect.ensuring(
										writer.write(new Socket.CloseEvent(1000, "closed")).pipe(
											Effect.catchCause((cause) =>
												saveFailure("live.closeClient", cause),
											),
											Effect.asVoid,
										),
									),
								)
							}),
					)
					.pipe(
						Effect.catchTag("ResourceBusy", () =>
							fail("chat", "This live Chat already has an open Live session."),
						),
					)
			}),
		)
	return { run }
})
