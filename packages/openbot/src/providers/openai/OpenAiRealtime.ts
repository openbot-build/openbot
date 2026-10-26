import { Live } from "@openbot-build/core"
import {
	Array as Arr,
	Cause,
	Deferred,
	Effect,
	Exit,
	HashSet,
	Option,
	Queue,
	Redacted,
	Ref,
	Result,
	Schema,
	Stream,
	String as Str,
} from "effect"
import type { Prompt } from "effect/ai"
import { Base64 } from "effect/encoding"
import { Socket } from "effect/socket"
import * as Failures from "../../app/Failures.ts"
import type { LiveBackend } from "../../models/LiveBackends.ts"

/**
 * The Live backend for the OpenAI Realtime API. It speaks the Realtime events over a
 * WebSocket and maps them to and from the neutral Live types. Only this module knows
 * the Realtime protocol.
 */

const pcm: Live.AudioFormat = { encoding: "pcm16", sampleRate: 24000 }
const ulaw: Live.AudioFormat = { encoding: "g711_ulaw", sampleRate: 8000 }
const alaw: Live.AudioFormat = { encoding: "g711_alaw", sampleRate: 8000 }

export const capabilities: Live.Capabilities = {
	audio: { input: [pcm, ulaw, alaw], output: [pcm, ulaw, alaw] },
	turnDetection: ["server", "client"],
	inputTranscription: true,
	tools: true,
	interruption: true,
	truncate: true,
	inputs: {
		text: true,
		image: true,
		imageMediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
	},
	voices: [
		"marin",
		"cedar",
		"alloy",
		"ash",
		"ballad",
		"coral",
		"echo",
		"sage",
		"shimmer",
		"verse",
	],
}

/** The model that writes the text of what the person said. */
const transcriptionModel = "gpt-4o-mini-transcribe"

const formatOf = (format: Live.AudioFormat) =>
	format.encoding === "pcm16"
		? { type: "audio/pcm", rate: format.sampleRate }
		: format.encoding === "g711_ulaw"
			? { type: "audio/pcmu" }
			: { type: "audio/pcma" }

/** The `session` of a `session.update` event. */
export const sessionOf = (config: Live.Config) => ({
	type: "realtime",
	output_modalities: ["audio"],
	instructions: config.instructions,
	audio: {
		input: {
			format: formatOf(config.audio.input),
			transcription: { model: transcriptionModel },
			turn_detection:
				config.turnDetection === "server"
					? {
							type: "server_vad",
							// OpenBot starts each answer itself, in a Turn.
							create_response: false,
							interrupt_response: true,
						}
					: null,
		},
		output: {
			format: formatOf(config.audio.output),
			...(config.voice === undefined ? {} : { voice: config.voice }),
		},
	},
	tools: Arr.map(config.tools, (tool) => ({
		type: "function",
		name: tool.name,
		...(tool.description === undefined
			? {}
			: { description: tool.description }),
		parameters: tool.parameters,
	})),
	tool_choice: "auto",
	...config.providerOptions,
	// OpenBot owns the shared context. The provider must fail instead of dropping it.
	truncation: "disabled",
})

const userText = (text: string) => ({
	type: "conversation.item.create",
	item: {
		type: "message",
		role: "user",
		content: [{ type: "input_text", text }],
	},
})

export const contextItemId = (id: string, index: number) => `${id}_${index}`

const contextEvent = (item: Live.ContextItem, id: string) => ({
	type: "conversation.item.create",
	item:
		item.type === "call"
			? {
					id,
					type: "function_call",
					call_id: item.callId,
					name: item.name,
					arguments: item.arguments,
				}
			: item.type === "result"
				? {
						id,
						type: "function_call_output",
						call_id: item.callId,
						output: item.output,
					}
				: {
						id,
						type: "message",
						role: item.role,
						content: Arr.map(item.content, (part) =>
							part.type === "image"
								? {
										type: "input_image",
										image_url: `data:${part.mediaType};base64,${part.data}`,
									}
								: {
										type:
											item.role === "assistant" ? "output_text" : "input_text",
										text: part.text,
									},
						),
					},
})

/** The client events for one input. */
export const encodeInput = (
	input: Live.Input,
): ReadonlyArray<Record<string, unknown>> =>
	Live.Input.$match(input, {
		Audio: ({ bytes }) => [
			{
				type: "input_audio_buffer.append",
				audio: Base64.encode(bytes),
			},
		],
		Commit: () => [{ type: "input_audio_buffer.commit" }],
		ClearAudio: () => [{ type: "input_audio_buffer.clear" }],
		Text: ({ text }) => [userText(text)],
		Image: ({ mediaType, bytes }) => [
			{
				type: "conversation.item.create",
				item: {
					type: "message",
					role: "user",
					content: [
						{
							type: "input_image",
							image_url: `data:${mediaType};base64,${Base64.encode(bytes)}`,
						},
					],
				},
			},
		],
		Configure: ({ config }) => [
			{ type: "session.update", session: sessionOf(config) },
		],
		Respond: () => [{ type: "response.create" }],
		Cancel: () => [{ type: "response.cancel" }],
		Truncate: ({ itemId, audioEndMs }) => [
			{
				type: "conversation.item.truncate",
				item_id: itemId,
				content_index: 0,
				audio_end_ms: audioEndMs,
			},
		],
		ToolResult: ({ callId, output }) => [
			{
				type: "conversation.item.create",
				item: { type: "function_call_output", call_id: callId, output },
			},
		],
		History: ({ messages }) =>
			Arr.map(messages, (message) =>
				message.role === "user"
					? userText(message.text)
					: {
							type: "conversation.item.create",
							item: {
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: message.text }],
							},
						},
			),
		Context: ({ id, items }) =>
			Arr.map(items, (item, index) =>
				contextEvent(item, contextItemId(id, index)),
			),
	})

const Count = Schema.optional(Schema.Finite)
const UsageSchema = Schema.Struct({
	input_token_details: Schema.optional(
		Schema.Struct({
			text_tokens: Count,
			audio_tokens: Count,
			image_tokens: Count,
			cached_tokens: Count,
		}),
	),
	output_token_details: Schema.optional(
		Schema.Struct({ text_tokens: Count, audio_tokens: Count }),
	),
})

/** The server events that OpenBot reads. It skips every other event. */
const ServerEvent = Schema.Union([
	Schema.Struct({
		type: Schema.Literals(["session.created", "session.updated"]),
	}),
	Schema.Struct({
		type: Schema.Literals([
			"input_audio_buffer.speech_started",
			"input_audio_buffer.speech_stopped",
		]),
	}),
	Schema.Struct({
		type: Schema.Literal("input_audio_buffer.committed"),
		item_id: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("conversation.item.input_audio_transcription.delta"),
		item_id: Schema.String,
		delta: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal(
			"conversation.item.input_audio_transcription.completed",
		),
		item_id: Schema.String,
		transcript: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("conversation.item.input_audio_transcription.failed"),
		item_id: Schema.String,
	}),
	Schema.Struct({
		// The second name is the name of the beta API.
		type: Schema.Literals([
			"response.output_audio.delta",
			"response.audio.delta",
		]),
		item_id: Schema.String,
		delta: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literals([
			"response.output_audio_transcript.delta",
			"response.audio_transcript.delta",
			"response.output_text.delta",
			"response.text.delta",
		]),
		item_id: Schema.String,
		delta: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("response.output_item.done"),
		item: Schema.Struct({
			type: Schema.String,
			id: Schema.optional(Schema.String),
			call_id: Schema.optional(Schema.String),
			name: Schema.optional(Schema.String),
			arguments: Schema.optional(Schema.String),
		}),
	}),
	Schema.Struct({
		type: Schema.Literal("response.done"),
		response: Schema.Struct({
			status: Schema.String,
			usage: Schema.optional(Schema.NullOr(UsageSchema)),
		}),
	}),
	Schema.Struct({
		type: Schema.Literal("error"),
		error: Schema.Struct({
			message: Schema.optional(Schema.String),
			code: Schema.optional(Schema.NullOr(Schema.String)),
		}),
	}),
])
type ServerEvent = typeof ServerEvent.Type

/** Only the `type` of the server events that OpenBot reads. */
const KnownType = Schema.Union(
	Arr.map(ServerEvent.members, (member) =>
		Schema.Struct({ type: member.fields.type }),
	),
)
const isKnown = Schema.is(KnownType)

const parseJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Unknown),
)
const decodeServerEvent = Schema.decodeUnknownExit(ServerEvent)

const statusOf = (status: string): Live.ResponseStatus =>
	status === "completed" ||
	status === "cancelled" ||
	status === "incomplete" ||
	status === "failed"
		? status
		: "failed"

const usageOf = (usage: typeof UsageSchema.Type | null | undefined) => ({
	input: {
		text: usage?.input_token_details?.text_tokens ?? 0,
		audio: usage?.input_token_details?.audio_tokens ?? 0,
		image: usage?.input_token_details?.image_tokens ?? 0,
		cached: usage?.input_token_details?.cached_tokens ?? 0,
	},
	output: {
		text: usage?.output_token_details?.text_tokens ?? 0,
		audio: usage?.output_token_details?.audio_tokens ?? 0,
	},
})

/**
 * A server event of a known type that OpenBot cannot read, for example because the
 * protocol changed. The details go only to the log. The client gets a protocol
 * Failure, so a Turn does not wait for an event that is lost.
 */
const unreadable = (type: string, cause: Cause.Cause<unknown>) =>
	Effect.logWarning(
		"OpenAI Realtime sent an event that OpenBot cannot read",
		{ type },
		cause,
	).pipe(
		Effect.as([
			Live.Event.Failure({
				error: Live.LiveError.make({
					reason: "protocol",
					message: "OpenAI Realtime sent an event that OpenBot cannot read.",
				}),
			}),
		]),
	)

/**
 * The Live events for one server event. Text that is not JSON and events of other
 * types give none.
 */
export const decodeEvent = (
	text: string,
): Effect.Effect<ReadonlyArray<Live.Event>> => {
	const known = Option.filter(parseJson(text), isKnown)
	if (Option.isNone(known)) return Effect.succeed([])
	return Exit.match(decodeServerEvent(known.value), {
		onFailure: (cause) => unreadable(known.value.type, cause),
		onSuccess: eventsOf,
	})
}

const eventsOf = (
	event: ServerEvent,
): Effect.Effect<ReadonlyArray<Live.Event>> => {
	switch (event.type) {
		case "session.created":
			return Effect.succeed([Live.Event.Ready()])
		case "session.updated":
			return Effect.succeed([])
		case "input_audio_buffer.speech_started":
			return Effect.succeed([Live.Event.SpeechStarted()])
		case "input_audio_buffer.speech_stopped":
			return Effect.succeed([Live.Event.SpeechStopped()])
		case "input_audio_buffer.committed":
			return Effect.succeed([Live.Event.Committed({ itemId: event.item_id })])
		case "conversation.item.input_audio_transcription.delta":
			return Effect.succeed([
				Live.Event.InputTranscript({
					itemId: event.item_id,
					text: event.delta,
					final: false,
				}),
			])
		case "conversation.item.input_audio_transcription.completed":
			return Effect.succeed([
				Live.Event.InputTranscript({
					itemId: event.item_id,
					text: event.transcript,
					final: true,
				}),
			])
		case "conversation.item.input_audio_transcription.failed":
			// No text: the session tells the person and starts no Turn.
			return Effect.succeed([
				Live.Event.InputTranscript({
					itemId: event.item_id,
					text: "",
					final: true,
				}),
			])
		case "response.output_audio.delta":
		case "response.audio.delta":
			return Result.match(Base64.decode(event.delta), {
				onFailure: (error) => unreadable(event.type, Cause.fail(error)),
				onSuccess: (bytes) =>
					Effect.succeed([
						Live.Event.OutputAudio({ itemId: event.item_id, bytes }),
					]),
			})
		case "response.output_audio_transcript.delta":
		case "response.audio_transcript.delta":
		case "response.output_text.delta":
		case "response.text.delta":
			return Effect.succeed([
				Live.Event.OutputTranscript({
					itemId: event.item_id,
					delta: event.delta,
				}),
			])
		case "response.output_item.done": {
			const item = event.item
			if (item.type === "function_call")
				return Effect.succeed([
					Live.Event.ToolCall({
						callId: item.call_id ?? "",
						name: item.name ?? "",
						arguments: item.arguments ?? "{}",
					}),
				])
			return Effect.succeed(
				item.type === "message" && item.id !== undefined
					? [Live.Event.OutputDone({ itemId: item.id })]
					: [],
			)
		}
		case "response.done":
			return Effect.succeed([
				Live.Event.ResponseDone({
					status: statusOf(event.response.status),
					usage: usageOf(event.response.usage),
				}),
			])
		case "error":
			// Cancelling when no answer runs is not a real failure.
			if (event.error.code === "response_cancel_not_active")
				return Effect.succeed([])
			return Effect.succeed([
				Live.Event.Failure({
					error: Live.LiveError.make({
						reason: "provider",
						message: event.error.message ?? "OpenAI Realtime gave an error.",
					}),
				}),
			])
	}
}

/** The WebSocket address: `https` becomes `wss`, and `http` becomes `ws`. */
export const realtimeUrl = (endpoint: string | null, model: string) => {
	const base = Str.replace(/\/$/, "")(endpoint ?? "https://api.openai.com/v1")
	const url = new URL(base + "/realtime")
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:"
	url.searchParams.set("model", model)
	return url.toString()
}

const ContextAck = Schema.Union([
	Schema.Struct({ type: Schema.Literal("session.updated") }),
	// The current API ends with item.done; the older API used item.created.
	// item.added alone does not mean that the item is complete.
	Schema.Struct({
		type: Schema.Literals([
			"conversation.item.created",
			"conversation.item.done",
		]),
		item: Schema.Struct({ id: Schema.String }),
	}),
	Schema.Struct({
		type: Schema.Literal("error"),
		error: Schema.Struct({ message: Schema.optional(Schema.String) }),
	}),
])
const decodeContextAck = Schema.decodeUnknownOption(
	Schema.fromJsonString(ContextAck),
)

/** Keeps context loading separate from model answers and waits for storage at the provider. */
export const makeContextLoader = (
	write: (input: Live.Input) => Effect.Effect<void, Live.LiveError>,
	timeoutMs = 10000,
) =>
	Effect.gen(function* () {
		const configured = yield* Deferred.make<void, Live.LiveError>()
		const used = yield* Ref.make(false)
		const pending = yield* Ref.make(
			Option.none<{
				readonly remaining: HashSet.HashSet<string>
				readonly done: Deferred.Deferred<void, Live.LiveError>
			}>(),
		)
		const fail = (error: Live.LiveError) =>
			Effect.gen(function* () {
				yield* Deferred.fail(configured, error)
				const current = yield* Ref.get(pending)
				if (Option.isSome(current))
					yield* Deferred.fail(current.value.done, error)
			})
		const wait = (done: Deferred.Deferred<void, Live.LiveError>) =>
			Deferred.await(done).pipe(
				Effect.timeoutOrElse({
					duration: timeoutMs,
					orElse: () =>
						Effect.fail(
							Live.LiveError.make({
								reason: "protocol",
								message:
									"OpenAI Realtime did not accept the Chat context in time.",
							}),
						),
				}),
			)
		return {
			fail,
			accept: (text: string) =>
				Effect.gen(function* () {
					const ack = decodeContextAck(text)
					if (Option.isNone(ack)) return
					if (ack.value.type === "session.updated") {
						yield* Deferred.succeed(configured, undefined)
						return
					}
					if (ack.value.type === "error") {
						yield* fail(
							Live.LiveError.make({
								reason: "provider",
								message:
									ack.value.error.message ??
									"OpenAI Realtime could not load the Chat context.",
							}),
						)
						return
					}
					const itemId = ack.value.item.id
					const done = yield* Ref.modify(pending, (current) => {
						if (
							Option.isNone(current) ||
							!HashSet.has(current.value.remaining, itemId)
						)
							return [
								Option.none<Deferred.Deferred<void, Live.LiveError>>(),
								current,
							] as const
						const remaining = HashSet.remove(current.value.remaining, itemId)
						return [
							HashSet.size(remaining) === 0
								? Option.some(current.value.done)
								: Option.none<Deferred.Deferred<void, Live.LiveError>>(),
							Option.some({ ...current.value, remaining }),
						] as const
					})
					if (Option.isSome(done))
						yield* Deferred.succeed(done.value, undefined)
				}),
			load: (prompt: Prompt.Prompt) =>
				Effect.gen(function* () {
					const items = yield* Live.contextOf(prompt, capabilities)
					if (yield* Ref.getAndSet(used, true))
						return yield* Live.LiveError.make({
							reason: "protocol",
							message:
								"The Chat context was already loaded on this connection.",
						})
					yield* wait(configured)
					if (items.length === 0) return
					// One context is loaded once into a new connection, before any new input.
					const id = "openbot_context"
					const done = yield* Deferred.make<void, Live.LiveError>()
					yield* Ref.set(
						pending,
						Option.some({
							remaining: HashSet.fromIterable(
								Arr.map(items, (_, index) => contextItemId(id, index)),
							),
							done,
						}),
					)
					yield* write(Live.Input.Context({ id, items })).pipe(
						Effect.andThen(wait(done)),
						Effect.ensuring(Ref.set(pending, Option.none())),
					)
				}),
		}
	})

/** The backend for `openai` providers. It needs a WebSocket constructor that can send headers. */
export const backend = Effect.gen(function* () {
	const constructor = yield* Socket.WebSocketConstructor
	const value: LiveBackend = {
		kind: "openai",
		make: ({ provider, apiKey, upstreamModel, providerId, modelId }) =>
			Effect.succeed({
				provider: providerId,
				model: modelId,
				capabilities,
				connect: (config) =>
					Effect.gen(function* () {
						const socket = yield* Socket.makeWebSocket(
							realtimeUrl(provider.endpoint, upstreamModel),
							{
								headers: {
									authorization: `Bearer ${Redacted.value(apiKey)}`,
								},
							},
						).pipe(
							Effect.provideService(Socket.WebSocketConstructor, constructor),
						)
						const reader = yield* socket.reader.pipe(
							Failures.replace(
								"OpenBot cannot connect to OpenAI Realtime",
								() =>
									Live.LiveError.make({
										reason: "connect",
										message: "OpenBot cannot connect to OpenAI Realtime.",
									}),
							),
						)
						const writer = yield* socket.writer
						const events = yield* Queue.unbounded<Live.Event, Live.LiveError>()
						const context = yield* makeContextLoader((input) => write(input))
						const decoder = new TextDecoder()
						yield* reader.pull.pipe(
							Effect.flatMap((frames) =>
								Effect.forEach(frames, (frame) =>
									Effect.gen(function* () {
										const text =
											typeof frame === "string" ? frame : decoder.decode(frame)
										yield* context.accept(text)
										return yield* decodeEvent(text)
									}),
								),
							),
							Effect.flatMap((decoded) =>
								Queue.offerAll(events, Arr.flatten(decoded)),
							),
							Effect.forever,
							Effect.catch((error) =>
								Effect.logWarning(
									"OpenAI Realtime closed the connection",
									error,
								).pipe(
									Effect.andThen(
										context.fail(
											Live.LiveError.make({
												reason: "closed",
												message: "OpenAI Realtime closed the connection.",
											}),
										),
									),
									Effect.andThen(
										Queue.fail(
											events,
											Live.LiveError.make({
												reason: "closed",
												message: "OpenAI Realtime closed the connection.",
											}),
										),
									),
								),
							),
							Effect.forkScoped,
						)
						const write = (input: Live.Input) =>
							Effect.gen(function* () {
								yield* Live.check(capabilities, input)
								return yield* Effect.forEach(
									encodeInput(input),
									(event) => writer.write(JSON.stringify(event)),
									{ discard: true },
								).pipe(
									Failures.replace(
										"OpenBot cannot write to OpenAI Realtime",
										() =>
											Live.LiveError.make({
												reason: "closed",
												message: "OpenBot cannot write to OpenAI Realtime.",
											}),
									),
								)
							})
						yield* write(Live.Input.Configure({ config }))
						return {
							send: write,
							loadContext: context.load,
							events: Stream.fromQueue(events),
						} satisfies Live.Connection
					}),
			}),
	}
	return value
})
