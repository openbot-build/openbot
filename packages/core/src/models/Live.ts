import {
	Data,
	Schema,
	SchemaTransformation,
	type Effect,
	type Scope,
	type Stream,
} from "effect"
import { Response } from "effect/ai"
import type * as ModelRuntime from "./Model.ts"
import type * as ProviderRuntime from "./Provider.ts"

/**
 * A Live model talks with a person in real time. Sound goes in and comes out while the
 * person talks. A Live backend, such as OpenAI Realtime, makes a LiveModel. The rest of
 * OpenBot uses only the types in this module, so a new backend needs no other change.
 */

/** How sound is coded. `pcm16` is 16-bit signed little-endian PCM with one channel. */
export const AudioEncoding = Schema.Literals([
	"pcm16",
	"g711_ulaw",
	"g711_alaw",
	"opus",
])
export type AudioEncoding = typeof AudioEncoding.Type

export const AudioFormat = Schema.Struct({
	encoding: AudioEncoding,
	sampleRate: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type AudioFormat = typeof AudioFormat.Type

/**
 * The text form of a format, such as `pcm16@24000`. It decodes the text to an
 * `AudioFormat` and encodes an `AudioFormat` back to the text.
 */
export const AudioFormatFromString = Schema.TemplateLiteralParser([
	AudioEncoding,
	"@",
	Schema.Int,
]).pipe(
	Schema.decodeTo(
		AudioFormat,
		SchemaTransformation.transform({
			decode: ([encoding, , sampleRate]) => ({ encoding, sampleRate }),
			encode: ({ encoding, sampleRate }) =>
				[encoding, "@", sampleRate] as const,
		}),
	),
)

export const sameFormat = (a: AudioFormat, b: AudioFormat) =>
	a.encoding === b.encoding && a.sampleRate === b.sampleRate

/**
 * What a backend can do. The session reads this data and never sends an input that the
 * backend does not support.
 */
export const Capabilities = Schema.Struct({
	audio: Schema.Struct({
		input: Schema.Array(AudioFormat),
		output: Schema.Array(AudioFormat),
	}),
	/**
	 * Who decides when the person stops talking. With `server`, the backend hears it.
	 * With `client`, the client sends a commit message, as in push-to-talk.
	 */
	turnDetection: Schema.Array(Schema.Literals(["server", "client"])),
	/** The backend gives the text of what the person said. */
	inputTranscription: Schema.Boolean,
	tools: Schema.Boolean,
	/** The backend can stop an answer that is still running. */
	interruption: Schema.Boolean,
	/** The backend can forget the part of an answer that the person did not hear. */
	truncate: Schema.Boolean,
	inputs: Schema.Struct({ text: Schema.Boolean, image: Schema.Boolean }),
	voices: Schema.Array(Schema.String),
})
export type Capabilities = typeof Capabilities.Type

export type TurnDetection = Capabilities["turnDetection"][number]

/** A tool the model may call. `parameters` is a JSON Schema. */
export interface ToolDefinition {
	readonly name: string
	readonly description?: string
	readonly parameters: unknown
}

export interface Config {
	readonly instructions: string
	readonly tools: ReadonlyArray<ToolDefinition>
	readonly voice?: string
	readonly audio: { readonly input: AudioFormat; readonly output: AudioFormat }
	readonly turnDetection: TurnDetection
	/** Settings that only one backend knows. Other backends do not read them. */
	readonly providerOptions?: Readonly<Record<string, unknown>>
}

/** A message from the history of a Chat. Only text goes to a Live model. */
export interface HistoryMessage {
	readonly role: "user" | "assistant"
	readonly text: string
}

export type Input = Data.TaggedEnum<{
	/** A part of the sound of the person, in the input format of the config. */
	Audio: { readonly bytes: Uint8Array }
	/** The person stopped talking. Only for client turn detection. */
	Commit: {}
	/** Forget the sound that is not committed. */
	ClearAudio: {}
	Text: { readonly text: string }
	Image: { readonly mediaType: string; readonly bytes: Uint8Array }
	Configure: { readonly config: Config }
	/** Make an answer now. */
	Respond: {}
	/** Stop the running answer. */
	Cancel: {}
	/** The person heard the answer `itemId` only up to `audioEndMs`. */
	Truncate: { readonly itemId: string; readonly audioEndMs: number }
	ToolResult: { readonly callId: string; readonly output: string }
	/** Messages from before this connection, given once after connecting. */
	History: { readonly messages: ReadonlyArray<HistoryMessage> }
}>
export const Input = Data.taggedEnum<Input>()

/** Token counts of one answer. Sound and text are counted apart. */
export interface Usage {
	readonly input: {
		readonly text: number
		readonly audio: number
		readonly image: number
		readonly cached: number
	}
	readonly output: { readonly text: number; readonly audio: number }
}

export const emptyUsage: Usage = {
	input: { text: 0, audio: 0, image: 0, cached: 0 },
	output: { text: 0, audio: 0 },
}

/**
 * The usage in the form that effect/ai and billing read today. Sound tokens go into the
 * totals. A later change can give sound its own price from the counts in `Usage`.
 */
export const toResponseUsage = (usage: Usage) => {
	const input =
		usage.input.text +
		usage.input.audio +
		usage.input.image +
		usage.input.cached
	const output = usage.output.text + usage.output.audio
	return Response.Usage.make({
		inputTokens: {
			total: input,
			uncached: input - usage.input.cached,
			cacheRead: usage.input.cached,
			cacheWrite: undefined,
		},
		outputTokens: { total: output, text: output, reasoning: undefined },
	})
}

export type ResponseStatus = "completed" | "cancelled" | "incomplete" | "failed"

export type Event = Data.TaggedEnum<{
	/** The connection is open and the config is in use. */
	Ready: {}
	SpeechStarted: {}
	SpeechStopped: {}
	/** The sound of the person became the input item `itemId`. */
	Committed: { readonly itemId: string }
	/** Text of what the person said. `final` is true for the last, full text. */
	InputTranscript: {
		readonly itemId: string
		readonly text: string
		readonly final: boolean
	}
	/** A part of the answer sound, in the output format of the config. */
	OutputAudio: { readonly itemId: string; readonly bytes: Uint8Array }
	/** A part of the text of the answer. */
	OutputTranscript: { readonly itemId: string; readonly delta: string }
	/** The answer item `itemId` has no more sound or text. */
	OutputDone: { readonly itemId: string }
	ToolCall: {
		readonly callId: string
		readonly name: string
		readonly arguments: string
	}
	ResponseDone: { readonly status: ResponseStatus; readonly usage: Usage }
	Failure: { readonly error: LiveError }
}>
export const Event = Data.taggedEnum<Event>()

export type LiveErrorReason =
	"unsupported" | "connect" | "protocol" | "closed" | "provider"

export class LiveError extends Schema.TaggedError<LiveError>()("LiveError", {
	reason: Schema.Literals([
		"unsupported",
		"connect",
		"protocol",
		"closed",
		"provider",
	]),
	message: Schema.String,
}) {}

/** One open connection to a backend. It ends when its Scope closes. */
export interface Connection {
	readonly send: (input: Input) => Effect.Effect<void, LiveError>
	/** Every event of the connection. Read it from one place only. */
	readonly events: Stream.Stream<Event, LiveError>
}

export interface LiveModel {
	readonly provider: ProviderRuntime.Id
	readonly model: ModelRuntime.Id
	readonly capabilities: Capabilities
	readonly connect: (
		config: Config,
	) => Effect.Effect<Connection, LiveError, Scope.Scope>
}

/** Fails when the capabilities do not allow the input. Backends call it in `send`. */
export const unsupported = (capabilities: Capabilities, input: Input) => {
	const missing = Input.$match(input, {
		Audio: () => false,
		Commit: () => !capabilities.turnDetection.includes("client"),
		ClearAudio: () => false,
		Text: () => !capabilities.inputs.text,
		Image: () => !capabilities.inputs.image,
		Configure: ({ config }) =>
			(config.tools.length > 0 && !capabilities.tools) ||
			!capabilities.turnDetection.includes(config.turnDetection) ||
			!capabilities.audio.input.some((format) =>
				sameFormat(format, config.audio.input),
			) ||
			!capabilities.audio.output.some((format) =>
				sameFormat(format, config.audio.output),
			),
		Respond: () => false,
		Cancel: () => !capabilities.interruption,
		Truncate: () => !capabilities.truncate,
		ToolResult: () => !capabilities.tools,
		History: () => false,
	})
	return missing
		? LiveError.make({
				reason: "unsupported",
				message: `This Live model does not support the input ${input._tag}.`,
			})
		: undefined
}
