import {
	Context,
	Chunk,
	HashMap,
	HashSet,
	Match,
	Option,
	Data,
	Schema,
	type Duration,
	type Effect,
	type Stream,
} from "effect"
import { dual } from "effect/Function"
import { type Prompt, type Tool, type Toolkit } from "effect/ai"
import { Id, Revision } from "./SessionIdentity.ts"
import * as Turn from "./Turn.ts"
import * as Item from "../timeline/Item.ts"
import * as Timeline from "../timeline/Timeline.ts"
import { PromptJson } from "../store/PromptCodec.ts"
import type * as SessionStore from "../store/SessionStore.ts"
import type * as Agent from "../agent/Agent.ts"
import type * as ContextCompaction from "../context/ContextCompaction.ts"
export { Id, Revision } from "./SessionIdentity.ts"

export const Metadata = Schema.Struct({
	title: Schema.String,
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
export interface PendingApproval {
	readonly approvalId: string
	readonly toolCallId: string
	readonly toolCall: Prompt.ToolCallPart
	readonly occurrence: number
}
const currentItems = <P>(view: View<P>): ReadonlyArray<Item.Record> => {
	const turn = currentTurn(view.session)
	return turn === undefined
		? []
		: view.state.value.conversation.history.filter(
				(entry) =>
					entry.origin?.session === view.session.id &&
					entry.origin.turn === turn.id,
			)
}
/** Count committed occurrences in this Turn, independently of context compaction. */
export const toolCallCount: {
	(callId: string): <P>(view: View<P>) => number
	<P>(view: View<P>, callId: string): number
} = dual(2, <P>(view: View<P>, callId: string): number =>
	currentItems(view).reduce(
		(count, entry) =>
			count +
			entry.content.content.reduce(
				(count, message) =>
					count +
					Match.value(message).pipe(
						Match.when(
							{ role: "assistant" },
							(message) =>
								message.content.filter(
									(part) => part.type === "tool-call" && part.id === callId,
								).length,
						),
						Match.orElse(() => 0),
					),
				0,
			),
		0,
	),
)
/** Only Items produced by the current Session and Turn can authorize its tools. */
export const pendingApprovals = <P>(
	view: View<P>,
): ReadonlyArray<PendingApproval> => {
	const turn = currentTurn(view.session)
	if (turn === undefined || Turn.isTerminal(turn.status)) return []
	interface Call {
		readonly toolCall: Prompt.ToolCallPart
		readonly occurrence: number
		readonly ordinal: number
	}
	let calls = HashMap.empty<string, Call>()
	let requests = HashMap.empty<string, Call>()
	let order = Chunk.empty<string>()
	let resolved = HashSet.empty<number>()
	let ordinal = 0
	for (const entry of currentItems(view)) {
		for (const message of entry.content.content)
			Match.value(message).pipe(
				Match.when({ role: "assistant" }, (message) => {
					for (const part of message.content)
						Match.value(part).pipe(
							Match.when({ type: "tool-call" }, (part) => {
								const prior = Option.getOrUndefined(HashMap.get(calls, part.id))
								calls = HashMap.set(calls, part.id, {
									toolCall: part,
									occurrence: prior === undefined ? 0 : prior.occurrence + 1,
									ordinal: ordinal++,
								})
							}),
							Match.when({ type: "tool-approval-request" }, (part) => {
								const call = Option.getOrUndefined(
									HashMap.get(calls, part.toolCallId),
								)
								if (
									call === undefined ||
									HashMap.has(requests, part.approvalId)
								)
									return
								order = Chunk.append(order, part.approvalId)
								requests = HashMap.set(requests, part.approvalId, call)
							}),
							Match.orElse(() => {}),
						)
				}),
				Match.when({ role: "tool" }, (message) => {
					for (const part of message.content)
						Match.value(part).pipe(
							Match.when({ type: "tool-result" }, (part) => {
								const call = Option.getOrUndefined(HashMap.get(calls, part.id))
								if (call !== undefined)
									resolved = HashSet.add(resolved, call.ordinal)
							}),
							Match.when({ type: "tool-approval-response" }, (part) => {
								const call = Option.getOrUndefined(
									HashMap.get(requests, part.approvalId),
								)
								if (call !== undefined)
									resolved = HashSet.add(resolved, call.ordinal)
							}),
							Match.orElse(() => {}),
						)
				}),
				Match.orElse(() => {}),
			)
	}
	return Array.from(order).flatMap((approvalId) => {
		const call = HashMap.getUnsafe(requests, approvalId)
		const latest = HashMap.getUnsafe(calls, call.toolCall.id)
		return call.toolCall.providerExecuted === true ||
			HashSet.has(resolved, call.ordinal) ||
			latest.ordinal !== call.ordinal
			? []
			: [
					{
						approvalId,
						toolCallId: call.toolCall.id,
						toolCall: call.toolCall,
						occurrence: call.occurrence,
					},
				]
	})
}
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
}
export interface ActionInput extends Omit<Input, "input" | "action"> {
	readonly action: Turn.Action
	readonly input?: Prompt.RawInput
	readonly turn?: Turn.Id
}
export interface ActionReceipt extends Receipt {
	readonly callId: string
}
export interface ApprovalInput {
	readonly session: Id
	readonly turn: Turn.Id
	readonly approval: string
	readonly approved: boolean
	readonly expectedRevision: Revision
}
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
	readonly agent: Agent.Definition<Tools, E, R, BuildE, BuildR, HostTools>
}
export interface Runtime<
	P = {},
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	HostTools extends Record<string, Tool.Any> = {},
> {
	readonly isActive: (session: Id) => Effect.Effect<boolean>
	readonly canApprove: (input: {
		readonly session: Id
		readonly turn: Turn.Id
	}) => Effect.Effect<boolean>
	readonly execute: (
		input: Input,
	) => Effect.Effect<
		View<P>,
		RuntimeError | Agent.ExecutionError<Tools, E>,
		Agent.RuntimeServices<Tools, R>
	>
	readonly stream: (
		input: Input,
	) => Stream.Stream<
		Agent.Event<
			Toolkit.MergedTools<[Toolkit.Toolkit<Tools>, Toolkit.Toolkit<HostTools>]>,
			P
		>,
		RuntimeError | Agent.ExecutionError<Tools, E>,
		Agent.RuntimeServices<Tools, R>
	>
	readonly start: (
		input: Input,
	) => Effect.Effect<Receipt, RuntimeError, Agent.RuntimeServices<Tools, R>>
	readonly startAction: (
		input: ActionInput,
	) => Effect.Effect<
		ActionReceipt,
		RuntimeError,
		Agent.ActionServices<Tools, R>
	>
	readonly approveAction: (
		input: ApprovalInput,
	) => Effect.Effect<Receipt, RuntimeError, Agent.ActionServices<Tools, R>>
	readonly runQueued: (
		session: Id,
	) => Effect.Effect<
		Option.Option<Receipt>,
		RuntimeError,
		Agent.RuntimeServices<Tools, R>
	>
	readonly steer: (input: {
		readonly session: Id
		readonly turn: Turn.Id
		readonly input: Prompt.RawInput
	}) => Effect.Effect<Receipt, RuntimeError>
	readonly enqueue: (input: {
		readonly session: Id
		readonly message: Prompt.RawInput
		readonly expectedRevision?: Revision
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
	readonly approve: (
		input: ApprovalInput,
	) => Effect.Effect<Receipt, RuntimeError, Agent.RuntimeServices<Tools, R>>
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
		Agent.Event<
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
