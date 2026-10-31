import {
	type ChatStore,
	Chat,
	ChatStoreRepository,
	Item,
	Store as CoreStore,
	Turn,
	TurnState,
} from "@openbot-build/core"
import { type SqlError, SqlClient } from "effect/sql"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import type { SecretStorageError } from "../secrets/Secrets.ts"
import * as Imported from "../database/conversion/Executions.ts"
import { ownerKey } from "../apps/StoredConnections.ts"
import { Definition } from "./ToolDefinitions.ts"
import {
	Caller,
	executionCallers,
	restrictExecution,
	Execution,
	ExecutionIdentity,
	ToolExecution,
} from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import * as Db from "../database/Database.ts"
import {
	executions as executionRows,
	toolExecutions,
} from "../database/ExecutionSchema.ts"
import { Store as Executions, type Fence } from "../execution/Store.ts"
import * as DelegationSource from "../bots/DelegationSource.ts"
import { TurnAccess } from "./TurnAccess.ts"
import * as TurnEnd from "./TurnEnd.ts"
import * as StoredChats from "./StoredChats.ts"
import * as ChatHost from "./ChatHost.ts"
import * as Todos from "../plugins/work/Todos.ts"
import { databaseError, inExecution } from "./ChatEncoding.ts"

export const Input = Schema.Struct({
	chat: Chat.Id,
	identity: ExecutionIdentity,
	content: Chat.InboxEntry.fields.content,
	queue: Schema.Boolean,
	action: Schema.optionalKey(Turn.Action),
	actionDefinition: Schema.optionalKey(Definition),
	notice: Schema.optionalKey(Item.Notice),
	approved: Schema.optionalKey(Chat.ApprovedCall),
})
export type Input = typeof Input.Type
/** The caller comes from authentication. The request never chooses an execution identity. */
export const Message = Schema.Struct({
	chat: Chat.Id,
	caller: Caller,
	notice: Schema.optionalKey(Item.Notice),
	content: Chat.InboxEntry.fields.content,
	queue: Schema.Boolean,
	action: Schema.optionalKey(Turn.Action),
	actionDefinition: Schema.optionalKey(Definition),
})
export type Message = typeof Message.Type
const messageCodec = Schema.toCodecJson(Message)
const codec = Schema.toCodecJson(Input)
const sameIdentity = Schema.toEquivalence(ExecutionIdentity)
export const workflowName = "openbot.chat-turn"

export interface Service {
	readonly submit: (
		namespace: string,
		key: Execution.CommandKey,
		input: Input,
	) => Effect.Effect<
		Execution.Receipt,
		| Chat.ChatNotFound
		| ChatStore.ChatStoreError
		| Chat.Conflict
		| Execution.Conflict
		| Execution.KeyConflict
		| Schema.SchemaError
		| (Execution.Forbidden | Execution.NotFound | Execution.StorageError)
	>
	readonly notify: (
		namespace: string,
		key: Execution.CommandKey,
		input: Input,
		source: {
			readonly executionId: Execution.Id
			readonly turn: Turn.Id
			readonly step: number
		},
	) => Effect.Effect<
		Execution.Receipt,
		| Chat.ChatNotFound
		| ChatStore.ChatStoreError
		| Chat.Conflict
		| Execution.Conflict
		| Execution.KeyConflict
		| Schema.SchemaError
		| (Execution.Forbidden | Execution.NotFound | Execution.StorageError)
	>
	readonly drain: (
		namespace: string,
		chat: Chat.Id,
	) => Effect.Effect<
		Option.None<Execution.Id> | Option.Some<Execution.Id>,
		| Chat.ChatNotFound
		| ChatStore.ChatStoreError
		| Chat.Conflict
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Schema.SchemaError
		| SqlError.SqlError
		| Execution.StorageError
	>
	readonly finish: (
		fence: Fence,
		chat: Chat.Id,
		outcome:
			| { readonly status: "completed" }
			| { readonly status: "cancelled"; readonly epoch: number }
			| {
					readonly status: "failed" | "interrupted"
					readonly failure: Execution.Failure
			  },
	) => Effect.Effect<
		Option.None<Execution.Id> | Option.Some<Execution.Id>,
		| Chat.ChatNotFound
		| ChatStore.ChatStoreError
		| Turn.Conflict
		| Chat.Conflict
		| Execution.Conflict
		| EffectDrizzleQueryError
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| SqlError.SqlError
		| Execution.StorageError
	>
	readonly message: (
		namespace: string,
		key: Execution.CommandKey,
		input: Message,
	) => Effect.Effect<
		Execution.Receipt,
		| Chat.ChatNotFound
		| ChatStore.ChatStoreError
		| Chat.Conflict
		| Execution.Conflict
		| Execution.KeyConflict
		| Schema.SchemaError
		| (Execution.Forbidden | Execution.NotFound | Execution.StorageError)
	>
}

export class InputCommands extends Context.Service<InputCommands, Service>()(
	"@openbot-build/openbot/chats/InputCommands",
) {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const executions = yield* Executions
	const access = yield* TurnAccess
	const delegationSource = yield* DelegationSource.make
	const crypto = yield* Crypto.Crypto
	const definition = yield* CoreStore.define({
		stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore, ...Todos.stores },
		schemaVersion: "chat/1",
	})
	const records = (namespace: string) =>
		ChatStoreRepository.make({
			definition,
			persistence: StoredChats.persistence(db, namespace),
		})
	const messageInput = Effect.fn("ChatInputCommands.messageInput")(function* (
		namespace: string,
		message: Message,
		view: Chat.View<ChatHost.Values>,
	) {
		const host = ChatHost.hostState(view.chat)
		if (host.kind !== "direct" && host.kind !== "task" && host.kind !== "live")
			return yield* Chat.Conflict.make({
				chat: message.chat,
				message: "This Chat does not take messages.",
			})
		yield* access.command(view.chat, message.caller)
		let identity: ExecutionIdentity = {
			owner: {
				organizationId: host.chain.organizationId,
				userId: ChatHost.ownerOf(host.chain),
			},
			actor: message.caller,
			botId: host.bot,
		}
		if (host.kind === "task") {
			if (host.ownerExecutionId === undefined || host.parent === undefined)
				return yield* Execution.Forbidden.make({})
			const key = { namespace, id: host.ownerExecutionId }
			const saved = yield* executions.loadMember(key)
			const source = yield* delegationSource(key)
			if (
				saved.record.resource.kind !== "Delegation" ||
				saved.record.resource.id !== host.parent.delegation
			)
				return yield* Execution.Forbidden.make({})
			identity = restrictExecution(
				{
					...saved.identity,
					botId: host.bot,
					delegationId: host.parent.delegation,
					parentExecutionId: source.origin.key.id,
				},
				[...(host.inputConstraints ?? []), message.caller],
			)
		}
		return {
			chat: message.chat,
			content: message.content,
			queue: message.queue,
			...(message.notice === undefined ? {} : { notice: message.notice }),
			...(message.action === undefined ? {} : { action: message.action }),
			...(message.actionDefinition === undefined
				? {}
				: { actionDefinition: message.actionDefinition }),
			identity,
		} satisfies Input
	})
	const prepareInput = (
		namespace: string,
		submitted: Input | Message,
		view: Chat.View<ChatHost.Values>,
	) => {
		if ("caller" in submitted) return messageInput(namespace, submitted, view)
		const host = ChatHost.hostState(view.chat)
		return Effect.succeed(
			host.kind === "task"
				? {
						...submitted,
						identity: restrictExecution(
							submitted.identity,
							host.inputConstraints ?? [],
						),
					}
				: submitted,
		)
	}
	const find = Effect.fn("ChatInputCommands.find")(function* (
		namespace: string,
		chat: Chat.Id,
		turn: Turn.Id,
	) {
		const rows = yield* db
			.select({ id: executionRows.id })
			.from(executionRows)
			.where(
				and(
					eq(executionRows.namespace, namespace),
					eq(executionRows.resourceKind, "Turn"),
					eq(executionRows.resourceId, turn),
				),
			)
			.limit(2)
			.pipe(Effect.mapError(databaseError))
		if (rows.length !== 1 || rows[0] === undefined)
			return yield* Chat.Conflict.make({
				chat,
				message: "The Turn has no single execution.",
			})
		const key = {
			namespace,
			id: yield* Schema.decodeEffect(Execution.Id)(rows[0].id),
		}
		const saved = yield* executions.load(key)
		if (saved.workflow === Imported.workflowName) {
			const input = yield* Schema.decodeUnknownEffect(Imported.Input)(
				saved.input,
			)
			if (
				saved.context?.kind !== "Chat" ||
				saved.context.id !== chat ||
				ownerKey(input.owner) !== namespace ||
				!(
					Execution.isTerminal(saved.record.status) ||
					saved.record.status === "outcome_unknown"
				)
			)
				return yield* Execution.Forbidden.make({})
			yield* executions.loadService(key, Imported.serviceId)
			// History has no caller. It may stop a queue, but can never steer or own fresh input.
			return { key, record: saved.record, identity: undefined }
		}
		return { key, ...(yield* executions.loadMember(key)) }
	})
	// A cancelled input stays in the command log but must not block the next Turn.
	const leading = Effect.fn("ChatInputCommands.leading")(function* (
		store: Effect.Success<ReturnType<typeof records>>,
		namespace: string,
		chat: Chat.Id,
	) {
		while (true) {
			const view = yield* store.read(chat)
			const selected = TurnState.leading(view)
			if (Option.isNone(selected)) return Option.none()
			const turn = Arr.headNonEmpty(selected.value).turn
			if (turn === undefined)
				return yield* Chat.Conflict.make({
					chat,
					message: "The input has no Turn.",
				})
			const next = yield* find(namespace, chat, turn)
			if (Execution.isTerminal(next.record.status)) {
				const ids = Arr.map(selected.value, (entry) => entry.id)
				yield* store.modifyEffect({
					chat,
					update: (view) =>
						Effect.succeed([
							undefined,
							Option.some({
								chat: {
									inbox: Arr.filter(
										view.chat.inbox,
										(entry) => !Arr.contains(ids, entry.id),
									),
								},
							}),
						] as const),
				})
				continue
			}
			// Cancellation must release resources before later input can run.
			if (next.record.status !== "queued") return Option.none()
			return Option.some({ selected: selected.value, turn, key: next.key })
		}
	})
	const submitInput = Effect.fn("ChatInputCommands.submit")(
		function* (
			namespace: string,
			commandKey: Execution.CommandKey,
			submitted: Input | Message,
			source?: {
				readonly executionId: Execution.Id
				readonly turn: Turn.Id
				readonly step: number
			},
		) {
			const value = yield* "caller" in submitted
				? Schema.encodeEffect(messageCodec)(submitted)
				: Schema.encodeEffect(codec)(submitted)
			const body = source === undefined ? value : { input: value, source }
			const store = yield* records(namespace)
			const view = yield* store.read(submitted.chat)
			let input: Input = yield* prepareInput(namespace, submitted, view)
			if (source === undefined) yield* access.input(view.chat, input.identity)
			else yield* access.notice(view.chat, input.identity)
			return yield* executions.accept(
				namespace,
				commandKey,
				{
					actor:
						"caller" in submitted ? submitted.caller : input.identity.actor,
					body,
				},
				(create) =>
					Effect.gen(function* () {
						yield* StoredChats.lock(db, namespace, input.chat)
						const view = yield* store.read(submitted.chat)
						input = yield* prepareInput(namespace, submitted, view)
						if (source === undefined)
							yield* access.input(view.chat, input.identity)
						if (
							source !== undefined &&
							!(yield* access.notice(view.chat, input.identity))
						) {
							if (input.notice === undefined)
								return yield* Execution.Forbidden.make({})
							const entry: Item.Entry = {
								id: Item.Id.make(
									yield* crypto.randomUUIDv7().pipe(Effect.orDie),
								),
								content: input.content,
								origin: {
									chat: input.chat,
									turn: source.turn,
									step: source.step,
									notice: input.notice,
								},
							}
							const changed = yield* store.modifyEffect({
								chat: input.chat,
								update: (view) =>
									Effect.succeed([
										undefined,
										Option.some(TurnState.append(view, [entry])),
									] as const),
							})
							return {
								executionId: source.executionId,
								start: false,
								events: [
									{
										_tag: "Checkpoint" as const,
										resource: { kind: "Chat", id: input.chat },
										revision: changed.view.chat.revision,
										inputId: entry.id,
									},
								],
							}
						}
						if (
							!ChatHost.matchesIdentity(view.chat, input.identity) ||
							input.identity.delegationId !==
								ChatHost.hostState(view.chat).parent?.delegation
						)
							return yield* Execution.Forbidden.make({})
						const current =
							view.chat.turn === undefined
								? undefined
								: yield* find(namespace, input.chat, view.chat.turn.id)
						if (
							current !== undefined &&
							current.identity === undefined &&
							current.record.status === "outcome_unknown"
						)
							return yield* Chat.Conflict.make({
								chat: input.chat,
								message:
									"The old Turn has an unknown result. Stop its execution before new input.",
							})
						const busy =
							current !== undefined &&
							!Execution.isTerminal(current.record.status)
						const steer =
							input.action === undefined &&
							!input.queue &&
							busy &&
							view.chat.turn?.status._tag === "Running" &&
							(current?.record.status === "running" ||
								current?.record.status === "waiting" ||
								current?.record.status === "queued") &&
							current.identity !== undefined &&
							sameIdentity(current.identity, input.identity)
						const last = Arr.last(view.chat.inbox)
						const pending =
							Option.isSome(last) &&
							last.value.kind === "message" &&
							last.value.turn !== undefined
								? yield* find(namespace, input.chat, last.value.turn)
								: undefined
						const group =
							input.action === undefined &&
							Option.isSome(last) &&
							last.value.action === undefined &&
							pending !== undefined &&
							pending.record.status === "queued" &&
							pending.identity !== undefined &&
							sameIdentity(pending.identity, input.identity)
								? pending
								: undefined
						const turn =
							steer && view.chat.turn !== undefined
								? view.chat.turn.id
								: group !== undefined
									? Turn.Id.make(group.record.resource.id)
									: Turn.Id.make(
											yield* crypto.randomUUIDv7().pipe(Effect.orDie),
										)
						const ownerExecutionId = ChatHost.hostState(
							view.chat,
						).ownerExecutionId
						const existing = steer ? current : group
						const key =
							existing?.key ??
							(yield* create({
								workflow: workflowName,
								context: { kind: "Chat", id: input.chat },
								...(ownerExecutionId === undefined ? {} : { ownerExecutionId }),
								resource: { kind: "Turn", id: turn },
								identity: input.identity,
								input: {
									...(input.actionDefinition === undefined
										? {}
										: { actionDefinition: input.actionDefinition }),
									chat: input.chat,
									host: ChatHost.hostState(view.chat),
								},
							}))
						const entry: Chat.InboxEntry = {
							id: Item.Id.make(yield* crypto.randomUUIDv7().pipe(Effect.orDie)),
							content: input.content,
							...(input.action === undefined ? {} : { action: input.action }),
							kind: steer ? "steer" : "message",
							turn,
							// The core only compares this value. Identity stays in the sealed execution record.
							author: turn,
							...(input.notice === undefined ? {} : { notice: input.notice }),
							...(input.approved === undefined
								? {}
								: { approved: input.approved }),
						}
						let changed = yield* store.modifyEffect({
							chat: input.chat,
							update: (view) =>
								Effect.succeed([
									undefined,
									Option.some({
										chat: {
											inbox: Arr.append(view.chat.inbox, entry),
											...(ChatHost.hostState(view.chat).kind !== "task"
												? {}
												: {
														business: {
															...view.chat.business,
															[ChatHost.chatHostId]: {
																...ChatHost.hostState(view.chat),
																inputConstraints: executionCallers(
																	input.identity,
																),
															},
														},
													}),
										},
									}),
								] as const),
						})
						let dispatch = false
						if (!busy) {
							const next = yield* leading(store, namespace, input.chat)
							if (Option.isSome(next)) {
								const { turn: nextTurn, selected, key: nextKey } = next.value
								const items = yield* TurnState.inputs(
									() => crypto.randomUUIDv7().pipe(Effect.orDie),
									input.chat,
									nextTurn,
									0,
									selected,
								)
								const startedAt = yield* Clock.currentTimeMillis
								changed = yield* store.modifyEffect({
									chat: input.chat,
									update: (view) =>
										TurnState.start(view, {
											...(Arr.headNonEmpty(selected).action === undefined
												? {}
												: { action: Arr.headNonEmpty(selected).action }),
											turn: nextTurn,
											selected,
											items,
											startedAt,
										}).pipe(
											Effect.map(
												(mutation) =>
													[undefined, Option.some(mutation)] as const,
											),
										),
								})
								dispatch = nextKey.id === key.id && existing === undefined
								if (!dispatch)
									yield* executions.activate(
										nextKey,
										nextKey.id === key.id
											? []
											: [
													{
														_tag: "Checkpoint",
														resource: { kind: "Chat", id: input.chat },
														revision: changed.view.chat.revision,
													},
												],
									)
							} else {
								// The queue may be waiting for cancellation to release its resources.
								changed = { ...changed, view: yield* store.read(input.chat) }
							}
						}

						return {
							executionId: key.id,
							start: existing === undefined,
							dispatch,
							events: [
								{
									_tag: "Checkpoint" as const,
									resource: { kind: "Chat", id: input.chat },
									revision: changed.view.chat.revision,
									inputId: entry.id,
								},
							],
						}
					}),
			)
		},
		Effect.scoped,
		inExecution,
	)
	/** The last execution must end after resource release before the next Turn starts. */
	const drain = Effect.fn("ChatInputCommands.drain")(
		function* (namespace: string, chat: Chat.Id) {
			const store = yield* records(namespace)
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* StoredChats.lock(db, namespace, chat)
					const view = yield* store.read(chat)
					if (view.chat.turn !== undefined) {
						const current = yield* find(namespace, chat, view.chat.turn.id)
						if (!Execution.isTerminal(current.record.status))
							return Option.none()
					}
					const next = yield* leading(store, namespace, chat)
					if (Option.isNone(next)) return Option.none()
					const { turn, selected, key } = next.value
					const items = yield* TurnState.inputs(
						() => crypto.randomUUIDv7().pipe(Effect.orDie),
						chat,
						turn,
						0,
						selected,
					)
					const startedAt = yield* Clock.currentTimeMillis
					const changed = yield* store.modifyEffect({
						chat,
						update: (view) =>
							TurnState.start(view, {
								...(Arr.headNonEmpty(selected).action === undefined
									? {}
									: { action: Arr.headNonEmpty(selected).action }),
								turn,
								selected: selected,
								items,
								startedAt,
							}).pipe(
								Effect.map(
									(mutation) => [undefined, Option.some(mutation)] as const,
								),
							),
					})
					yield* executions.activate(key, [
						{
							_tag: "Checkpoint",
							resource: { kind: "Chat", id: chat },
							revision: changed.view.chat.revision,
						},
					])
					return Option.some(key.id)
				}),
			)
		},
		Effect.scoped,
		inExecution,
	)
	/** Call after the Turn scope closes. Ending this execution also admits the next input. */
	const finish = Effect.fn("ChatInputCommands.finish")(
		function* (
			fence: Fence,
			chat: Chat.Id,
			outcome:
				| { readonly status: "completed" }
				| { readonly status: "cancelled"; readonly epoch: number }
				| {
						readonly status: "failed" | "interrupted"
						readonly failure: Execution.Failure
				  },
		) {
			const store = yield* records(fence.namespace)
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* StoredChats.lock(db, fence.namespace, chat)
					if ((yield* executions.get(fence)).status === outcome.status)
						return Option.none()
					// Keep the execution row locked in this outer transaction before reading call results.
					yield* executions.lock(fence)
					const end = Effect.gen(function* () {
						let view = yield* store.read(chat)
						const execution = yield* executions.loadMember(fence)
						const target = execution.record.resource
						if (target.kind !== "Turn")
							return yield* Execution.Conflict.make({ id: fence.id })
						const childRows = yield* db
							.select()
							.from(toolExecutions)
							.where(
								and(
									eq(toolExecutions.namespace, fence.namespace),
									eq(toolExecutions.parentExecutionId, fence.id),
								),
							)
						const children = yield* Effect.forEach(childRows, (child) =>
							Effect.gen(function* () {
								const key = {
									namespace: fence.namespace,
									id: Execution.Id.make(child.executionId),
								}
								const state = yield* executions.get(key)
								if (!child.detached && !Execution.isTerminal(state.status))
									return yield* Execution.Conflict.make({ id: fence.id })
								return {
									id: ToolExecution.Id.make(child.id),
									executionId: key.id,
									callId: child.callId,
									item: Item.Id.make(child.item),
									detached: child.detached,
									status: state.status,
									failure: state.failure,
									calls: child.detached ? [] : yield* executions.calls(key),
								}
							}),
						)
						const turn = view.chat.turn
						if (outcome.status === "cancelled" && turn?.id !== target.id) {
							// A queued Turn has no resources or active Chat step. Keep its command history.
							const changed = yield* store.modifyEffect({
								chat,
								update: (view) =>
									Effect.succeed([
										undefined,
										Option.some({
											chat: {
												inbox: Arr.filter(
													view.chat.inbox,
													(entry) => entry.turn !== target.id,
												),
											},
										}),
									] as const),
							})
							return [
								{
									_tag: "Checkpoint" as const,
									resource: { kind: "Chat", id: chat },
									revision: changed.view.chat.revision,
								},
								{ _tag: "Result" as const, resource: target },
							]
						}
						if (
							turn === undefined ||
							(outcome.status === "completed" &&
								turn.status._tag !== "Completed")
						)
							return yield* Execution.Conflict.make({ id: fence.id })
						const current = yield* find(fence.namespace, chat, turn.id)
						if (current.key.id !== fence.id || current.identity === undefined)
							return yield* Execution.Conflict.make({ id: fence.id })
						let endEvents: ReadonlyArray<
							Exclude<Execution.EventBody, { readonly _tag: "State" }>
						> = []
						if (
							outcome.status !== "completed" &&
							!Turn.isTerminal(turn.status)
						) {
							const items = yield* TurnEnd.items(
								turn,
								yield* store.items(chat, { turn: turn.id }),
								yield* executions.calls(fence),
								outcome.status === "cancelled"
									? ((yield* executions.get(fence)).failure ?? undefined)
									: outcome.failure,
								Item.Id.make(yield* crypto.randomUUIDv7().pipe(Effect.orDie)),
								children,
							)
							const completedAt = yield* Clock.currentTimeMillis
							const changed = yield* store.modifyEffect({
								chat,
								update: (view) =>
									TurnState.end(view, {
										turn: turn.id,
										completedAt,
										items,
										status:
											outcome.status === "interrupted" ||
											outcome.status === "cancelled"
												? Turn.Status.Interrupted()
												: Turn.Status.Failed({
														code: "internal_error",
														message: `The execution failed. Error ID: ${outcome.failure.errorId}`,
													}),
									}).pipe(
										Effect.map(
											({ mutation }) =>
												[undefined, Option.some(mutation)] as const,
										),
									),
							})
							view = changed.view
							endEvents = [
								{
									_tag: "Checkpoint",
									resource: { kind: "Chat", id: chat },
									revision: view.chat.revision,
								},
							]
						}
						// A completed Turn keeps its result if release later fails. The execution records that failure.

						let moved: ReadonlyArray<
							Exclude<Execution.EventBody, { readonly _tag: "State" }>
						> = []
						const groups = Arr.match(view.chat.inbox, {
							onEmpty: () => [],
							onNonEmpty: (entries) =>
								Arr.groupWith(
									entries,
									(a, b) =>
										a.kind === "message" &&
										b.kind === "message" &&
										a.turn === undefined &&
										b.turn === undefined &&
										a.author === turn.id &&
										b.author === turn.id,
								),
						})
						for (const group of groups) {
							const first = Arr.headNonEmpty(group)
							if (
								first.kind !== "message" ||
								first.turn !== undefined ||
								first.author !== turn.id
							)
								continue
							const nextTurn = Turn.Id.make(
								yield* crypto.randomUUIDv7().pipe(Effect.orDie),
							)
							const items = Arr.map(group, (entry) => entry.id)
							const receipt = yield* executions.accept(
								fence.namespace,
								Execution.CommandKey.make(
									yield* crypto.randomUUIDv7().pipe(Effect.orDie),
								),
								{
									actor: current.identity.actor,
									body: { kind: "unread-input", executionId: fence.id, items },
								},
								(create) =>
									Effect.gen(function* () {
										const key = yield* create({
											workflow: workflowName,
											context: { kind: "Chat", id: chat },
											...(yield* executions.ownership(fence)),
											resource: { kind: "Turn", id: nextTurn },
											identity:
												ChatHost.hostState(view.chat).kind === "task"
													? restrictExecution(
															current.identity,
															ChatHost.hostState(view.chat).inputConstraints ??
																[],
														)
													: current.identity,
											input: { chat, host: ChatHost.hostState(view.chat) },
										})
										const changed = yield* store.modifyEffect({
											chat,
											update: (view) =>
												Effect.succeed([
													undefined,
													Option.some({
														chat: {
															inbox: Arr.map(view.chat.inbox, (entry) =>
																Arr.contains(items, entry.id)
																	? {
																			...entry,
																			turn: nextTurn,
																			author: nextTurn,
																		}
																	: entry,
															),
														},
													}),
												] as const),
										})
										return {
											executionId: key.id,
											start: true,
											dispatch: false,
											events: [
												{
													_tag: "Checkpoint" as const,
													resource: { kind: "Chat", id: chat },
													revision: changed.view.chat.revision,
												},
											],
										}
									}),
							)
							moved = Arr.append(moved, {
								_tag: "InputMoved",
								executionId: receipt.executionId,
								items,
							})
						}
						return [
							...endEvents,
							...moved,
							{
								_tag: "Result" as const,
								resource: { kind: "Turn", id: turn.id },
							},
						]
					})
					if (outcome.status === "cancelled") {
						const status = yield* executions.finishCancellation(
							fence,
							outcome.epoch,
							(status) =>
								status === "outcome_unknown" ? Effect.succeed([]) : end,
						)
						if (status === "outcome_unknown") return Option.none()
					} else {
						const events = yield* end
						yield* executions.commit(
							fence,
							{
								status: outcome.status,
								...(outcome.status === "completed"
									? {}
									: { failure: outcome.failure }),
								events,
							},
							Effect.void,
						)
					}
					return yield* drain(fence.namespace, chat)
				}),
			)
		},
		Effect.scoped,
		inExecution,
	)
	const submit = (namespace: string, key: Execution.CommandKey, input: Input) =>
		submitInput(namespace, key, input)
	/** Accepted notices keep their old origin. Closed work gets history, never a new Turn. */
	const notify = (
		namespace: string,
		key: Execution.CommandKey,
		input: Input,
		source: {
			readonly executionId: Execution.Id
			readonly turn: Turn.Id
			readonly step: number
		},
	) => submitInput(namespace, key, input, source)
	return InputCommands.of({
		submit,
		notify,
		drain,
		finish,
		message: (namespace: string, key: Execution.CommandKey, input: Message) =>
			submitInput(namespace, key, input),
	})
})

/** Input commands use database transactions and own no long-running Chat runtime. */

export const layer = Layer.effect(InputCommands, make)
