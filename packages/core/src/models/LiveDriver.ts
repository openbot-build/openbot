import {
	Effect,
	HashMap,
	HashSet,
	Option,
	PubSub,
	Ref,
	Schema,
	Stream,
	type Scope,
} from "effect"
import {
	AiError,
	LanguageModel,
	Prompt,
	Response,
	Tool,
	type LanguageModel as LM,
} from "effect/ai"
import * as Live from "./Live.ts"

/**
 * A LanguageModel that answers through an open Live connection. The Chat runtime runs a
 * normal Turn with it, so Bot instructions, tools, approvals, Items and billing work the
 * same way as for text. It knows nothing about any one backend.
 */
export interface Driver {
	readonly model: LanguageModel.LanguageModel
	/**
	 * Tells the driver that the user text is already in the conversation of the
	 * connection, because the person said it. The driver then does not send it again.
	 */
	readonly expect: (text: string) => Effect.Effect<void>
}

export interface Options {
	readonly send: (input: Live.Input) => Effect.Effect<void, Live.LiveError>
	/** All events of the connection. The driver reads one answer at a time from it. */
	readonly events: PubSub.PubSub<Live.Event>
	/** The config without instructions and tools. The driver adds them from each request. */
	readonly base: Omit<Live.Config, "instructions" | "tools">
}

/** The system text of a prompt, in order. */
const instructionsOf = (prompt: Prompt.Prompt) =>
	prompt.content
		.flatMap((message) => (message.role === "system" ? [message.content] : []))
		.join("\n\n")

/** Tools that OpenBot runs. Tools that run inside a provider do not go to a Live model. */
const toolsOf = (tools: ReadonlyArray<Tool.Any>) =>
	tools.flatMap((tool): ReadonlyArray<Live.ToolDefinition> =>
		Tool.isProviderDefined(tool)
			? []
			: [
					{
						name: tool.name,
						...(tool.description === undefined
							? {}
							: { description: tool.description }),
						parameters: Tool.getJsonSchema(tool),
					},
				],
	)

/** The messages after the last assistant message: new input and tool results. */
const trailing = (prompt: Prompt.Prompt) => {
	const last = prompt.content.findLastIndex(
		(message) => message.role === "assistant",
	)
	return prompt.content.slice(last + 1)
}

const textOf = (message: Prompt.UserMessage) =>
	message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")

const outputOf = (part: Prompt.ToolResultPart) =>
	JSON.stringify(part.isFailure ? { error: part.result } : part.result) ??
	"null"

const decodeJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Json),
)

/** Text that is not JSON stays text. effect/ai checks the params against the tool schema and reports the error. */
const paramsOf = (text: string): unknown =>
	Option.getOrElse(decodeJson(text), () => text)

/** Joins the stream parts of one answer into whole parts, for `generateText`. */
const collect = (
	parts: Iterable<Response.StreamPartEncoded>,
): Array<Response.PartEncoded> => {
	const result: Array<Response.PartEncoded> = []
	let text = ""
	for (const part of parts) {
		if (part.type === "text-delta") text += part.delta
		if (part.type === "text-end" && text.length > 0) {
			result.push(Response.makePart("text", { text }))
			text = ""
		}
		if (part.type === "tool-call" || part.type === "finish") result.push(part)
	}
	return result
}

interface Answer {
	readonly started: HashSet.HashSet<string>
	readonly calls: boolean
}

export const make = (
	options: Options,
): Effect.Effect<Driver, never, Scope.Scope> =>
	Effect.gen(function* () {
		const configured = yield* Ref.make(Option.none<string>())
		const answered = yield* Ref.make(HashSet.empty<string>())
		const expected = yield* Ref.make(HashMap.empty<string, number>())

		/** Takes one expected text, if it is there. */
		const takeExpected = (text: string) =>
			Ref.modify(expected, (map) => {
				const count = Option.getOrElse(HashMap.get(map, text), () => 0)
				if (count === 0) return [false, map] as const
				return [
					true,
					count === 1
						? HashMap.remove(map, text)
						: HashMap.set(map, text, count - 1),
				] as const
			})

		const prepare = (request: LM.ProviderOptions) =>
			Effect.gen(function* () {
				const config: Live.Config = {
					...options.base,
					instructions: instructionsOf(request.prompt),
					tools: toolsOf(request.tools),
				}
				const key = JSON.stringify([config.instructions, config.tools])
				if (!Option.contains(yield* Ref.get(configured), key)) {
					yield* options.send(Live.Input.Configure({ config }))
					yield* Ref.set(configured, Option.some(key))
				}
				for (const message of trailing(request.prompt)) {
					if (message.role === "user") {
						const text = textOf(message)
						if (text.length > 0 && !(yield* takeExpected(text)))
							yield* options.send(Live.Input.Text({ text }))
					}
					if (message.role === "tool")
						for (const part of message.content) {
							if (part.type !== "tool-result") continue
							if (HashSet.has(yield* Ref.get(answered), part.id)) continue
							yield* options.send(
								Live.Input.ToolResult({
									callId: part.id,
									output: outputOf(part),
								}),
							)
							yield* Ref.update(answered, HashSet.add(part.id))
						}
				}
				yield* options.send(Live.Input.Respond())
			})

		const partsOf = (
			answer: Ref.Ref<Answer>,
			event: Live.Event,
		): Effect.Effect<
			ReadonlyArray<Response.StreamPartEncoded>,
			Live.LiveError
		> =>
			Live.Event.$match(event, {
				OutputTranscript: ({ itemId, delta }) =>
					Ref.modify(answer, (state) => {
						const delta_ = Response.makePart("text-delta", {
							id: itemId,
							delta,
						})
						return HashSet.has(state.started, itemId)
							? [[delta_], state]
							: [
									[Response.makePart("text-start", { id: itemId }), delta_],
									{ ...state, started: HashSet.add(state.started, itemId) },
								]
					}),
				OutputDone: ({ itemId }) =>
					Ref.modify(answer, (state) =>
						HashSet.has(state.started, itemId)
							? [
									[Response.makePart("text-end", { id: itemId })],
									{
										...state,
										started: HashSet.remove(state.started, itemId),
									},
								]
							: [[], state],
					),
				ToolCall: ({ callId, name, arguments: text }) =>
					Ref.update(answer, (state) => ({ ...state, calls: true })).pipe(
						Effect.as([
							Response.makePart("tool-call", {
								id: callId,
								name,
								params: paramsOf(text),
								providerExecuted: false,
							}),
						]),
					),
				ResponseDone: ({ status, usage }) =>
					Ref.get(answer).pipe(
						Effect.map((state) => [
							...Array.from(state.started, (id) =>
								Response.makePart("text-end", { id }),
							),
							Response.makePart("finish", {
								reason:
									status === "failed"
										? "error"
										: status === "incomplete"
											? "length"
											: status === "cancelled"
												? "other"
												: state.calls
													? "tool-calls"
													: "stop",
								usage: Live.toResponseUsage(usage),
							}),
						]),
					),
				Failure: ({ error }) => Effect.fail(error),
				Ready: () => Effect.succeed([]),
				SpeechStarted: () => Effect.succeed([]),
				SpeechStopped: () => Effect.succeed([]),
				Committed: () => Effect.succeed([]),
				InputTranscript: () => Effect.succeed([]),
				OutputAudio: () => Effect.succeed([]),
			})

		const streamText = (request: LM.ProviderOptions) =>
			Stream.unwrap(
				Effect.gen(function* () {
					// Subscribe first, so no event of this answer is lost.
					const subscription = yield* PubSub.subscribe(options.events)
					yield* prepare(request)
					const answer = yield* Ref.make<Answer>({
						started: HashSet.empty(),
						calls: false,
					})
					return Stream.fromSubscription(subscription).pipe(
						Stream.takeUntil((event) => event._tag === "ResponseDone"),
						Stream.mapEffect((event) => partsOf(answer, event)),
						Stream.flatMap(Stream.fromIterable),
					)
				}),
			).pipe(
				Stream.mapError((error) =>
					AiError.make({
						module: "LiveDriver",
						method: "streamText",
						reason:
							error.reason === "unsupported"
								? AiError.InvalidRequestError.make({
										description: error.message,
									})
								: AiError.InternalProviderError.make({
										description: error.message,
									}),
					}),
				),
			)

		const model = yield* LanguageModel.make({
			streamText,
			generateText: (request) =>
				streamText(request).pipe(Stream.runCollect, Effect.map(collect)),
		})
		return {
			model,
			expect: (text) =>
				Ref.update(expected, (map) =>
					HashMap.set(
						map,
						text,
						Option.getOrElse(HashMap.get(map, text), () => 0) + 1,
					),
				),
		}
	})
