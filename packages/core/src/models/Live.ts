import {
	Array as Arr,
	Data,
	Schema,
	SchemaTransformation,
	Effect,
	HashMap,
	HashSet,
	Option,
	Result,
	String as Str,
	type Scope,
	type Stream,
} from "effect"
import { Prompt, Response } from "effect/ai"
import { Base64 } from "effect/encoding"
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
	inputs: Schema.Struct({
		text: Schema.Boolean,
		image: Schema.Boolean,
		/** Exact supported MIME types. An absent list does not prove image support. */
		imageMediaTypes: Schema.optional(Schema.Array(Schema.String)),
	}),
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

/** Portable history. File bytes are loaded by the host before this is made. */
export type ContextItem =
	| {
			readonly type: "message"
			readonly role: "system" | "user" | "assistant"
			readonly content: ReadonlyArray<
				| { readonly type: "text"; readonly text: string }
				| {
						readonly type: "image"
						readonly mediaType: string
						readonly data: string
				  }
			>
	  }
	| {
			readonly type: "call"
			readonly callId: string
			readonly name: string
			readonly arguments: string
	  }
	| {
			readonly type: "result"
			readonly callId: string
			readonly output: string
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
	/** A complete, checked context. This input never asks the model to answer. */
	Context: { readonly id: string; readonly items: ReadonlyArray<ContextItem> }
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

export const LiveErrorReason = Schema.Literals([
	"unsupported",
	"connect",
	"protocol",
	"closed",
	"provider",
])
export type LiveErrorReason = typeof LiveErrorReason.Type

export class LiveError extends Schema.TaggedError<
	LiveError,
	{ readonly brand: unique symbol }
>()("LiveError", {
	reason: LiveErrorReason,
	message: Schema.String,
}) {}

/** One open connection to a backend. It ends when its Scope closes. */
export interface Connection {
	readonly send: (input: Input) => Effect.Effect<void, LiveError>
	/** Loads history and waits for the backend to accept every item. */
	readonly loadContext?: (
		prompt: Prompt.Prompt,
	) => Effect.Effect<void, LiveError>
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
export const check = (capabilities: Capabilities, input: Input) => {
	const supportsImage = (mediaType: string) =>
		capabilities.inputs.image &&
		Arr.contains(capabilities.inputs.imageMediaTypes ?? [], mediaType)
	const missing = Input.$match(input, {
		Audio: () => false,
		Commit: () => !Arr.contains(capabilities.turnDetection, "client"),
		ClearAudio: () => false,
		Text: () => !capabilities.inputs.text,
		Image: ({ mediaType }) => !supportsImage(mediaType),
		Configure: ({ config }) =>
			(config.tools.length > 0 && !capabilities.tools) ||
			!Arr.contains(capabilities.turnDetection, config.turnDetection) ||
			!Arr.some(capabilities.audio.input, (format) =>
				sameFormat(format, config.audio.input),
			) ||
			!Arr.some(capabilities.audio.output, (format) =>
				sameFormat(format, config.audio.output),
			),
		Respond: () => false,
		Cancel: () => !capabilities.interruption,
		Truncate: () => !capabilities.truncate,
		ToolResult: () => !capabilities.tools,
		History: () => false,
		Context: ({ items }) =>
			Arr.some(items, (item) =>
				item.type === "message"
					? Arr.some(item.content, (part) =>
							part.type === "image"
								? !supportsImage(part.mediaType)
								: !capabilities.inputs.text,
						)
					: !capabilities.tools,
			),
	})
	return missing
		? Effect.fail(
				LiveError.make({
					reason: "unsupported",
					message: `This Live model does not support the input ${input._tag}.`,
				}),
			)
		: Effect.void
}

const contextError = (message: string) =>
	LiveError.make({ reason: "unsupported", message })
const encodeContextJson = Schema.encodeEffect(
	Schema.fromJsonString(Schema.Unknown),
)
const contextJson = (value: unknown) =>
	encodeContextJson(value).pipe(
		Effect.catch((cause) =>
			Effect.logDebug(
				"A saved context value could not be encoded.",
				cause,
			).pipe(
				Effect.andThen(
					Effect.fail(
						contextError(
							"The Chat has a value that this Live model cannot read.",
						),
					),
				),
			),
		),
	)

/** File URLs must be read through the host file service before they reach a model. */
export const imageBytes = (
	part: Prompt.FilePart,
): Effect.Effect<Uint8Array, LiveError> => {
	if (!Str.startsWith("image/")(part.mediaType))
		return Effect.fail(
			contextError(
				`This Live model cannot read the file type ${part.mediaType}.`,
			),
		)
	if (part.data instanceof URL)
		return Effect.fail(contextError("A file in this Chat has not been loaded."))
	return typeof part.data === "string"
		? Result.match(Base64.decode(part.data), {
				onFailure: () =>
					Effect.fail(contextError("An image in this Chat has bad data.")),
				onSuccess: Effect.succeed,
			})
		: Effect.succeed(part.data)
}

/** Checks every visible part. Nothing is cut to fit a model or dropped as text. */
export const contextOf = (
	prompt: Prompt.Prompt,
	capabilities: Capabilities,
): Effect.Effect<ReadonlyArray<ContextItem>, LiveError> =>
	Effect.gen(function* () {
		let items: ReadonlyArray<ContextItem> = []
		let pending = HashSet.empty<string>()
		let used = HashSet.empty<string>()
		let ids = HashMap.empty<string, string>()
		let counts = HashMap.empty<string, number>()
		for (const message of prompt.content) {
			if (message.role === "system") {
				if (!capabilities.inputs.text)
					return yield* contextError(
						"This Live model cannot read the instructions in this Chat.",
					)
				items = [
					...items,
					{
						type: "message",
						role: "system",
						content: [{ type: "text", text: message.content }],
					},
				]
				continue
			}
			for (const part of message.content) {
				const partType: string = part.type
				if (part.type === "reasoning") continue
				if (part.type === "text") {
					if (!capabilities.inputs.text)
						return yield* contextError(
							"This Live model cannot read the text in this Chat.",
						)
					if (message.role === "tool")
						return yield* contextError(
							"The Chat has a tool text part that cannot be read.",
						)
					items = [
						...items,
						{
							type: "message",
							role: message.role,
							content: [{ type: "text", text: part.text }],
						},
					]
				} else if (part.type === "file") {
					if (
						message.role !== "user" ||
						!Str.startsWith("image/")(part.mediaType) ||
						!capabilities.inputs.image
					)
						return yield* contextError(
							`This Live model cannot read the file type ${part.mediaType} in this Chat.`,
						)
					const bytes = yield* imageBytes(part)
					items = [
						...items,
						{
							type: "message",
							role: "user",
							content: [
								{
									type: "image",
									mediaType: part.mediaType,
									data: Base64.encode(bytes),
								},
							],
						},
					]
				} else if (part.type === "tool-call") {
					if (!capabilities.tools)
						return yield* contextError(
							"This Live model cannot read the tool calls in this Chat.",
						)
					let count = Option.getOrElse(HashMap.get(counts, part.id), () => 0)
					let callId = count === 0 ? part.id : `${part.id}_${count}`
					while (HashSet.has(used, callId)) {
						count += 1
						callId = `${part.id}_${count}`
					}
					used = HashSet.add(used, callId)
					counts = HashMap.set(counts, part.id, count + 1)
					ids = HashMap.set(ids, part.id, callId)
					pending = HashSet.add(pending, callId)
					items = [
						...items,
						{
							type: "call",
							callId,
							name: part.name,
							arguments: yield* contextJson(part.params),
						},
					]
				} else if (part.type === "tool-result") {
					const callId = HashMap.get(ids, part.id)
					if (Option.isNone(callId) || !HashSet.has(pending, callId.value))
						return yield* contextError(
							"The Chat has a tool result without its call.",
						)
					pending = HashSet.remove(pending, callId.value)
					items = [
						...items,
						{
							type: "result",
							callId: callId.value,
							output: yield* contextJson(
								part.isFailure ? { error: part.result } : (part.result ?? null),
							),
						},
					]
				} else if (part.type === "tool-approval-request") {
					items = [
						...items,
						{
							type: "message",
							role: "assistant",
							content: [
								{
									type: "text",
									text: `[Recorded tool approval request: ${part.approvalId}, call ${part.toolCallId}.]`,
								},
							],
						},
					]
				} else if (part.type === "tool-approval-response") {
					items = [
						...items,
						{
							type: "message",
							role: "assistant",
							content: [
								{
									type: "text",
									text: `[Recorded tool approval: ${part.approvalId}, ${part.approved ? "allowed" : "denied"}.${part.reason === undefined ? "" : ` Reason: ${part.reason}`}]`,
								},
							],
						},
					]
				} else {
					return yield* contextError(
						`This Live model cannot read the Chat part ${partType}.`,
					)
				}
			}
		}
		if (HashSet.size(pending) > 0)
			return yield* contextError(
				"The Chat still has a tool call without its result.",
			)
		yield* check(capabilities, Input.Context({ id: "history", items }))
		return items
	})

export const validateContext = (
	prompt: Prompt.Prompt,
	capabilities: Capabilities,
): Effect.Effect<void, LiveError> =>
	contextOf(prompt, capabilities).pipe(Effect.asVoid)
