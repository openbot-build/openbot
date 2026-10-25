import type * as Chat from "../chat/Chat.ts"
import { Context, Data, type Effect, type Option, Schema } from "effect"
import type * as ContextWindow from "./ContextWindow.ts"
import {
	type AiError,
	type Prompt,
	type Tool,
	type LanguageModel,
} from "effect/ai"
import type * as ChatStore from "../store/ChatStore.ts"
import type * as ContextCompaction from "./ContextCompaction.ts"

export class State extends Data.TaggedClass("ConversationContext.State")<{
	readonly chat: Chat.Id
	readonly prompt: Prompt.Prompt
	readonly window: ContextWindow.Window
	readonly estimatedTokens: number
}> {}

export class Summary extends Data.TaggedClass("ConversationContext.Summary")<{
	readonly text: string
	readonly sourceMessages: number
}> {}

export class Compaction extends Data.TaggedClass(
	"ConversationContext.Compaction",
)<{
	readonly summary: Option.Option<Summary>
	readonly context: State
	readonly beforeTokens: number
	readonly afterTokens: number
}> {}

export class ConversationContextError extends Schema.TaggedError<ConversationContextError>()(
	"ConversationContextError",
	{
		reason: Schema.Literals([
			"chat-not-found",
			"read-failed",
			"summary-failed",
			"invalid-target",
			"unsupported",
			"input-too-large",
			"target-not-reached",
			"request-failed",
			"head-conflict",
		]),
		message: Schema.String,
	},
) {}

export interface Operations<
	LoadError = ConversationContextError,
	LoadServices = never,
	SummaryError = ConversationContextError,
	SummaryServices = never,
	CompactError = ConversationContextError,
	CompactServices = never,
> {
	readonly load: (input?: {
		readonly additional?: Prompt.RawInput
	}) => Effect.Effect<State, LoadError, LoadServices>
	readonly summarize: Effect.Effect<Summary, SummaryError, SummaryServices>
	readonly compact: (input: {
		readonly targetTokens: number
	}) => Effect.Effect<Compaction, CompactError, CompactServices>
}

export interface Options<P, Tools extends Record<string, Tool.Any>, E, R> {
	readonly runtime: Pick<Chat.Runtime<P, Tools, E, R>, "compact">
	readonly store: Pick<ChatStore.Store<P>, "read">
	readonly chat: Chat.Id
	readonly request: Omit<ContextCompaction.Request, "window" | "selection">
}

export type RuntimeOperations<E, R> = Operations<
	| Chat.ChatNotFound
	| ChatStore.ChatStoreError
	| ContextCompaction.ContextCompactionError
	| ConversationContextError,
	ContextCompaction.ContextCompaction,
	Chat.ChatNotFound | ChatStore.ChatStoreError | AiError.AiError,
	LanguageModel.LanguageModel,
	E | Chat.RuntimeError,
	R
>

/** Context for the current Chat, bound by the host. */
export class ConversationContext extends Context.Service<
	ConversationContext,
	Operations
>()("@openbot-build/core/context/ConversationContext") {}
