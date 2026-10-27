import { Live } from "@openbot-build/core"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Option,
	Queue,
	Redacted,
	Result,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { Base64 } from "effect/encoding"
import { Socket } from "effect/socket"
import * as Failures from "../../errors/Failures.ts"
import * as Report from "../../errors/Report.ts"
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
			// History is sent once. Insert it before sound that may already be in this connection.
			Arr.map(messages, (message, index) => ({
				type: "conversation.item.create",
				previous_item_id: index === 0 ? "root" : `openbot_history_${index - 1}`,
				item: {
					id: `openbot_history_${index}`,
					...("callId" in message
						? message.role === "tool"
							? {
									type: "function_call_output",
									call_id: message.callId,
									output: message.output,
								}
							: {
									type: "function_call",
									call_id: message.callId,
									name: message.name,
									arguments: message.arguments,
								}
						: {
								type: "message",
								role: message.role,
								content: [
									{
										type:
											message.role === "user" ? "input_text" : "output_text",
										text: message.text,
									},
								],
							}),
				},
			})),
	})

const Count = Schema.optional(
	Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
)
const UsageSchema = Schema.Struct({
	input_tokens: Count,
	output_tokens: Count,
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
		total: usage?.input_tokens,
		text: usage?.input_token_details?.text_tokens,
		audio: usage?.input_token_details?.audio_tokens,
		image: usage?.input_token_details?.image_tokens,
		cached: usage?.input_token_details?.cached_tokens,
	},
	output: {
		total: usage?.output_tokens,
		text: usage?.output_token_details?.text_tokens,
		audio: usage?.output_token_details?.audio_tokens,
	},
})

/** Save the full cause and keep its safe reference with the Live error. */
const failure = (
	report: Report.Report,
	operation: string,
	cause: Cause.Cause<unknown>,
	reason: Live.LiveErrorReason,
	message: string,
) =>
	Cause.hasInterruptsOnly(cause)
		? Effect.failCause(
				Cause.fromReasons<never>(
					Arr.filter(cause.reasons, Cause.isInterruptReason),
				),
			)
		: report(operation, cause).pipe(
				Effect.flatMap((saved) =>
					Effect.fail(saved).pipe(
						Failures.replace(operation, () =>
							Live.LiveError.make({ reason, message }),
						),
						Effect.flip,
					),
				),
			)

/** A known event must give an error when its data cannot be read. */
const unreadable = (report: Report.Report, cause: Cause.Cause<unknown>) =>
	failure(
		report,
		"realtime.decode",
		cause,
		"protocol",
		"OpenAI Realtime sent an event that OpenBot cannot read.",
	).pipe(Effect.map((error) => [Live.Event.Failure({ error })]))

/**
 * The Live events for one server event. Text that is not JSON and events of other
 * types give none.
 */
export const decodeEvent = (
	text: string,
	report: Report.Report,
): Effect.Effect<ReadonlyArray<Live.Event>> => {
	const known = Option.filter(parseJson(text), isKnown)
	if (Option.isNone(known)) return Effect.succeed([])
	return Exit.match(decodeServerEvent(known.value), {
		onFailure: (cause) => unreadable(report, cause),
		onSuccess: (event) => eventsOf(event, report),
	})
}

const eventsOf = (
	event: ServerEvent,
	report: Report.Report,
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
				onFailure: (error) => unreadable(report, Cause.fail(error)),
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
			return failure(
				report,
				"realtime.provider",
				Cause.fail(event.error),
				"provider",
				"OpenAI Realtime gave an error.",
			).pipe(Effect.map((error) => [Live.Event.Failure({ error })]))
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

/** The backend for `openai` providers. It needs a WebSocket constructor that can send headers. */
export const backend = Effect.gen(function* () {
	const constructor = yield* Socket.WebSocketConstructor
	const report = yield* Report.make
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
							Effect.catchCause((cause) =>
								failure(
									report,
									"realtime.connect",
									cause,
									"connect",
									"OpenBot cannot connect to OpenAI Realtime.",
								).pipe(Effect.flatMap(Effect.fail)),
							),
						)
						const writer = yield* socket.writer
						const events = yield* Queue.unbounded<Live.Event, Live.LiveError>()
						const decoder = new TextDecoder()
						yield* reader.pull.pipe(
							Effect.flatMap((frames) =>
								Effect.forEach(frames, (frame) =>
									decodeEvent(
										typeof frame === "string" ? frame : decoder.decode(frame),
										report,
									),
								),
							),
							Effect.flatMap((decoded) =>
								Queue.offerAll(events, Arr.flatten(decoded)),
							),
							Effect.forever,
							Effect.catchCause((cause) =>
								failure(
									report,
									"realtime.read",
									cause,
									"closed",
									"OpenAI Realtime closed the connection.",
								).pipe(Effect.flatMap((error) => Queue.fail(events, error))),
							),
							// A recorder defect must also end the queue and keep its sealed causes.
							Effect.onExit((exit) =>
								Exit.isFailure(exit)
									? Queue.failCause(events, exit.cause)
									: Effect.void,
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
									Effect.catchCause((cause) =>
										failure(
											report,
											"realtime.write",
											cause,
											"closed",
											"OpenBot cannot write to OpenAI Realtime.",
										).pipe(Effect.flatMap(Effect.fail)),
									),
								)
							})
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
