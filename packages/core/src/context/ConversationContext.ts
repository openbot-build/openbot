import type * as Session from "../session/Session.ts"
import { Context, Data, type Effect, type Option } from "effect"
import type * as ContextWindow from "./ContextWindow.ts"
import {
	type AiError,
	type Prompt,
	type Tool,
	type LanguageModel,
} from "effect/ai"
import type * as SessionStore from "../store/SessionStore.ts"
import type * as ContextCompaction from "./ContextCompaction.ts"

export class State extends Data.TaggedClass("ConversationContext.State")<{
	readonly session: Session.Id
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

export class ConversationContextError extends Data.TaggedError(
	"ConversationContextError",
)<{
	readonly reason:
		| "session-not-found"
		| "read-failed"
		| "summary-failed"
		| "invalid-target"
		| "unsupported"
		| "input-too-large"
		| "target-not-reached"
		| "request-failed"
		| "head-conflict"
	readonly message: string
}> {}

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
	readonly runtime: Pick<Session.Runtime<P, Tools, E, R>, "compact">
	readonly store: Pick<SessionStore.Store<P>, "read">
	readonly session: Session.Id
	readonly request: Omit<ContextCompaction.Request, "window" | "selection">
}

export type RuntimeOperations<E, R> = Operations<
	| Session.SessionNotFound
	| SessionStore.SessionStoreError
	| ContextCompaction.ContextCompactionError
	| ConversationContextError,
	ContextCompaction.ContextCompaction,
	Session.SessionNotFound | SessionStore.SessionStoreError | AiError.AiError,
	LanguageModel.LanguageModel,
	E | Session.RuntimeError,
	R
>

/** Context for the current session, bound by the host. */
export class ConversationContext extends Context.Service<
	ConversationContext,
	Operations
>()("@openbot-build/core/context/ConversationContext") {}
