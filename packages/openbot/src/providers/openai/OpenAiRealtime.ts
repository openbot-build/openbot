import { Live } from "@openbot-build/core"
import { Effect, Option, Queue, Redacted, Result, Schema, Stream } from "effect"
import { Base64 } from "effect/encoding"
import { Socket } from "effect/socket"
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
	inputs: { text: true, image: true },
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
	tools: config.tools.map((tool) => ({
		type: "function",
		name: tool.name,
		...(tool.description === undefined
			? {}
			: { description: tool.description }),
		parameters: tool.parameters,
	})),
	tool_choice: "auto",
	...config.providerOptions,
})

const userText = (text: string) => ({
	type: "conversation.item.create",
	item: {
		type: "message",
		role: "user",
		content: [{ type: "input_text", text }],
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
			messages.map((message) =>
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

const decodeServerEvent = Schema.decodeUnknownOption(
	Schema.fromJsonString(ServerEvent),
)

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

/** The Live events for one server event. Unknown events give none. */
export const decodeEvent = (text: string): ReadonlyArray<Live.Event> =>
	Option.match(decodeServerEvent(text), {
		onNone: () => [],
		onSome: (event) => eventsOf(event),
	})

const eventsOf = (event: ServerEvent): ReadonlyArray<Live.Event> => {
	switch (event.type) {
		case "session.created":
			return [Live.Event.Ready()]
		case "session.updated":
			return []
		case "input_audio_buffer.speech_started":
			return [Live.Event.SpeechStarted()]
		case "input_audio_buffer.speech_stopped":
			return [Live.Event.SpeechStopped()]
		case "input_audio_buffer.committed":
			return [Live.Event.Committed({ itemId: event.item_id })]
		case "conversation.item.input_audio_transcription.delta":
			return [
				Live.Event.InputTranscript({
					itemId: event.item_id,
					text: event.delta,
					final: false,
				}),
			]
		case "conversation.item.input_audio_transcription.completed":
			return [
				Live.Event.InputTranscript({
					itemId: event.item_id,
					text: event.transcript,
					final: true,
				}),
			]
		case "conversation.item.input_audio_transcription.failed":
			// No text: the session tells the person and starts no Turn.
			return [
				Live.Event.InputTranscript({
					itemId: event.item_id,
					text: "",
					final: true,
				}),
			]
		case "response.output_audio.delta":
		case "response.audio.delta":
			return Result.match(Base64.decode(event.delta), {
				onFailure: () => [],
				onSuccess: (bytes) => [
					Live.Event.OutputAudio({ itemId: event.item_id, bytes }),
				],
			})
		case "response.output_audio_transcript.delta":
		case "response.audio_transcript.delta":
		case "response.output_text.delta":
		case "response.text.delta":
			return [
				Live.Event.OutputTranscript({
					itemId: event.item_id,
					delta: event.delta,
				}),
			]
		case "response.output_item.done": {
			const item = event.item
			if (item.type === "function_call")
				return [
					Live.Event.ToolCall({
						callId: item.call_id ?? "",
						name: item.name ?? "",
						arguments: item.arguments ?? "{}",
					}),
				]
			return item.type === "message" && item.id !== undefined
				? [Live.Event.OutputDone({ itemId: item.id })]
				: []
		}
		case "response.done":
			return [
				Live.Event.ResponseDone({
					status: statusOf(event.response.status),
					usage: usageOf(event.response.usage),
				}),
			]
		case "error":
			// Cancelling when no answer runs is not a real failure.
			if (event.error.code === "response_cancel_not_active") return []
			return [
				Live.Event.Failure({
					error: Live.LiveError.make({
						reason: "provider",
						message: event.error.message ?? "OpenAI Realtime gave an error.",
					}),
				}),
			]
	}
}

/** The WebSocket address: `https` becomes `wss`, and `http` becomes `ws`. */
export const realtimeUrl = (endpoint: string | null, model: string) => {
	const base = (endpoint ?? "https://api.openai.com/v1").replace(/\/$/, "")
	const url = new URL(base + "/realtime")
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:"
	url.searchParams.set("model", model)
	return url.toString()
}

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
							Effect.mapError(() =>
								Live.LiveError.make({
									reason: "connect",
									message: "OpenBot cannot connect to OpenAI Realtime.",
								}),
							),
						)
						const writer = yield* socket.writer
						const events = yield* Queue.unbounded<Live.Event, Live.LiveError>()
						const decoder = new TextDecoder()
						yield* reader.pull.pipe(
							Effect.flatMap((frames) =>
								Queue.offerAll(
									events,
									frames.flatMap((frame) =>
										decodeEvent(
											typeof frame === "string" ? frame : decoder.decode(frame),
										),
									),
								),
							),
							Effect.forever,
							Effect.catch(() =>
								Queue.fail(
									events,
									Live.LiveError.make({
										reason: "closed",
										message: "OpenAI Realtime closed the connection.",
									}),
								),
							),
							Effect.forkScoped,
						)
						const write = (input: Live.Input) => {
							const error = Live.unsupported(capabilities, input)
							if (error !== undefined) return Effect.fail(error)
							return Effect.forEach(
								encodeInput(input),
								(event) => writer.write(JSON.stringify(event)),
								{ discard: true },
							).pipe(
								Effect.mapError(() =>
									Live.LiveError.make({
										reason: "closed",
										message: "OpenBot cannot write to OpenAI Realtime.",
									}),
								),
							)
						}
						yield* write(Live.Input.Configure({ config }))
						return {
							send: write,
							events: Stream.fromQueue(events),
						} satisfies Live.Connection
					}),
			}),
	}
	return value
})
