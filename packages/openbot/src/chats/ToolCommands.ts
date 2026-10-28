import {
	type TokenId,
	type BotId,
	type DelegationId,
	Execution,
	ToolExecution,
} from "@openbot-build/domain"
import type { Check } from "../execution/Admission.ts"
import * as DecisionWait from "../execution/DecisionWait.ts"
import { type Definition } from "./ToolDefinitions.ts"
import * as ToolRecords from "./ToolRecords.ts"
import { Request, codec, workflowName } from "./ToolRecords.ts"
import { latestCall } from "./ToolResults.ts"
import {
	Chat,
	Operation,
	ToolStep,
	Turn,
	type Operations,
} from "@openbot-build/core"
import { and, asc, eq, notInArray } from "drizzle-orm"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Duration,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { Prompt } from "effect/ai"
import * as Hex from "effect/encoding/Hex"
import { SqlClient } from "effect/sql"
import * as Db from "../database/Database.ts"
import { executions, toolExecutions } from "../database/ExecutionSchema.ts"
import { Calls } from "../execution/Calls.ts"
import { type Authorize } from "../execution/Engine.ts"
import { Store, storage, type Fence, type Key } from "../execution/Store.ts"
import { TurnAccess } from "./TurnAccess.ts"
import * as StoredChats from "./StoredChats.ts"
import * as ChatHost from "./ChatHost.ts"
import { stepId } from "./ToolSteps.ts"

export { workflowName } from "./ToolRecords.ts"
export const noticeWorkflowName = "openbot.tool-notice"
export const End = Schema.Union([
	Schema.Struct({ status: Schema.Literal("completed") }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		failure: Execution.Failure,
	}),
	Schema.Struct({ status: Schema.Literal("interrupted") }),
	Schema.Struct({ status: Schema.Literal("cancelled"), epoch: Schema.Natural }),
])
export type End = typeof End.Type
const terminal = ["completed", "failed", "cancelled", "interrupted"]

export interface Service {
	readonly submit: (
		parent: Fence,
		position: ToolExecution.Position,
		call: Prompt.ToolCallPart,
		settings: Operations.Settings,
		budget?: "foreground" | Duration.Input | undefined,
		definition?: Definition | undefined,
	) => Effect.Effect<
		ToolExecution.Record,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly load: (key: Key) => Effect.Effect<
		{
			record: ToolExecution.Record
			input: ToolRecords.Input
			identity: {
				readonly owner: {
					readonly organizationId: string
					readonly userId: string
				}
				readonly actor:
					| {
							readonly kind: "member"
							readonly userId: string
							readonly organizationId: string
							readonly tokenId?: never
					  }
					| {
							readonly kind: "user_token"
							readonly userId: string
							readonly organizationId: string
							readonly tokenId: TokenId
					  }
				readonly constraints?: readonly (
					| {
							readonly kind: "member"
							readonly userId: string
							readonly organizationId: string
							readonly tokenId?: never
					  }
					| {
							readonly kind: "user_token"
							readonly userId: string
							readonly organizationId: string
							readonly tokenId: TokenId
					  }
				)[]
				readonly channel?: {
					readonly id: string
					readonly externalUserId: string
				}
				readonly botId?: BotId
				readonly delegationId?: DelegationId
				readonly parentExecutionId?: Execution.Id
			}
		},
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly detach: (
		parent: Fence,
		child: Execution.Id,
		waiting?: DecisionWait.Waiting | undefined,
	) => Effect.Effect<
		ToolExecution.Record,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly list: (
		namespace: string,
		chat: Chat.Id,
	) => Effect.Effect<
		ToolExecution.Record[],
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly authorize: Authorize
	readonly finish: (
		fence: Fence,
		end: End,
	) => Effect.Effect<
		ToolExecution.Record,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly stopAttached: (
		parent: Fence,
	) => Effect.Effect<
		ToolExecution.Record[],
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly admit: Check
}

export class ToolCommands extends Context.Service<ToolCommands, Service>()(
	"@openbot-build/openbot/chats/ToolCommands",
) {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const calls = yield* Calls
	const access = yield* TurnAccess
	const crypto = yield* Crypto.Crypto
	const { row, load, parent: parentOf } = yield* ToolRecords.make

	/** A repeat of a saved step has one child, even across owners and servers. */
	const submit = Effect.fn("ToolCommands.submit")(function* (
		parent: Fence,
		position: ToolExecution.Position,
		call: Prompt.ToolCallPart,
		settings: Operations.Settings,
		budget?: typeof Operation.Budget.Service,
		definition?: Definition,
	) {
		yield* calls.authorize(parent, "replay")
		const execution = yield* store.loadMember(parent)
		const reference = yield* Schema.decodeUnknownEffect(
			Schema.Struct({ chat: Chat.Id }),
		)(execution.input)
		if (
			execution.record.resource.kind !== "Turn" ||
			execution.record.resource.id !== position.turn ||
			reference.chat !== position.chat
		)
			return yield* Execution.Conflict.make({ id: parent.id })
		const selected = budget ?? settings.budget
		const input = yield* Schema.decodeEffect(Request)({
			position,
			call,
			...(definition === undefined ? {} : { definition }),
			budgetMs:
				selected === "foreground"
					? null
					: Duration.toMillis(Duration.fromInputUnsafe(selected)),
			maxDurationMs: Duration.toMillis(
				Duration.fromInputUnsafe(settings.maxDuration),
			),
			limit: settings.limit,
		})
		const body = yield* Schema.encodeEffect(
			Schema.toCodecJson(
				Schema.Struct({
					parentExecutionId: Execution.Id,
					position: ToolExecution.Position,
					call: Prompt.ToolCallPart,
				}),
			),
		)({ parentExecutionId: parent.id, position, call })
		// A model may use a long call ID. Hash the saved position to keep the command key bounded.
		const name = yield* Schema.encodeEffect(
			Schema.fromJsonString(Schema.Array(Schema.String)),
		)([parent.id, position.item, call.id])
		const hash = Hex.encode(
			yield* crypto.digest("SHA-256", new TextEncoder().encode(name)),
		)
		const receipt = yield* store.accept(
			parent.namespace,
			Execution.CommandKey.make(`tool:${hash}`),
			{
				actor: execution.identity.actor,
				body,
			},
			(create) =>
				Effect.gen(function* () {
					yield* calls.authorize(parent, "advance")
					// Use the same lock order as Chat input: command, Chat, then execution.
					yield* StoredChats.lock(db, parent.namespace, position.chat)
					yield* calls.authorize(parent, "advance")
					return yield* store.commit(
						parent,
						{
							events: (child) => [
								{
									_tag: "ChildExecution",
									executionId: child.executionId,
									step: stepId(position.item, call.id),
								},
							],
						},
						Effect.gen(function* () {
							const found = yield* StoredChats.ref(
								db,
								parent.namespace,
								position.chat,
							)
							const turn = Option.isSome(found) ? found.value.turn : undefined
							const step = turn?.pendingStep
							if (
								turn?.id !== position.turn ||
								turn.status._tag !== "Running" ||
								step === undefined ||
								step.item !== position.item ||
								step.step !== position.step
							)
								return yield* Execution.Conflict.make({ id: parent.id })
							const saved = Arr.findFirst(
								ToolStep.pending(Turn.stepPrompt(step)),
								(part) => part.id === call.id,
							)
							if (Option.isNone(saved))
								return yield* Execution.Conflict.make({ id: parent.id })
							const encode = Schema.encodeEffect(
								Schema.toCodecJson(Prompt.ToolCallPart),
							)
							if (
								!Schema.toEquivalence(Schema.Json)(
									yield* encode(saved.value),
									yield* encode(call),
								)
							)
								return yield* Execution.Conflict.make({ id: parent.id })
							const id = ToolExecution.Id.make(yield* crypto.randomUUIDv4())
							const child = yield* create({
								workflow: workflowName,
								context: { kind: "Chat", id: position.chat },
								...(yield* store.ownership(parent)),
								resource: { kind: "ToolCall", id },
								// Keep the original token and delegation path. The parent link is a separate field.
								identity: execution.identity,
								input: yield* Schema.encodeEffect(codec)({
									...input,
									context: {
										host: ChatHost.hostState(Option.getOrThrow(found)),
										settings: turn.settings,
										prompt: Turn.stepPrompt(step),
										...((turn.activeAction?.action ?? turn.action) === undefined
											? {}
											: { action: turn.activeAction?.action ?? turn.action }),
									},
								}),
							})
							yield* db.insert(toolExecutions).values({
								namespace: child.namespace,
								id,
								executionId: child.id,
								parentExecutionId: parent.id,
								chat: position.chat,
								turn: position.turn,
								item: position.item,
								callId: call.id,
							})
							return { executionId: child.id, start: true }
						}),
					)
				}),
		)
		return (yield* load({
			namespace: parent.namespace,
			id: receipt.executionId,
		})).record
	}, storage)

	/** Moving to the background is a saved decision, not a local timer result. */
	const detach = Effect.fn("ToolCommands.detach")(function* (
		parent: Fence,
		child: Execution.Id,
		waiting?: DecisionWait.Waiting,
	) {
		yield* calls.authorize(parent, "replay")
		const key = { namespace: parent.namespace, id: child }
		const before = yield* load(key)
		if (before.record.parentExecutionId !== parent.id)
			return yield* Execution.Conflict.make({ id: child })
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* StoredChats.lock(
					db,
					parent.namespace,
					before.record.position.chat,
				)
				return yield* store.commit(
					parent,
					{},
					Effect.gen(function* () {
						// A result and the move to the background must not pass each other.
						yield* db
							.select()
							.from(executions)
							.where(
								and(
									eq(executions.namespace, key.namespace),
									eq(executions.id, child),
								),
							)
							.for("update")
						const saved = yield* load(key)
						if (
							saved.record.detached ||
							Execution.isTerminal(saved.record.status)
						)
							return saved.record
						const needsDecision =
							waiting !== undefined &&
							(yield* DecisionWait.check(store, key, waiting))
						if (
							!needsDecision &&
							(saved.input.budgetMs === null ||
								(yield* Clock.currentTimeMillis) <
									saved.record.startedAt + saved.input.budgetMs)
						)
							return saved.record
						const active = yield* db
							.select({ id: toolExecutions.id })
							.from(toolExecutions)
							.innerJoin(
								executions,
								and(
									eq(executions.namespace, toolExecutions.namespace),
									eq(executions.id, toolExecutions.executionId),
								),
							)
							.where(
								and(
									eq(toolExecutions.namespace, key.namespace),
									eq(toolExecutions.chat, saved.record.position.chat),
									eq(toolExecutions.detached, true),
									notInArray(executions.status, terminal),
								),
							)
						if (active.length >= saved.input.limit) return saved.record
						yield* db
							.update(toolExecutions)
							.set({ detached: true })
							.where(
								and(
									eq(toolExecutions.namespace, key.namespace),
									eq(toolExecutions.executionId, child),
								),
							)
						return { ...saved.record, detached: true }
					}),
				)
			}),
		)
	}, storage)
	const list = Effect.fn("ToolCommands.list")(function* (
		namespace: string,
		chat: Chat.Id,
	) {
		const rows = yield* db
			.select({ id: toolExecutions.executionId })
			.from(toolExecutions)
			.innerJoin(
				executions,
				and(
					eq(executions.namespace, toolExecutions.namespace),
					eq(executions.id, toolExecutions.executionId),
				),
			)
			.where(
				and(
					eq(toolExecutions.namespace, namespace),
					eq(toolExecutions.chat, chat),
				),
			)
			.orderBy(asc(executions.createdAt), asc(executions.id))
		return yield* Effect.forEach(rows, ({ id }) =>
			load({ namespace, id: Execution.Id.make(id) }).pipe(
				Effect.map((saved) => saved.record),
			),
		)
	}, storage)
	/** Cancelling a Turn stops only its attached children. It does not end their scopes. */
	const stopAttached = Effect.fn("ToolCommands.stopAttached")(function* (
		parent: Fence,
	) {
		const execution = yield* store.loadMember(parent)
		if (execution.record.resource.kind !== "Turn")
			return yield* Execution.Conflict.make({ id: parent.id })
		const reference = yield* Schema.decodeUnknownEffect(
			Schema.Struct({ chat: Chat.Id }),
		)(execution.input)
		const children = Arr.filter(
			yield* list(parent.namespace, reference.chat),
			(child) =>
				child.parentExecutionId === parent.id &&
				!child.detached &&
				!Execution.isTerminal(child.status),
		)
		for (const child of children) {
			const key = { namespace: parent.namespace, id: child.executionId }
			// The command lock comes first, then Chat, parent, and child. Detach uses this same order.
			yield* store
				.cancel(
					key,
					Execution.CommandKey.make(
						`parent-stop:${execution.cancelEpoch}:${child.id}`,
					),
					execution.identity.actor,
					Effect.gen(function* () {
						yield* StoredChats.lock(db, parent.namespace, reference.chat)
						yield* store.lock(parent)
						if (
							(yield* store.loadMember(parent)).cancelEpoch !==
							execution.cancelEpoch
						)
							return yield* Execution.Conflict.make({ id: parent.id })
						const current = (yield* load(key)).record
						if (current.detached || Execution.isTerminal(current.status))
							return yield* Execution.Conflict.make({ id: key.id })
					}),
				)
				.pipe(
					Effect.catchTag("ExecutionConflict", (error) =>
						error.id === key.id ? Effect.void : Effect.fail(error),
					),
				)
		}
		return Arr.filter(
			yield* list(parent.namespace, reference.chat),
			(child) => child.parentExecutionId === parent.id && !child.detached,
		)
	}, storage)

	const authorize: Authorize = (key, actor, mode) =>
		Effect.gen(function* () {
			const { key: parent } = yield* parentOf(key)
			// A tool can outlive its Turn. Replay checks current member, token, Bot and ancestor rights
			// without requiring the old Turn's delegation or review to remain open.
			yield* access.authorize(
				parent,
				actor,
				mode === "advance" ? "replay" : mode,
			)
		})
	/** A final state and a pending Chat notice share one transaction. */
	const finish = Effect.fn("ToolCommands.finish")(function* (
		fence: Fence,
		end: End,
	) {
		const saved = yield* load(fence)
		const state = yield* store.loadMember(fence)
		// Another caller can finish after the first read. Return the saved final state.
		if (Execution.isTerminal(state.record.status))
			return (yield* load(fence)).record
		// A late result can reopen cancellation in the same epoch for its final close.
		const phase =
			end.status === "cancelled"
				? `cancel:${end.epoch}:${state.record.sequence}`
				: "result"
		const name = yield* Schema.encodeEffect(
			Schema.fromJsonString(Schema.Array(Schema.String)),
		)([fence.id, phase])
		const hash = Hex.encode(
			yield* crypto.digest("SHA-256", new TextEncoder().encode(name)),
		)
		const body = yield* Schema.encodeEffect(Schema.toCodecJson(End))(end)
		yield* store.accept(
			fence.namespace,
			Execution.CommandKey.make(`tool-end:${hash}`),
			{
				actor: saved.identity.actor,
				body,
			},
			(create) =>
				Effect.gen(function* () {
					yield* StoredChats.lock(
						db,
						fence.namespace,
						saved.input.position.chat,
					)
					const events = () => [
						...Option.match(notice, {
							onNone: () => [],
							onSome: (key) => [
								{
									_tag: "ChildExecution" as const,
									executionId: key.id,
									step: "notice",
								},
							],
						}),
						{
							_tag: "Result" as const,
							resource: { kind: "ToolCall", id: saved.record.id },
						},
					]
					let notice: Option.Option<Key> = Option.none()
					const notify = Effect.gen(function* () {
						if (!(yield* row(fence)).detached) return
						notice = Option.some(
							yield* create({
								workflow: noticeWorkflowName,
								context: { kind: "Chat", id: saved.input.position.chat },
								...(yield* store.ownership(fence)),
								resource: { kind: "ChatNotice", id: saved.record.id },
								identity: saved.identity,
								input: { toolExecutionId: fence.id },
							}),
						)
					})
					if (end.status === "cancelled") {
						yield* store.finishCancellation(fence, end.epoch, (status) =>
							Effect.gen(function* () {
								if (status === "outcome_unknown") return []
								yield* notify
								return events()
							}),
						)
					} else {
						yield* store.commit(
							fence,
							{
								status: end.status,
								...(end.status === "failed" ? { failure: end.failure } : {}),
								events,
							},
							Effect.gen(function* () {
								const latest = yield* store.latestCalls(fence)
								if (
									end.status === "completed" &&
									!Option.exists(
										latestCall(saved.record, latest),
										(call) => call.status === "completed",
									)
								)
									return yield* Execution.Conflict.make({ id: fence.id })
								for (const call of latest) {
									if (
										call.retry !== "read_only" &&
										call.retry !== "local" &&
										(call.status === "sending" ||
											call.status === "outcome_unknown")
									) {
										const decision = yield* store.decision(
											fence,
											Execution.callDecisionId(
												call.id,
												(yield* store.loadMember(fence)).cancelEpoch,
											),
										)
										if (
											end.status !== "interrupted" ||
											Option.isNone(decision) ||
											(decision.value.answer?.answer !== "stop" &&
												!(
													decision.value.answer?.answer === "retry" &&
													(yield* store.loadMember(fence)).phaseFailed
												))
										)
											return yield* Execution.Conflict.make({ id: fence.id })
									}
									if (call.retry === "read_only" && call.status === "sending")
										yield* store.incompleteRead(fence, call.id)
								}
								yield* notify
							}),
						)
					}
					return Option.match(notice, {
						onNone: () => ({ executionId: fence.id, start: false }),
						onSome: (key) => ({ executionId: key.id, start: true }),
					})
				}),
		)
		return (yield* load(fence)).record
	}, storage)

	return ToolCommands.of({
		submit,
		load,
		detach,
		list,
		authorize,
		finish,
		stopAttached,
		admit: access.admit,
	})
})

export const layer = Layer.effect(ToolCommands, make)
