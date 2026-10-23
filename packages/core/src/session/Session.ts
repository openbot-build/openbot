import {
	Context,
	Data,
	Schema,
	type Duration,
	type Effect,
	type Option,
	type Stream,
} from "effect"
import { type Prompt, type Tool, type Toolkit } from "effect/ai"
import { Id, Revision } from "./SessionIdentity.ts"
import * as Turn from "./Turn.ts"
import * as Item from "../timeline/Item.ts"
import * as Timeline from "../timeline/Timeline.ts"
import * as TimelineState from "../timeline/TimelineState.ts"
import { PromptJson } from "../store/PromptCodec.ts"
import type * as SessionStore from "../store/SessionStore.ts"
import type * as Bot from "../bot/Bot.ts"
import type * as ContextCompaction from "../context/ContextCompaction.ts"
export { Id, Revision } from "./SessionIdentity.ts"

export const Metadata = Schema.Struct({
	/** A Session without a title has no `title`. */
	title: Schema.optionalKey(Schema.String),
	archived: Schema.Boolean,
})
export type Metadata = typeof Metadata.Type
export interface MetadataInput {
	readonly title?: string
}
export const Pending = Schema.Struct({
	id: Item.Id,
	content: PromptJson,
	kind: Schema.Literals(["message", "steer", "action"]),
	turn: Schema.optionalKey(Turn.Id),
	action: Schema.optionalKey(Turn.Action),
	/** Who wrote the message. The Turn that runs it gets the same author. */
	author: Schema.optionalKey(Turn.Author),
})
export type Pending = typeof Pending.Type
const opaque = Schema.declare(
	(_value: unknown): _value is unknown => true,
).annotate({ toCodecJson: () => undefined, toJsonSchema: () => ({}) })
export const Ref = Schema.Struct({
	id: Id,
	revision: Revision,
	head: Timeline.VersionId,
	metadata: Metadata,
	settings: Turn.Settings,
	pending: Schema.Array(Pending),
	turns: Schema.Array(Turn.Record),
	inheritedTurns: Schema.Array(Turn.Record),
	business: Schema.Record(Schema.String, opaque),
	forkedFrom: Schema.optionalKey(
		Schema.Struct({ session: Id, version: Timeline.VersionId }),
	),
})
export type Ref = typeof Ref.Type
export const Position = Schema.Struct({
	session: Id,
	version: Timeline.VersionId,
	revision: Revision,
})
export type Position = typeof Position.Type
export const Expected = Schema.Struct({ session: Id, revision: Revision })
export type Expected = typeof Expected.Type
export const HistorySelection = Schema.Struct({
	session: Id,
	version: Timeline.VersionId,
})
export type HistorySelection = typeof HistorySelection.Type
export const View = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
	Schema.Struct({ session: Ref, state: Timeline.State(fields) })
export interface View<P = {}> {
	readonly session: Ref
	readonly state: Timeline.State<P>
}
export const currentTurn = (session: Ref): Turn.Record | undefined =>
	session.turns.at(-1)
export const status = (session: Ref): Turn.Status | { readonly _tag: "Idle" } =>
	currentTurn(session)?.status ?? { _tag: "Idle" }
export const position = (session: Ref): Position => ({
	session: session.id,
	version: session.head,
	revision: session.revision,
})
export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{
	readonly session: Id
}> {}
export class SessionError extends Data.TaggedError("SessionError")<{
	readonly reason: "state-conflict" | "unavailable"
	readonly message: string
}> {}
export class Conflict extends Data.TaggedError("SessionConflict")<{
	readonly session: Id
	readonly message: string
}> {}
export type RuntimeError =
	| SessionNotFound
	| SessionError
	| Conflict
	| Timeline.VersionError
	| Turn.Conflict
	| SessionStore.SessionStoreError
	| ContextCompaction.ContextCompactionError
export interface Input {
	readonly base: Expected
	readonly input: Prompt.RawInput
	readonly overrides?: Partial<Turn.Settings>
	readonly action?: Turn.Action
	/** Who the Turn works for, when the host sets it. See `Turn.Author`. */
	readonly author?: Turn.Author
}
export interface ActionInput extends Omit<Input, "input" | "action"> {
	readonly action: Turn.Action
	readonly input?: Prompt.RawInput
	readonly turn?: Turn.Id
}
export interface ActionReceipt extends Receipt {
	readonly callId: string
}
/** How the host answers one approval request of a waiting Turn. */
export type Outcome = Data.TaggedEnum<{
	/** The tool runs with its own handler. */
	Approved: {}
	/** The tool does not run. The model sees the reason. */
	Denied: { readonly reason?: string }
	/** The tool does not run. The host gives its result instead. */
	Result: { readonly result: unknown; readonly isFailure: boolean }
}>
export const Outcome = Data.taggedEnum<Outcome>()
export interface ResolveInput {
	readonly session: Id
	readonly turn: Turn.Id
	readonly approval: string
	readonly outcome: Outcome
	readonly expectedRevision: Revision
}
export type Wait = TimelineState.Wait
/** The approval requests of a Session that still wait for an answer. */
export const waits = <P>(view: View<P>): ReadonlyArray<Wait> =>
	TimelineState.waits(view.state.value)
export interface Receipt {
	readonly session: Id
	readonly turn: Turn.Id
	readonly item: Item.Id
	readonly revision: Revision
	readonly version: Timeline.VersionId
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
	readonly store: SessionStore.Store<P>
	readonly bot: Bot.Definition<Tools, E, R, BuildE, BuildR, HostTools>
}
export interface Runtime<
	P = {},
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	HostTools extends Record<string, Tool.Any> = {},
> {
	readonly isActive: (session: Id) => Effect.Effect<boolean>
	readonly execute: (
		input: Input,
	) => Effect.Effect<
		View<P>,
		RuntimeError | Bot.ExecutionError<Tools, E>,
		Bot.RuntimeServices<Tools, R>
	>
	readonly stream: (
		input: Input,
	) => Stream.Stream<
		Bot.Event<
			Toolkit.MergedTools<[Toolkit.Toolkit<Tools>, Toolkit.Toolkit<HostTools>]>,
			P
		>,
		RuntimeError | Bot.ExecutionError<Tools, E>,
		Bot.RuntimeServices<Tools, R>
	>
	readonly start: (
		input: Input,
	) => Effect.Effect<Receipt, RuntimeError, Bot.RuntimeServices<Tools, R>>
	readonly startAction: (
		input: ActionInput,
	) => Effect.Effect<ActionReceipt, RuntimeError, Bot.ActionServices<Tools, R>>
	/** Like resolve, for a Turn that runs a host-selected action. */
	readonly resolveAction: (
		input: ResolveInput,
	) => Effect.Effect<Receipt, RuntimeError, Bot.ActionServices<Tools, R>>
	readonly runQueued: (
		session: Id,
	) => Effect.Effect<
		Option.Option<Receipt>,
		RuntimeError,
		Bot.RuntimeServices<Tools, R>
	>
	readonly steer: (input: {
		readonly session: Id
		readonly turn: Turn.Id
		readonly input: Prompt.RawInput
		/** Only the author of a Turn can steer it. */
		readonly author?: Turn.Author
	}) => Effect.Effect<Receipt, RuntimeError>
	readonly enqueue: (input: {
		readonly session: Id
		readonly message: Prompt.RawInput
		readonly expectedRevision?: Revision
		readonly author?: Turn.Author
	}) => Effect.Effect<
		{
			readonly session: Id
			readonly item: Item.Id
			readonly revision: Revision
		},
		RuntimeError
	>
	readonly interrupt: (input: {
		readonly session: Id
		readonly turn: Turn.Id
	}) => Effect.Effect<View<P>, RuntimeError>
	/**
	 * Answers one approval request of a waiting Turn. The answer is stored in the history,
	 * so it works after a restart. The Turn runs again when no request waits any more.
	 */
	readonly resolve: (
		input: ResolveInput,
	) => Effect.Effect<Receipt, RuntimeError, Bot.RuntimeServices<Tools, R>>
	readonly resume: (session: Id) => Effect.Effect<View<P>, RuntimeError>
	readonly status: (session: Id) => Effect.Effect<View<P>, RuntimeError>
	readonly wait: (input: {
		readonly session: Id
		readonly after: Revision
		readonly afterActive?: boolean
		readonly timeout: Duration.Input
	}) => Effect.Effect<View<P>, RuntimeError>
	readonly events: (input: {
		readonly session: Id
		readonly after?: Revision
	}) => Stream.Stream<
		Bot.Event<
			Toolkit.MergedTools<[Toolkit.Toolkit<Tools>, Toolkit.Toolkit<HostTools>]>,
			P
		>,
		RuntimeError
	>
	readonly compact: (input: {
		readonly session: Id
		readonly targetTokens: number
		readonly request: Omit<ContextCompaction.Request, "window" | "selection">
		readonly expected?: Timeline.VersionId
	}) => Effect.Effect<
		{
			readonly view: View<P>
			readonly beforeTokens: number
			readonly afterTokens: number
		},
		RuntimeError | E,
		R
	>
}
export class Session extends Context.Service<Session, Runtime>()(
	"@openbot-build/core/session/Session",
) {}
