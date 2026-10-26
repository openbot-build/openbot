import {
	Context,
	Data,
	Schema,
	type Duration,
	type Option,
	type Effect,
	type Scope,
	type Stream,
} from "effect"
import { type Prompt, type Tool, type Toolkit } from "effect/ai"
import { Id, Revision } from "./ChatIdentity.ts"
import * as Turn from "./Turn.ts"
import * as Item from "./Item.ts"
import * as ChatState from "./ChatState.ts"
import { PromptJson } from "../store/PromptCodec.ts"
import type * as ChatStore from "../store/ChatStore.ts"
import type * as Operations from "./Operations.ts"
import type * as Bot from "../bot/Bot.ts"
import type * as ContextCompaction from "../context/ContextCompaction.ts"
export { Id, Revision } from "./ChatIdentity.ts"

/**
 * A tool call that a decider allowed after its Turn went on without it.
 * The Turn that reads the input runs the call with this ID and does not ask again.
 * The ID must be new, because the call that waited has a result already.
 */
export const ApprovedCall = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	params: Schema.Json,
})
export type ApprovedCall = typeof ApprovedCall.Type
/**
 * Input that waits in the inbox of a Chat.
 * A `message` starts the next Turn. A `steer` goes into its running Turn at the next step.
 * An `action` is a host-selected action for its running Turn.
 */
export const InboxEntry = Schema.Struct({
	id: Item.Id,
	content: PromptJson,
	kind: Schema.Literals(["message", "steer", "action"]),
	turn: Schema.optionalKey(Turn.Id),
	action: Schema.optionalKey(Turn.Action),
	/** Who the input is for. The Turn that reads it gets the same author. */
	author: Schema.optionalKey(Turn.Author),
	notice: Schema.optionalKey(Item.Notice),
	approved: Schema.optionalKey(ApprovedCall),
	/** Context, such as an image, that waits for this author's next message. */
	passive: Schema.optionalKey(Schema.Boolean),
})
export type InboxEntry = typeof InboxEntry.Type
/** The small, changing record of a Chat. The Items and the old Turns are kept apart. */
export const Ref = Schema.Struct({
	id: Id,
	revision: Revision,
	settings: Turn.Settings,
	inbox: Schema.Array(InboxEntry),
	/** The current Turn, or the last one. */
	turn: Schema.optionalKey(Turn.Record),
	/** The place of the last Item. It is 0 when the Chat has no Items. */
	seq: Item.Seq,
	business: Schema.Record(Schema.String, ChatState.Opaque),
	createdAt: Schema.Finite,
})
export type Ref = typeof Ref.Type
export const Position = Schema.Struct({ chat: Id, revision: Revision })
export type Position = typeof Position.Type
export const View = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
	Schema.Struct({ chat: Ref, state: ChatState.Value(fields) })
export interface View<P = {}> {
	readonly chat: Ref
	readonly state: ChatState.Value<P>
}
export const currentTurn = (chat: Ref): Turn.Record | undefined => chat.turn
export const status = (chat: Ref): Turn.Status | { readonly _tag: "Idle" } =>
	chat.turn?.status ?? { _tag: "Idle" }
export const position = (chat: Ref): Position => ({
	chat: chat.id,
	revision: chat.revision,
})
export class ChatNotFound extends Schema.TaggedError<
	ChatNotFound,
	{ readonly brand: unique symbol }
>()("ChatNotFound", { chat: Id }) {}
export class ChatError extends Schema.TaggedError<
	ChatError,
	{ readonly brand: unique symbol }
>()("ChatError", {
	reason: Schema.Literals(["state-conflict", "unavailable"]),
	message: Schema.String,
}) {}
export class Conflict extends Schema.TaggedError<
	Conflict,
	{ readonly brand: unique symbol }
>()("ChatConflict", {
	chat: Id,
	message: Schema.String,
}) {}
export type RuntimeError =
	| ChatNotFound
	| ChatError
	| Conflict
	| Turn.Conflict
	| ChatStore.ChatStoreError
	| ContextCompaction.ContextCompactionError

/** How the runtime answers a tool call that asks for approval. */
export type Decision = Data.TaggedEnum<{
	/** The tool runs now with its own handler. */
	Allow: {}
	/** The tool does not run. The model sees the reason. */
	Deny: { readonly reason?: string }
	/**
	 * The tool does not run now. The model gets `result` at once, and the Turn goes on.
	 * When a decider allows the call later, the host delivers it as an approved call.
	 */
	Pending: { readonly result: unknown }
}>
export const Decision = Data.taggedEnum<Decision>()
export interface ApprovalRequest {
	readonly chat: Id
	readonly turn: Turn.Id
	readonly approvalId: string
	readonly toolCall: Prompt.ToolCallPart
	readonly author?: Turn.Author
}
/**
 * Decides tool calls that ask for approval. Without it, every such call is pending,
 * so a Turn never waits.
 */
export class Approvals extends Context.Service<
	Approvals,
	{
		readonly decide: (request: ApprovalRequest) => Effect.Effect<Decision>
	}
>()("@openbot-build/core/chat/Chat/Approvals") {}

export interface DeliverInput {
	readonly chat: Id
	readonly input: Prompt.RawInput
	/** Check this revision in the write that saves input. A conflict saves nothing. */
	readonly expected?: Revision
	/** Who the input is for. See `Turn.Author`. */
	readonly author?: Turn.Author
	readonly notice?: Item.Notice
	readonly approved?: ApprovedCall
	/** Wait for the next Turn, also when a Turn of the same author runs. */
	readonly queue?: boolean
	/** Saves context for the next message of this author, without starting or steering a Turn. */
	readonly passive?: boolean
}
/** Input that starts a Turn at once. */
export interface StartInput extends DeliverInput {
	/** Only `deliver` can save input without starting a Turn. */
	readonly passive?: never
	/** Settings for this Turn only. */
	readonly overrides?: Partial<Turn.Settings>
}
/**
 * What happened to delivered input. `started` began a new Turn. `steered` went into
 * the running Turn of the same author. `queued` waits until the running Turn ends.
 */
export interface Delivery {
	readonly delivery: "started" | "steered" | "queued"
	readonly chat: Id
	/** The Turn that reads the input. A queued input has none yet. */
	readonly turn?: Turn.Id
	readonly item: Item.Id
	readonly revision: Revision
}
export interface ActionInput {
	readonly chat: Id
	readonly action: Turn.Action
	readonly input?: Prompt.RawInput
	/** The running Turn that the action belongs to. Without it, the action starts a Turn. */
	readonly turn?: Turn.Id
	readonly author?: Turn.Author
}
export interface ActionReceipt {
	readonly chat: Id
	readonly turn: Turn.Id
	readonly item: Item.Id
	readonly revision: Revision
	readonly callId: string
}
/** A read-only context of one Chat revision, without input that waits in the inbox. */
export interface ContextSnapshot {
	readonly chat: Id
	readonly revision: Revision
	readonly seq: Item.Seq
	readonly prompt: Prompt.Prompt
}
export interface RuntimeOptions<
	P,
	Tools extends Record<string, Tool.Any>,
	E,
	R,
	BuildE = never,
	BuildR = never,
	HostTools extends Record<string, Tool.Any> = {},
> {
	readonly store: ChatStore.Store<P>
	readonly bot: Bot.Definition<Tools, E, R, BuildE, BuildR, HostTools>
	/**
	 * Whether this runtime may start a Turn in the Chat now. The default is yes. When it
	 * is no, input waits in the inbox, and a runtime that may start it drains it later.
	 * A host uses it when only one process can run the Turns of a Chat.
	 */
	/** Background tool calls, when the host turns them on. */
	readonly operations?: typeof Operations.Operations.Service
	readonly canStart?: (view: View<P>) => Effect.Effect<boolean>
	/**
	 * Runs while a Turn of the Chat runs: from its start until the runtime has
	 * closed it and started the next Turn from the inbox. Its scope closes then.
	 * A host uses it to keep its runtime open while the Turn works, or to tell
	 * other processes that the Turn still runs.
	 */
	readonly whileRunning?: (chat: Id) => Effect.Effect<void, never, Scope.Scope>
}
export interface Runtime<
	P = {},
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	HostTools extends Record<string, Tool.Any> = {},
> {
	readonly isActive: (chat: Id) => Effect.Effect<boolean>
	/**
	 * Reads context that another model can use. A native model window is rebuilt from
	 * the Item log. This does not run a model, a tool, or a memory job.
	 */
	readonly context: (input: {
		readonly chat: Id
		readonly expected?: Revision
	}) => Effect.Effect<ContextSnapshot, RuntimeError>
	/**
	 * Gives input to a Chat in one atomic step. It starts a Turn when the Chat is idle,
	 * steers the running Turn of the same author, or waits in the inbox.
	 * After a Turn ends, the next input in the inbox starts the next Turn.
	 */
	readonly deliver: (
		input: DeliverInput,
	) => Effect.Effect<Delivery, RuntimeError>
	/**
	 * Starts a Turn and returns its events. It fails when the Chat is not idle.
	 * The Turn stops when the caller stops reading, or when the runtime closes.
	 */
	readonly stream: (
		input: StartInput,
	) => Stream.Stream<
		Bot.Event<
			Toolkit.MergedTools<[Toolkit.Toolkit<Tools>, Toolkit.Toolkit<HostTools>]>,
			P
		>,
		RuntimeError | Bot.ExecutionError<Tools, E>
	>
	/** Like `stream`, then waits for the end of the Turn. */
	readonly execute: (
		input: StartInput,
	) => Effect.Effect<View<P>, RuntimeError | Bot.ExecutionError<Tools, E>>
	readonly startAction: (
		input: ActionInput,
	) => Effect.Effect<ActionReceipt, RuntimeError>
	readonly interrupt: (input: {
		readonly chat: Id
		readonly turn: Turn.Id
	}) => Effect.Effect<View<P>, RuntimeError>
	/** Starts the next Turn from the inbox, when the Chat is idle and input waits. */
	readonly drain: (
		chat: Id,
	) => Effect.Effect<Option.Option<Delivery>, RuntimeError>
	readonly status: (chat: Id) => Effect.Effect<View<P>, RuntimeError>
	readonly wait: (input: {
		readonly chat: Id
		readonly after: Revision
		readonly afterActive?: boolean
		readonly timeout: Duration.Input
	}) => Effect.Effect<View<P>, RuntimeError>
	/**
	 * The events of a Chat. With `after`, the recent events after that revision
	 * come first. A slow reader can miss old events, but it gets the newest ones.
	 */
	readonly events: (input: {
		readonly chat: Id
		readonly after?: Revision
	}) => Stream.Stream<
		Bot.Event<
			Toolkit.MergedTools<[Toolkit.Toolkit<Tools>, Toolkit.Toolkit<HostTools>]>,
			P
		>,
		RuntimeError
	>
	readonly compact: (input: {
		readonly chat: Id
		readonly targetTokens: number
		readonly request: Omit<ContextCompaction.Request, "window" | "selection">
		readonly expected?: Revision
	}) => Effect.Effect<
		{
			readonly view: View<P>
			readonly beforeTokens: number
			readonly afterTokens: number
		},
		RuntimeError | E
	>
}
export class Chat extends Context.Service<Chat, Runtime>()(
	"@openbot-build/core/chat/Chat",
) {}
