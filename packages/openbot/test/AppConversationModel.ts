import { Effect, Stream } from "effect"
import { LanguageModel, Response } from "effect/ai"

/** Deterministic model for HTTP conversation and App approval acceptance. */
export const make = async () => {
	const usage = {
		inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 1, text: 1, reasoning: 0 },
	}
	return await Effect.runPromise(
		LanguageModel.make({
			generateText: () =>
				Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
			streamText: ({ prompt, tools }) =>
				Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
					const index = prompt.content.findLastIndex(
						(message) => message.role === "user",
					)
					const text = JSON.stringify(prompt.content[index])
					const answered = prompt.content
						.slice(index + 1)
						.some((message) => message.role === "tool")
					const tool = tools.find((tool) =>
						text.includes("read document")
							? tool.description?.includes("/ read_document.") === true
							: tool.name === "openbot_app_access",
					)
					if (
						(text.includes("inspect access") ||
							text.includes("read document")) &&
						!answered &&
						tool !== undefined
					)
						return Stream.make(
							Response.makePart("tool-call", {
								id: "access-" + index,
								name: tool.name,
								params: text.includes("read document")
									? { id: "document-1" }
									: {},
								providerExecuted: false,
							}),
							Response.makePart("finish", { reason: "tool-calls", usage }),
						)
					return Stream.make(
						Response.makePart("text-start", { id: "answer" }),
					).pipe(
						Stream.concat(
							Stream.fromEffect(
								Effect.sleep("25 millis").pipe(
									Effect.as(
										Response.makePart("text-delta", {
											id: "answer",
											delta: "Deterministic reply 🌍",
										}),
									),
								),
							),
						),
						Stream.concat(
							Stream.make(
								Response.makePart("text-end", { id: "answer" }),
								Response.makePart("finish", { reason: "stop", usage }),
							),
						),
					)
				}),
		}),
	)
}
