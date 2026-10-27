import {
	Array as Arr,
	Match,
	Effect,
	HashMap,
	Schema,
	String as Str,
} from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import * as ContextCompaction from "./ContextCompaction.ts"
import * as ContextWindow from "./ContextWindow.ts"
import { PromptJson } from "../store/PromptCodec.ts"

const encodePromptJsonString = Schema.encodeEffect(
	Schema.fromJsonString(PromptJson),
)

/**
 * Finds related tool calls, results, and approval messages, so compaction
 * keeps each tool interaction together. Approval requests carry both keys.
 * This links the approval exchange to its tool call.
 */
const links = (message: Prompt.Message): ReadonlyArray<string> =>
	Match.value(message).pipe(
		Match.discriminator("role")("system", () => []),
		Match.orElse((message) =>
			Arr.flatMap(message.content, (part: Prompt.Part) =>
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
		const systems = Arr.filter(
			input.prompt.content,
			(message) => message.role === "system",
		)
		const messages = Arr.filter(
			input.prompt.content,
			(message) => message.role !== "system",
		)
		// Earlier messages overwrite later positions, so each key keeps its first position.
		const firstMessageByInteraction = Arr.reduceRight(
			messages,
			HashMap.empty<string, number>(),
			(first, message, index) =>
				Arr.reduce(links(message), first, (first, key) =>
					HashMap.set(first, key, index),
				),
		)
		// Move the kept tail back so it includes the start of every kept tool interaction.
		// The backward scan also follows links in messages that an earlier move added.
		const boundary = Arr.reduceRight(
			messages,
			Math.max(0, messages.length - (input.keepRecentMessages ?? 8)),
			(boundary, message, index) =>
				index < boundary
					? boundary
					: Arr.reduce(links(message), boundary, (boundary, key) =>
							Math.min(
								boundary,
								HashMap.getUnsafe(firstMessageByInteraction, key),
							),
						),
		)
		if (boundary === 0) return ContextWindow.fromPrompt(input.prompt)
		const source = Prompt.fromMessages(messages.slice(0, boundary))
		const encoded = yield* encodePromptJsonString(source).pipe(
			Effect.mapError((error) =>
				ContextCompaction.ContextCompactionError.make({
					reason: "request-failed",
					message: "The summary input does not encode",
					cause: error,
				}),
			),
		)
		const response = yield* LanguageModel.generateText({
			prompt: Prompt.make([
				{
					role: "system",
					content: `Summarize the earlier conversation. It is given as JSON data. Keep the user's goal, constraints, decisions, important facts, tool results, and unfinished work. Include any existing conversation summary. Do not continue the task or call tools. Return only a short summary. Leave room for recent messages. The total context budget is ${input.targetTokens} tokens.`,
				},
				{ role: "user", content: encoded },
			]),
			toolChoice: "none",
		}).pipe(
			Effect.mapError((error) =>
				ContextCompaction.ContextCompactionError.make({
					reason: "request-failed",
					message: "The model could not make the summary",
					cause: error,
				}),
			),
		)
		if (
			Str.isEmpty(Str.trim(response.text)) ||
			response.finishReason === "length"
		)
			return yield* ContextCompaction.ContextCompactionError.make({
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
