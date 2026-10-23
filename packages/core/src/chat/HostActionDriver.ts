import { Effect, Match, Stream } from "effect"
import { LanguageModel, Prompt, Response } from "effect/ai"
import type { Action } from "./Turn.ts"

/** Feed the exact host selection into native tool validation and approval without asking the model. */
export const make = (input: {
	readonly action: Action
	readonly callId: string
}) => {
	const parts = (prompt: Prompt.Prompt) => {
		const selected = prompt.content.some((message) =>
			Match.value(message).pipe(
				Match.when({ role: "assistant" }, (message) =>
					message.content.some(
						(part) => part.type === "tool-call" && part.id === input.callId,
					),
				),
				Match.orElse(() => false),
			),
		)
		const finish = Response.makePart("finish", {
			reason: selected ? "stop" : "tool-calls",
			usage: {
				inputTokens: { total: 0, uncached: 0, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 0, text: 0, reasoning: 0 },
			},
		})
		return selected
			? [finish]
			: [
					Response.makePart("tool-call", {
						id: input.callId,
						name: input.action.name,
						params: input.action.arguments,
						providerExecuted: false,
					}),
					finish,
				]
	}
	return LanguageModel.make({
		generateText: ({ prompt }) => Effect.sync(() => parts(prompt)),
		streamText: ({ prompt }) => Stream.fromIterable(parts(prompt)),
	})
}
