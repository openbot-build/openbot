import { Match, Effect, Layer } from "effect"
import { LanguageModel, Prompt, Response } from "effect/ai"
export const usage = Response.Usage.make({
	inputTokens: {
		total: 1,
		uncached: 1,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: 1, reasoning: undefined },
})
export const finish = (reason: Response.FinishReason = "stop") =>
	Response.makePart("finish", { reason, usage })
export const textParts = (text: string) => [
	Response.makePart("text-start", { id: "answer" }),
	Response.makePart("text-delta", { id: "answer", delta: text }),
	Response.makePart("text-end", { id: "answer" }),
	finish(),
]
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
export const lastText = (prompt: Prompt.Prompt) =>
	prompt.content
		.flatMap((m) =>
			Match.value(m).pipe(
				Match.when({ role: "user" }, (m) =>
					m.content.filter((p) => p.type === "text").map((p) => p.text),
				),
				Match.orElse(() => []),
			),
		)
		.at(-1) ?? ""
