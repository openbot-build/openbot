import { dual } from "effect/Function"
import { Context, Effect, Layer, Option } from "effect"
import { LanguageModel, Prompt, type Tool } from "effect/ai"
import * as ContextCompaction from "./ContextCompaction.ts"
import * as ContextWindow from "./ContextWindow.ts"
import * as ConversationContext from "./ConversationContext.ts"

export const make = <P, Tools extends Record<string, Tool.Any>, E, R>(
	input: ConversationContext.Options<P, Tools, E, R>,
): ConversationContext.RuntimeOperations<E, R> => ({
	load: (additional?: { readonly additional?: Prompt.RawInput }) =>
		Effect.gen(function* () {
			const view = yield* input.store.read(input.chat),
				compaction = yield* ContextCompaction.ContextCompaction
			const window =
				additional?.additional === undefined
					? view.state.conversation.context
					: ContextWindow.append(
							view.state.conversation.context,
							additional.additional,
						)
			if (view.chat.settings.model === undefined)
				return yield* ConversationContext.ConversationContextError.make({
					reason: "read-failed",
					message: "No model is selected for the current Chat",
				})
			const estimatedTokens = yield* compaction.count({
				...input.request,
				selection: view.chat.settings.model,
				window,
			})
			return new ConversationContext.State({
				chat: input.chat,
				prompt: window.prompt,
				window,
				estimatedTokens,
			})
		}),
	summarize: Effect.gen(function* () {
		const view = yield* input.store.read(input.chat)
		const prompt = view.state.conversation.context.prompt
		const response = yield* LanguageModel.generateText({
			prompt: Prompt.concat(
				prompt,
				"Summarize the conversation accurately. Keep its decisions, constraints, and unfinished work.",
			),
		})
		return new ConversationContext.Summary({
			text: response.text,
			sourceMessages: prompt.content.length,
		})
	}),
	compact: (request: { readonly targetTokens: number }) =>
		input.runtime
			.compact({
				chat: input.chat,
				request: input.request,
				targetTokens: request.targetTokens,
			})
			.pipe(
				Effect.map(
					(result) =>
						new ConversationContext.Compaction({
							summary: Option.none(),
							beforeTokens: result.beforeTokens,
							afterTokens: result.afterTokens,
							context: new ConversationContext.State({
								chat: input.chat,
								prompt: result.view.state.conversation.context.prompt,
								window: result.view.state.conversation.context,
								estimatedTokens: result.afterTokens,
							}),
						}),
				),
			),
})

export const layer: {
	<P, Tools extends Record<string, Tool.Any>, E, R>(
		input: ConversationContext.Options<P, Tools, E, R>,
	): <I>(
		tag: Context.Service<I, ConversationContext.RuntimeOperations<E, R>>,
	) => Layer.Layer<I>
	<I, P, Tools extends Record<string, Tool.Any>, E, R>(
		tag: Context.Service<I, ConversationContext.RuntimeOperations<E, R>>,
		input: ConversationContext.Options<P, Tools, E, R>,
	): Layer.Layer<I>
} = dual(
	2,
	<I, P, Tools extends Record<string, Tool.Any>, E, R>(
		tag: Context.Service<I, ConversationContext.RuntimeOperations<E, R>>,
		input: ConversationContext.Options<P, Tools, E, R>,
	) => Layer.succeed(tag, make(input)),
)
