import { Array as Arr, Effect, Layer, Match, Option, pipe } from "effect"
import { LanguageModel, Prompt, Response } from "effect/ai"

/** Token usage for a test response: one input token and one output token. */
export const usage = Response.Usage.make({
	inputTokens: {
		total: 1,
		uncached: 1,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: 1, reasoning: undefined },
})

/** A finish part with the given reason and `usage`. The reason is "stop" when you give none. */
export const finish = (reason: Response.FinishReason = "stop") =>
	Response.makePart("finish", { reason, usage })

/** The stream parts of one answer with only this text, and a "stop" finish part at the end. */
export const textParts = (text: string) => [
	Response.makePart("text-start", { id: "answer" }),
	Response.makePart("text-delta", { id: "answer", delta: text }),
	Response.makePart("text-end", { id: "answer" }),
	finish(),
]

/**
 * A Layer with a fake LanguageModel. It answers with the parts that
 * `streamText` and `generateText` give. Without `generateText`, it gives no parts.
 */
export const LanguageModelTest = ({
	streamText,
	generateText = () => Effect.succeed([]),
}: {
	readonly streamText: Parameters<typeof LanguageModel.make>[0]["streamText"]
	readonly generateText?: Parameters<
		typeof LanguageModel.make
	>[0]["generateText"]
}) =>
	Layer.effect(
		LanguageModel.LanguageModel,
		LanguageModel.make({ streamText, generateText }),
	)

/** The last text part of the user messages in the prompt, or "" when there is none. */
export const lastText = (prompt: Prompt.Prompt) =>
	pipe(
		prompt.content,
		Arr.flatMap((m) =>
			Match.value(m).pipe(
				Match.when({ role: "user" }, (m) =>
					pipe(
						m.content,
						Arr.filter((p) => p.type === "text"),
						Arr.map((p) => p.text),
					),
				),
				Match.orElse(() => []),
			),
		),
		Arr.last,
		Option.getOrElse(() => ""),
	)
