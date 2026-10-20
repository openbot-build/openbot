import { Match, Effect, HashMap, Schema } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import * as ContextCompaction from "./ContextCompaction.ts"
import * as ContextWindow from "./ContextWindow.ts"
import { PromptJson } from "../store/PromptCodec.ts"

/**
 * Finds related tool calls, results, and approval messages, so compaction
 * keeps each tool interaction together. Approval requests carry both keys.
 * This links the approval exchange to its tool call.
 */
const links = (message: Prompt.Message): ReadonlyArray<string> =>
	Match.value(message).pipe(
		Match.discriminator("role")("system", () => []),
		Match.orElse((message) =>
			message.content.flatMap((part) =>
				Match.value(part).pipe(
					Match.discriminator("type")("tool-call", "tool-result", (part) => [
						`call:${part.id}`,
					]),
					Match.discriminator("type")("tool-approval-request", (part) => [
						`call:${part.toolCallId}`,
						`approval:${part.approvalId}`,
					]),
					Match.discriminator("type")("tool-approval-response", (part) => [
						`approval:${part.approvalId}`,
					]),
					Match.orElse(() => []),
				),
			),
		),
	)

/** Summarizes older context with the given model and keeps recent messages unchanged. */
export const compact: ContextCompaction.NonNativeCompact = (input) =>
	Effect.gen(function* () {
		const systems = input.prompt.content.filter(
			(message) => message.role === "system",
		)
		const messages = input.prompt.content.filter(
			(message) => message.role !== "system",
		)
		// Earlier messages overwrite later positions, so each key keeps its first position.
		const firstMessageByInteraction = messages.reduceRight(
			(first, message, index) =>
				links(message).reduce(
					(first, key) => HashMap.set(first, key, index),
					first,
				),
			HashMap.empty<string, number>(),
		)
		// Move the kept tail back so it includes the start of every kept tool interaction.
		// The backward scan also follows links in messages that an earlier move added.
		const boundary = messages.reduceRight(
			(boundary, message, index) =>
				index < boundary
					? boundary
					: links(message).reduce(
							(boundary, key) =>
								Math.min(
									boundary,
									HashMap.getUnsafe(firstMessageByInteraction, key),
								),
							boundary,
						),
			Math.max(0, messages.length - (input.keepRecentMessages ?? 8)),
		)
		if (boundary === 0) return ContextWindow.fromPrompt(input.prompt)
		const source = Prompt.fromMessages(messages.slice(0, boundary))
		const encoded = yield* Schema.encodeEffect(PromptJson)(source).pipe(
			Effect.mapError(
				(error) =>
					new ContextCompaction.ContextCompactionError({
						reason: "request-failed",
						message: `Failed to encode the summary input: ${error.message}`,
					}),
			),
		)
		const response = yield* LanguageModel.generateText({
			prompt: Prompt.make([
				{
					role: "system",
					content: `Summarize the earlier conversation. It is given as JSON data. Keep the user's goal, constraints, decisions, important facts, tool results, and unfinished work. Include any existing conversation summary. Do not continue the task or call tools. Return only a short summary. Leave room for recent messages. The total context budget is ${input.targetTokens} tokens.`,
				},
				{ role: "user", content: JSON.stringify(encoded) },
			]),
			toolChoice: "none",
		}).pipe(
			Effect.mapError(
				(error) =>
					new ContextCompaction.ContextCompactionError({
						reason: "request-failed",
						message: `Failed to generate the summary: ${error.message}`,
					}),
			),
		)
		if (response.text.trim().length === 0 || response.finishReason === "length")
			return yield* new ContextCompaction.ContextCompactionError({
				reason: "request-failed",
				message: "The summary is empty, or the output token limit cut it short",
			})
		return ContextWindow.fromPrompt(
			Prompt.fromMessages([
				...systems,
				Prompt.userMessage({
					content: [
						Prompt.textPart({
							text: `Summary of earlier conversation:\n${response.text}`,
						}),
					],
				}),
				...messages.slice(boundary),
			]),
		)
	})
