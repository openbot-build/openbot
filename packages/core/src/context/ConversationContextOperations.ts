import { dual } from "effect/Function"
import { Context, Effect, Layer, Option } from "effect"
import { LanguageModel, Prompt, type Tool } from "effect/ai"
import * as ContextCompaction from "./ContextCompaction.ts"
import * as ContextWindow from "./ContextWindow.ts"
import * as ConversationContext from "./ConversationContext.ts"
import { fullHistory } from "../timeline/TimelineState.ts"

export const make = <P, Tools extends Record<string, Tool.Any>, E, R>(
	input: ConversationContext.Options<P, Tools, E, R>,
): ConversationContext.RuntimeOperations<E, R> => ({
	load: (additional?: { readonly additional?: Prompt.RawInput }) =>
		Effect.gen(function* () {
			const view = yield* input.store.read(input.session),
				compaction = yield* ContextCompaction.ContextCompaction
			const window =
				additional?.additional === undefined
					? view.state.value.conversation.context
					: ContextWindow.append(
							view.state.value.conversation.context,
							additional.additional,
						)
			if (view.session.settings.model === undefined)
				return yield* new ConversationContext.ConversationContextError({
					reason: "read-failed",
					message: "No model is selected for the current session",
				})
			const estimatedTokens = yield* compaction.count({
				...input.request,
				selection: view.session.settings.model,
				window,
			})
			return new ConversationContext.State({
				session: input.session,
				prompt: window.prompt,
				window,
				estimatedTokens,
			})
		}),
	summarize: Effect.gen(function* () {
		const view = yield* input.store.read(input.session)
		const response = yield* LanguageModel.generateText({
			prompt: Prompt.concat(
				fullHistory(view.state.value),
				"Summarize the conversation accurately. Keep its decisions, constraints, and unfinished work.",
			),
		})
		return new ConversationContext.Summary({
			text: response.text,
			sourceMessages: view.state.value.conversation.history.length,
		})
	}),
	compact: (request: { readonly targetTokens: number }) =>
		input.runtime
			.compact({
				session: input.session,
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
								session: input.session,
								prompt: result.view.state.value.conversation.context.prompt,
								window: result.view.state.value.conversation.context,
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
