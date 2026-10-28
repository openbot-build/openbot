import {
	type MemberExecution,
	Store,
	storage,
	type Fence,
	type Key,
} from "../execution/Store.ts"
import {
	type BotId,
	type Bots as BotsType,
	type Settings as SettingsData,
	type TriggerId,
	type Computers,
	type ToolExecution,
	type ChatModelInvalid,
	Delegations as Domain,
	Execution,
	Caller,
	type ExecutionIdentity,
} from "@openbot-build/domain"
import {
	type ChatStore,
	type Item,
	type Config,
	Chat,
	ChatStoreRepository,
	Store as CoreStore,
	Turn,
} from "@openbot-build/core"
import {
	type PlatformError,
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
	Struct,
} from "effect"
import type { SecretStorageError } from "../secrets/Secrets.ts"
import { type Failure, Bots } from "./Bots.ts"
import { type SqlError, SqlClient } from "effect/sql"
import { Prompt } from "effect/ai"
import { Hex } from "effect/encoding"
import * as PolicyOrigin from "../capabilities/PolicyOrigin.ts"
import { Requests } from "../capabilities/Requests.ts"
import * as CallFrame from "../chats/CallFrame.ts"
import { inExecution } from "../chats/ChatEncoding.ts"
import * as ChatHost from "../chats/ChatHost.ts"
import * as ChatModels from "../chats/ChatModels.ts"
import { InputCommands } from "../chats/InputCommands.ts"
import * as StoredChats from "../chats/StoredChats.ts"
import * as ToolOrigins from "../chats/ToolOrigins.ts"
import { TurnAccess } from "../chats/TurnAccess.ts"
import * as Db from "../database/Database.ts"
import type { Authorize, Decide } from "../execution/Engine.ts"
import { ModelRegistry } from "../models/ModelRegistry.ts"
import * as Todos from "../plugins/work/Todos.ts"
import { delegationTimeLimitOf } from "../settings/Documents.ts"
import { Settings } from "../settings/Settings.ts"
import * as DelegationUsage from "./DelegationUsage.ts"
import { Delegations, noUsage } from "./Delegations.ts"

export {
	workflowName,
	noticeWorkflowName,
	Input,
	Request,
} from "./DelegationSource.ts"
import * as DelegationSource from "./DelegationSource.ts"
import {
	workflowName,
	noticeWorkflowName,
	Input,
	Request,
	codec,
} from "./DelegationSource.ts"
const sameCaller = Schema.toEquivalence(Caller)
export const End = Schema.Union([
	Schema.Struct({ status: Schema.Literal("completed"), result: Schema.String }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		failure: Execution.Failure,
	}),
	Schema.Struct({ status: Schema.Literal("cancelled"), epoch: Schema.Natural }),
])
export type End = typeof End.Type

export interface Service {
	readonly submit: (
		source: Fence,
		site: Execution.CallSite,
		request: {
			readonly task: string
			readonly reason: string
			readonly limits?: Domain.DelegationLimits
			readonly previous?: Domain.DelegationId
			readonly bot?: BotId
		},
	) => Effect.Effect<
		Execution.Receipt,
		| BotsType.BotStorageUnavailable
		| Chat.ChatNotFound
		| ChatStore.ChatStoreError
		| Chat.Conflict
		| Execution.Conflict
		| Execution.KeyConflict
		| PlatformError.PlatformError
		| Schema.SchemaError
		| SecretStorageError
		| SettingsData.SettingsUnavailable
		| (Execution.Forbidden | Execution.NotFound | Execution.StorageError)
	>
	readonly cancel: (
		source: Fence,
		site: Execution.CallSite,
		id: Domain.DelegationId,
	) => Effect.Effect<
		{
			readonly delegation: Domain.DelegationId
			readonly executionId: Execution.Id
			readonly accepted: true
		},
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly load: (key: Key) => Effect.Effect<
		| {
				execution: MemberExecution
				input: {
					readonly bot: BotId
					readonly task: string
					readonly reason: string
					readonly limits?: Domain.DelegationLimits
					readonly previous?: Domain.DelegationId
					readonly source:
						| { readonly _tag: "Tool"; readonly site: Execution.CallSite }
						| {
								readonly _tag: "Trigger"
								readonly id: TriggerId
								readonly owner: Computers.ComputerOwner
								readonly revision: number
								readonly chat: Chat.Id
						  }
						| {
								readonly _tag: "Message"
								readonly previousExecutionId: Execution.Id
								readonly chat: Chat.Id
								readonly caller: Caller
						  }
				}
				stored: {
					readonly executionId?: Execution.Id
					readonly limitEpoch?: number
					readonly limitTurnExecutionId?: Execution.Id
					readonly delegation: Domain.Delegation
					readonly userId: string
					readonly author: string
					readonly chain: ChatHost.Chain
					readonly request?: string
					readonly window?: Domain.DelegationUsage
					readonly runningSince?: number
				}
				origin: {
					_tag: "Trigger"
					key: Key
					source: {
						readonly _tag: "Trigger"
						readonly id: TriggerId
						readonly owner: Computers.ComputerOwner
						readonly revision: number
						readonly chat: Chat.Id
					}
				}
		  }
		| {
				execution: MemberExecution
				input: {
					readonly bot: BotId
					readonly task: string
					readonly reason: string
					readonly limits?: Domain.DelegationLimits
					readonly previous?: Domain.DelegationId
					readonly source:
						| { readonly _tag: "Tool"; readonly site: Execution.CallSite }
						| {
								readonly _tag: "Trigger"
								readonly id: TriggerId
								readonly owner: Computers.ComputerOwner
								readonly revision: number
								readonly chat: Chat.Id
						  }
						| {
								readonly _tag: "Message"
								readonly previousExecutionId: Execution.Id
								readonly chat: Chat.Id
								readonly caller: Caller
						  }
				}
				stored: {
					readonly executionId?: Execution.Id
					readonly limitEpoch?: number
					readonly limitTurnExecutionId?: Execution.Id
					readonly delegation: Domain.Delegation
					readonly userId: string
					readonly author: string
					readonly chain: ChatHost.Chain
					readonly request?: string
					readonly window?: Domain.DelegationUsage
					readonly runningSince?: number
				}
				origin: {
					key: { namespace: string; id: Execution.Id }
					execution: MemberExecution
					child: {
						record: {
							readonly id: ToolExecution.Id
							readonly executionId: Execution.Id
							readonly parentExecutionId: Execution.Id
							readonly position: {
								readonly chat: Chat.Id
								readonly turn: Turn.Id
								readonly item: Item.Id
								readonly step: number
							}
							readonly callId: string
							readonly tool: string
							readonly status: Execution.Status
							readonly detached: boolean
							readonly startedAt: number
							readonly deadline: number
							readonly failure: Execution.Failure | null
						}
						input: {
							readonly position: {
								readonly chat: Chat.Id
								readonly turn: Turn.Id
								readonly item: Item.Id
								readonly step: number
							}
							readonly call: {
								readonly type: "tool-call"
								readonly id: string
								readonly name: string
								readonly params: unknown
								readonly providerExecuted: boolean
								readonly "~effect/ai/Prompt/Part": "~effect/ai/Prompt/Part"
								readonly options: { readonly [x: string]: Schema.Json }
							}
							readonly definition?: {
								readonly name: string
								readonly description?: string
								readonly parameters: { readonly [x: string]: Schema.Json }
								readonly readOnly: boolean
								readonly local: boolean
								readonly idempotent: boolean
								readonly inputState?: Schema.Json
								readonly budgetMs?: number | null
							}
							readonly budgetMs: number | null
							readonly maxDurationMs: number
							readonly limit: number
							readonly context: {
								readonly host: ChatHost.ChatHostState
								readonly settings: Turn.Settings
								readonly prompt: Prompt.Prompt
								readonly action?: Turn.Action
							}
						}
						identity: ExecutionIdentity
					}
					toolKey: Key
					path: ReadonlyArray<string>
					source?: never
					_tag: "Tool"
				}
		  },
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly authorize: Authorize
	readonly start: (
		fence: Fence,
	) => Effect.Effect<
		Execution.Receipt,
		| ChatModelInvalid
		| Chat.ChatNotFound
		| ChatStore.ChatStoreError
		| Chat.Conflict
		| Execution.Conflict
		| Execution.KeyConflict
		| Config.ModelConfigurationError
		| Schema.SchemaError
		| SecretStorageError
		| Failure
		| (Execution.Forbidden | Execution.NotFound | Execution.StorageError)
	>
	readonly task: (
		key: Key,
	) => Effect.Effect<
		Option.Option<{ namespace: string; id: Execution.Id }>,
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly finish: (
		fence: Fence,
		end: End,
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly close: (
		fence: Fence,
	) => Effect.Effect<
		void,
		| Chat.ChatNotFound
		| ChatStore.ChatStoreError
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| SqlError.SqlError
		| Execution.StorageError
	>
	readonly view: (
		key: Key,
	) => Effect.Effect<
		Domain.ExecutionView,
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly inspect: (fence: Fence) => Effect.Effect<
		| {
				result?: never
				readonly _tag: "Changed"
				readonly task?: never
				readonly control?: never
		  }
		| {
				readonly _tag: "Ended"
				readonly task: Key
				readonly result: Option.Option<string>
				readonly control?: never
		  }
		| {
				result?: never
				readonly task?: never
				readonly _tag: "Limit"
				readonly control: Domain.LimitControl
		  }
		| {
				result?: never
				readonly task?: never
				readonly control?: never
				readonly _tag: "Wait"
				readonly watch: {
					readonly key: {
						readonly namespace: string
						readonly id: Execution.Id
					}
					readonly sequence: number
				}[]
				readonly deadline?: number
		  },
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly pause: (
		fence: Fence,
		control: Domain.LimitControl,
	) => Effect.Effect<
		{ receipt: Execution.Receipt; control: Domain.LimitControl },
		| BotsType.BotStorageUnavailable
		| Chat.ChatNotFound
		| ChatStore.ChatStoreError
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
	readonly resume: (
		fence: Fence,
		control: Domain.LimitControl,
	) => Effect.Effect<
		Execution.Receipt,
		| BotsType.BotStorageUnavailable
		| Chat.ChatNotFound
		| ChatStore.ChatStoreError
		| Chat.Conflict
		| Execution.Conflict
		| Execution.KeyConflict
		| Schema.SchemaError
		| SecretStorageError
		| (Execution.Forbidden | Execution.NotFound | Execution.StorageError)
	>
	readonly stopLimit: (
		fence: Fence,
		control: PolicyOrigin.Control,
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
	readonly phase: (
		fence: Fence,
		status: "running" | "waiting",
	) => Effect.Effect<
		undefined,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly decide: Decide
}

export class DelegationCommands extends Context.Service<
	DelegationCommands,
	Service
>()("@openbot-build/openbot/bots/DelegationCommands") {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const access = yield* TurnAccess
	const frames = yield* CallFrame.make
	const policies = yield* PolicyOrigin.make
	const origins = yield* ToolOrigins.make
	const delegations = yield* Delegations
	const requests = yield* Requests
	const metering = yield* DelegationUsage.make
	const bots = yield* Bots
	const inputs = yield* InputCommands
	const models = yield* ModelRegistry

	const settings = yield* Settings
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
	const load = yield* DelegationSource.make
	const authorize: Authorize = (key, actor, mode) =>
		load(key).pipe(Effect.andThen(access.authorize(key, actor, mode)))
	/** A command owns one delegation, even after the source Turn has moved on. */
	const submit = Effect.fn("DelegationCommands.submit")(
		function* (
			source: Fence,
			site: Execution.CallSite,
			request: typeof Request.Type,
		) {
			const frame = yield* frames.read(source, site)
			const earlier =
				request.bot === undefined && request.previous !== undefined
					? yield* delegations.find(
							frame.identity.owner.organizationId,
							request.previous,
						)
					: Option.none()
			const input: Input = {
				...request,
				bot:
					request.bot ??
					(Option.isSome(earlier) ? earlier.value.delegation.bot : frame.bot),
			}
			const origin = yield* origins.find(source)
			if (Option.isNone(origin)) return yield* Execution.Forbidden.make({})
			const hash = Hex.encode(
				yield* crypto.digest(
					"SHA-256",
					new TextEncoder().encode(
						yield* Schema.encodeEffect(
							Schema.fromJsonString(Schema.Array(Schema.String)),
						)([origin.value.toolKey.id, ...frame.callPath]),
					),
				),
			)
			return yield* store.accept(
				source.namespace,
				Execution.CommandKey.make(`delegation:${hash}`),
				{
					actor: frame.identity.actor,
					body: {
						source: source.id,
						site,
						input: yield* Schema.encodeEffect(Schema.toCodecJson(Input))(input),
					},
				},
				(create) =>
					Effect.gen(function* () {
						yield* StoredChats.lock(db, source.namespace, frame.position.chat)
						yield* access.authorize(source, frame.identity.actor, "advance")
						const earlier =
							input.previous === undefined
								? Option.none()
								: yield* delegations.find(
										frame.identity.owner.organizationId,
										input.previous,
									)
						if (
							input.previous !== undefined &&
							(Option.isNone(earlier) ||
								earlier.value.userId !== frame.identity.owner.userId ||
								earlier.value.delegation.parent.chat !== frame.position.chat ||
								earlier.value.delegation.bot !== input.bot ||
								earlier.value.executionId === undefined)
						)
							return yield* Execution.Forbidden.make({})
						const previousChat = Option.isSome(earlier)
							? earlier.value.delegation.chat
							: null
						if (Option.isSome(earlier)) {
							if (previousChat === null)
								return yield* Execution.Conflict.make({ id: source.id })
							yield* StoredChats.lock(db, source.namespace, previousChat)
							const ref = yield* StoredChats.ref(
								db,
								source.namespace,
								previousChat,
							)
							if (
								Option.isNone(ref) ||
								ChatHost.hostState(ref.value).ownerExecutionId !==
									earlier.value.executionId
							)
								return yield* Execution.Conflict.make({ id: source.id })
							const key = {
								namespace: source.namespace,
								id: earlier.value.executionId!,
							}
							const previous = yield* load(key)
							if (
								!sameCaller(
									frame.identity.actor,
									previous.execution.identity.actor,
								)
							)
								return yield* Execution.Forbidden.make({})
							if (!Execution.isTerminal(previous.execution.record.status)) {
								if (
									previous.execution.record.status === "cancelling" ||
									ChatHost.hostState(ref.value).closed === true
								)
									return yield* Execution.Conflict.make({ id: key.id })
								// Added input keeps the first execution's actor and token. It cannot gain the new caller's rights.
								return yield* store.commit(
									source,
									{},
									Effect.gen(function* () {
										yield* inputs.submit(
											source.namespace,
											Execution.CommandKey.make(`delegation-input:${hash}`),
											{
												chat: previousChat,
												identity: {
													...previous.execution.identity,
													botId: previous.input.bot,
													delegationId: previous.stored.delegation.id,
													parentExecutionId: previous.origin.key.id,
												},
												content: Prompt.make(input.task),
												queue: false,
												notice: {
													kind: "task",
													ref: previous.stored.delegation.id,
												},
											},
										)
										return { executionId: key.id, start: false }
									}),
								)
							}
						}
						const bot = yield* bots.find(
							frame.identity.owner.organizationId,
							input.bot,
						)
						if (Option.isNone(bot) || bot.value.archived)
							return yield* Execution.Forbidden.make({})
						const limits = input.limits ?? {
							timeMs: delegationTimeLimitOf(
								(yield* settings.organization(
									frame.identity.owner.organizationId,
								)).document,
							),
						}
						return yield* store.commit(
							source,
							{
								events: (child) => [
									{
										_tag: "ChildExecution",
										executionId: child.executionId,
										step: `delegation:${hash}`,
									},
								],
							},
							Effect.gen(function* () {
								const id = Domain.DelegationId.make(`dlg_${hash}`)
								const key = yield* create({
									workflow: workflowName,
									resource: { kind: "Delegation", id },
									...(yield* store.ownership(source)),
									identity: frame.identity,
									input: yield* Schema.encodeEffect(codec)({
										...input,
										limits,
										source: { _tag: "Tool", site },
									}),
								})
								yield* origins.attach(source, key, site)
								const stored = yield* delegations.create(
									frame.identity.owner.organizationId,
									{
										id,
										executionId: key.id,
										...(previousChat === null ? {} : { chat: previousChat }),
										userId: frame.identity.owner.userId,
										// The execution holds the actor. This field is only an opaque item author.
										author: key.id,
										chain: ChatHost.chainForHost(frame.host, frame.identity),
										parent: {
											chat: frame.position.chat,
											turn: frame.position.turn,
											toolCallId: site.main,
										},
										bot: input.bot,
										task: input.task,
										reason: input.reason,
										limits,
										status: "authorizing",
									},
								)
								if (stored.executionId !== key.id)
									return yield* Execution.Conflict.make({ id: source.id })
								if (previousChat !== null) {
									const chats = yield* records(source.namespace)
									yield* chats.modifyEffect({
										chat: previousChat,
										update: (view) =>
											Effect.succeed([
												undefined,
												Option.some({
													chat: {
														business: {
															...view.chat.business,
															[ChatHost.chatHostId]: {
																...ChatHost.hostState(view.chat),
																ownerExecutionId: key.id,
																closed: true,
															},
														},
													},
												}),
											] as const),
									})
								}
								return { executionId: key.id, start: true }
							}),
						)
					}),
			)
		},
		Effect.scoped,
		inExecution,
	)
	/** A source Chat can ask its own delegation to stop. The workflow releases it. */
	const cancel = Effect.fn("DelegationCommands.cancel")(function* (
		source: Fence,
		site: Execution.CallSite,
		id: Domain.DelegationId,
	) {
		const frame = yield* frames.read(source, site)
		const found = yield* delegations.find(
			frame.identity.owner.organizationId,
			id,
		)
		if (
			Option.isNone(found) ||
			found.value.executionId === undefined ||
			found.value.userId !== frame.identity.owner.userId ||
			found.value.delegation.parent.chat !== frame.position.chat
		)
			return yield* Execution.Forbidden.make({})
		const key = { namespace: source.namespace, id: found.value.executionId }
		const read = Effect.gen(function* () {
			const target = yield* load(key)
			yield* authorize(
				key,
				frame.identity.actor,
				sameCaller(frame.identity.actor, target.execution.identity.actor)
					? "replay"
					: "cancel",
			)
			return target
		})
		const target = yield* read
		if (!Execution.isTerminal(target.execution.record.status)) {
			const path = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.Array(Schema.String)),
			)([source.id, ...frame.callPath])
			yield* store.cancel(
				key,
				Execution.CommandKey.make(`delegation-cancel:${path}`),
				frame.identity.actor,
				Effect.gen(function* () {
					yield* StoredChats.lock(
						db,
						source.namespace,
						frame.position.chat,
					).pipe(storage)
					yield* store.commit(
						source,
						{},
						Effect.gen(function* () {
							yield* access.authorize(source, frame.identity.actor, "advance")
							yield* read
						}),
					)
				}),
			)
		}
		return { delegation: id, executionId: key.id, accepted: true } as const
	}, storage)
	/** The first input, Chat and parent event commit together. Recovery reads its receipt. */
	const start = Effect.fn("DelegationCommands.start")(
		function* (fence: Fence) {
			const saved = yield* load(fence)
			yield* authorize(fence, saved.execution.identity.actor, "advance")
			const commandKey = Execution.CommandKey.make(
				`delegation-start:${fence.id}`,
			)
			const command = {
				actor: saved.execution.identity.actor,
				body: { delegationExecutionId: fence.id },
			}
			const prior = yield* store.receipt(fence.namespace, commandKey, command)
			const catalog =
				Option.isSome(prior) || saved.stored.delegation.chat !== null
					? Option.none()
					: Option.some(
							yield* models.catalog(
								saved.execution.identity.actor.organizationId,
							),
						)
			return yield* store.accept(fence.namespace, commandKey, command, () =>
				Effect.gen(function* () {
					const previousChat = saved.stored.delegation.chat
					if (previousChat !== null)
						yield* StoredChats.lock(db, fence.namespace, previousChat)
					yield* store.lock(fence)
					const current = yield* load(fence)
					if (
						current.execution.generation !== fence.generation ||
						current.execution.record.status !== "running" ||
						current.stored.delegation.status !== "authorizing" ||
						(previousChat === null && Option.isNone(catalog))
					)
						return yield* Execution.Conflict.make({ id: fence.id })
					yield* authorize(fence, current.execution.identity.actor, "advance")
					const bot = yield* bots.access(
						current.execution.identity.actor,
						current.input.bot,
						"delegate",
					)
					if (bot.archived) return yield* Execution.Forbidden.make({})
					const priorChat =
						previousChat === null
							? Option.none()
							: yield* StoredChats.ref(db, fence.namespace, previousChat)
					if (
						previousChat !== null &&
						(Option.isNone(priorChat) ||
							ChatHost.hostState(priorChat.value).ownerExecutionId !== fence.id)
					)
						return yield* Execution.Conflict.make({ id: fence.id })
					const model = Option.isSome(priorChat)
						? priorChat.value.settings.model
						: yield* ChatModels.select(
								{
									kind: "task",
									bot,
									...(Option.isSome(models.defaultModel)
										? { defaultModel: models.defaultModel.value }
										: {}),
								},
								Option.getOrThrow(catalog),
							)
					return yield* store.commit(
						fence,
						{
							events: (receipt) => [
								{
									_tag: "ChildExecution",
									executionId: receipt.executionId,
									step: "task",
								},
							],
						},
						Effect.gen(function* () {
							const chats = yield* records(fence.namespace)
							const id =
								previousChat ??
								Chat.Id.make(`chat_task_${current.stored.delegation.id}`)
							const identity: ExecutionIdentity = {
								...current.execution.identity,
								botId: bot.id,
								delegationId: current.stored.delegation.id,
								parentExecutionId: current.origin.key.id,
							}
							const chain = current.stored.chain
							const host: ChatHost.ChatHostState = {
								bot: bot.id,
								kind: "task",
								ownerExecutionId: fence.id,
								parent: {
									...current.stored.delegation.parent,
									delegation: current.stored.delegation.id,
								},
								chain: {
									...chain,
									bots: Arr.append(chain.bots, bot.id),
									chats: Arr.append(
										chain.chats,
										current.stored.delegation.parent.chat,
									),
								},
							}
							if (previousChat === null)
								yield* chats.create({
									id,
									settings: model === undefined ? {} : { model },
									business: { [ChatHost.chatHostId]: host },
								})
							else
								yield* chats.modifyEffect({
									chat: id,
									update: (view) =>
										Effect.succeed([
											undefined,
											Option.some({
												chat: {
													business: {
														...view.chat.business,
														[ChatHost.chatHostId]: {
															...host,
															...(ChatHost.hostState(view.chat)
																.inputConstraints === undefined
																? {}
																: {
																		inputConstraints: ChatHost.hostState(
																			view.chat,
																		).inputConstraints,
																	}),
														},
													},
												},
											}),
										] as const),
								})
							const now = yield* Clock.currentTimeMillis
							yield* metering.begin(fence, 0, now)
							const changed = yield* delegations.change(
								identity.owner.organizationId,
								current.stored.delegation.id,
								["authorizing"],
								(stored) => ({
									...stored,

									delegation: {
										...stored.delegation,
										status: "running",
										chat: id,
										usage: stored.delegation.usage ?? noUsage,
									},
								}),
							)
							if (Option.isNone(changed))
								return yield* Execution.Conflict.make({ id: fence.id })
							return yield* inputs.submit(
								fence.namespace,
								Execution.CommandKey.make(`delegation-input:${fence.id}`),
								{
									chat: id,
									identity,
									content: Prompt.make(current.input.task),
									queue: true,
									notice: { kind: "task", ref: current.stored.delegation.id },
								},
							)
						}),
					)
				}).pipe(
					Effect.map((receipt) => ({
						executionId: receipt.executionId,
						start: false,
					})),
				),
			)
		},
		Effect.scoped,
		inExecution,
	)
	const task = Effect.fn("DelegationCommands.task")(function* (key: Key) {
		const saved = yield* load(key)
		const prior = yield* store.receipt(
			key.namespace,
			Execution.CommandKey.make(`delegation-start:${key.id}`),
			{
				actor: saved.execution.identity.actor,
				body: { delegationExecutionId: key.id },
			},
		)
		return Option.map(prior, (receipt) => ({
			namespace: key.namespace,
			id: receipt.executionId,
		}))
	}, storage)
	/** Ending a delegation stores its result and a pending notice in the same transaction. */
	const finish = Effect.fn("DelegationCommands.finish")(function* (
		fence: Fence,
		end: End,
	) {
		const saved = yield* load(fence)
		return yield* store.accept(
			fence.namespace,
			Execution.CommandKey.make(
				`delegation-end:${fence.id}:${end.status === "cancelled" ? end.epoch : "result"}`,
			),
			{
				actor: saved.execution.identity.actor,
				body: yield* Schema.encodeEffect(Schema.toCodecJson(End))(end),
			},
			(create) =>
				Effect.gen(function* () {
					const chat = saved.stored.delegation.chat
					if (chat !== null) yield* StoredChats.lock(db, fence.namespace, chat)
					yield* store.lock(fence)
					const current = yield* load(fence)
					if (current.execution.generation !== fence.generation)
						return yield* Execution.Conflict.make({ id: fence.id })
					let cursor = 0
					while (true) {
						const events = yield* store.events(fence, cursor)
						for (const event of events) {
							if (event.body._tag !== "ChildExecution") continue
							const child = yield* store.get({
								namespace: fence.namespace,
								id: event.body.executionId,
							})
							if (!Execution.isTerminal(child.status))
								return yield* Execution.Conflict.make({ id: fence.id })
						}
						if (events.length < 128) break
						if (Arr.isReadonlyArrayNonEmpty(events))
							cursor = Arr.lastNonEmpty(events).sequence
					}
					const ref =
						chat === null
							? Option.none()
							: yield* StoredChats.ref(db, fence.namespace, chat)
					if (
						chat !== null &&
						(Option.isNone(ref) ||
							ref.value.inbox.length > 0 ||
							(ref.value.turn !== undefined &&
								!Turn.isTerminal(ref.value.turn.status)))
					)
						return yield* Execution.Conflict.make({ id: fence.id })
					if (
						end.status === "completed" &&
						(Option.isNone(ref) ||
							ref.value.turn?.status._tag !== "Completed" ||
							ref.value.turn.status.result.text !== end.result)
					)
						return yield* Execution.Conflict.make({ id: fence.id })
					if (end.status === "completed") {
						const started = yield* task(fence)
						const host = Option.isSome(ref)
							? ChatHost.hostState(ref.value)
							: undefined
						const owned = yield* store.owned(fence)
						if (
							Option.isNone(started) ||
							host?.ownerExecutionId !== fence.id ||
							host.parent?.delegation !== current.stored.delegation.id ||
							!Arr.some(
								owned,
								({ record }) =>
									record.resource.kind === "Turn" &&
									record.resource.id === Option.getOrUndefined(ref)?.turn?.id &&
									record.status === "completed",
							)
						)
							return yield* Execution.Conflict.make({ id: fence.id })
					}
					const update = Effect.gen(function* () {
						const failed = (yield* store.loadMember(fence)).phaseFailed
						const now = yield* Clock.currentTimeMillis
						yield* metering.close(fence, now)
						const usage = yield* metering.read(fence, now)
						const changed = yield* delegations.change(
							saved.execution.identity.owner.organizationId,
							saved.stored.delegation.id,
							Domain.OpenDelegationStatus.literals,
							(stored) => ({
								...Struct.omit(stored, ["runningSince"]),
								delegation: {
									...Struct.omit(stored.delegation, ["pause"]),
									status: failed ? "failed" : end.status,
									usage,
									result: end.status === "completed" ? end.result : null,
								},
							}),
						)
						if (Option.isNone(changed))
							return yield* Execution.Conflict.make({ id: fence.id })
						return yield* create({
							workflow: noticeWorkflowName,
							...(saved.execution.context === null
								? {}
								: { context: saved.execution.context }),
							resource: { kind: "ChatNotice", id: saved.stored.delegation.id },
							...(yield* store.ownership(fence)),
							identity: saved.execution.identity,
							input: { delegationExecutionId: fence.id },
						})
					})
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
							resource: saved.execution.record.resource,
						},
					]
					let notice: Option.Option<Key> = Option.none()
					if (end.status === "cancelled")
						yield* store.finishCancellation(fence, end.epoch, (status) =>
							Effect.gen(function* () {
								if (status === "outcome_unknown") return []
								notice = Option.some(yield* update)
								return events()
							}),
						)
					else
						yield* store.commit(
							fence,
							{
								status: end.status,
								events,
								...(end.status === "failed" ? { failure: end.failure } : {}),
							},
							Effect.gen(function* () {
								notice = Option.some(yield* update)
							}),
						)
					return Option.match(notice, {
						onNone: () => ({ executionId: fence.id, start: false }),
						onSome: (key) => ({ executionId: key.id, start: true }),
					})
				}),
		)
	}, storage)
	/** Close input before cancelling children. Later notices may still add history. */
	const close = Effect.fn("DelegationCommands.close")(
		function* (fence: Fence) {
			const saved = yield* load(fence)
			const chat = saved.stored.delegation.chat
			if (chat === null) return
			yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* StoredChats.lock(db, fence.namespace, chat)
					yield* store.lock(fence)
					const current = yield* load(fence)
					if (
						current.execution.generation !== fence.generation ||
						Execution.isTerminal(current.execution.record.status)
					)
						return yield* Execution.Conflict.make({ id: fence.id })
					const chats = yield* records(fence.namespace)
					yield* chats.modifyEffect({
						chat,
						update: (view) => {
							const host = ChatHost.hostState(view.chat)
							if (host.ownerExecutionId !== fence.id)
								return Effect.fail(Execution.Forbidden.make({}))
							return Effect.succeed([
								undefined,
								host.closed === true
									? Option.none()
									: Option.some({
											chat: {
												business: {
													...view.chat.business,
													[ChatHost.chatHostId]: { ...host, closed: true },
												},
											},
										}),
							] as const)
						},
					})
				}),
			)
		},
		Effect.scoped,
		inExecution,
	)
	/** Save the pause and its policy subject under the owner fence. Metered values come from saved calls. */
	const pause = Effect.fn("DelegationCommands.pause")(function* (
		fence: Fence,
		control: PolicyOrigin.Control,
	) {
		const saved = yield* load(fence)
		const origin = yield* policies.limit(fence, control)
		const receipt = yield* store.accept(
			fence.namespace,
			Execution.CommandKey.make(PolicyOrigin.controlId(fence, control)),
			{ actor: saved.execution.identity.actor, body: { control } },
			() =>
				Effect.gen(function* () {
					yield* StoredChats.lock(db, fence.namespace, origin.chat)
					return yield* store.commit(
						fence,
						{
							status: "waiting",
							events: [
								{
									_tag: "Checkpoint",
									resource: saved.execution.record.resource,
									revision: control.epoch,
								},
							],
						},
						Effect.gen(function* () {
							const current = yield* load(fence)
							const subject = yield* policies.limit(fence, control)
							yield* access.authorize(
								subject.originKey,
								subject.execution.identity.actor,
								"replay",
							)
							const chat = yield* StoredChats.ref(
								db,
								fence.namespace,
								subject.chat,
							)
							const host = Option.isSome(chat)
								? ChatHost.hostState(chat.value)
								: undefined
							if (
								current.stored.delegation.status !== "running" ||
								control.epoch !== (current.stored.limitEpoch ?? 0) + 1 ||
								host?.ownerExecutionId !== fence.id ||
								host.closed === true
							)
								return yield* Execution.Conflict.make({ id: fence.id })
							const now = yield* Clock.currentTimeMillis
							const usage = yield* metering.read(fence, now)
							const limits = current.stored.delegation.limits
							const reached =
								limits === undefined
									? Option.none()
									: Domain.reached(
											limits,
											usage,
											current.stored.window ?? noUsage,
										)
							if (Option.isNone(reached))
								return yield* Execution.Conflict.make({ id: fence.id })
							yield* metering.close(fence, now)
							const changed = yield* delegations.change(
								current.execution.identity.owner.organizationId,
								current.stored.delegation.id,
								["running"],
								(stored) => ({
									...Struct.omit(stored, ["runningSince"]),
									limitEpoch: control.epoch,
									limitTurnExecutionId: control.turnExecutionId,
									delegation: {
										...stored.delegation,
										status: "paused",
										usage,
										pause: { limit: reached.value, request: null, at: now },
									},
								}),
							)
							if (Option.isNone(changed))
								return yield* Execution.Conflict.make({ id: fence.id })
							return { executionId: fence.id, start: false }
						}),
					)
				}),
		)
		return { receipt, control }
	}, inExecution)
	/** The policy workflow calls this only after its saved check allows the work. */
	const resume = Effect.fn("DelegationCommands.resume")(function* (
		fence: Fence,
		control: PolicyOrigin.Control,
	) {
		const saved = yield* load(fence)
		const origin = yield* policies.limit(fence, control)
		return yield* store.accept(
			fence.namespace,
			Execution.CommandKey.make(
				`delegation-resume:${fence.id}:${control.epoch}`,
			),
			{ actor: saved.execution.identity.actor, body: { control } },
			() =>
				Effect.gen(function* () {
					yield* StoredChats.lock(db, fence.namespace, origin.chat)
					yield* store.lock(fence)
					const state = yield* store.get(fence)
					return yield* store.commit(
						fence,
						{
							...(state.status === "waiting"
								? { status: "running" as const }
								: {}),
							events: [
								{
									_tag: "Checkpoint",
									resource: saved.execution.record.resource,
									revision: control.epoch,
								},
							],
						},
						Effect.gen(function* () {
							const subject = yield* policies.currentLimit(fence, control)
							yield* access.authorize(
								subject.originKey,
								subject.execution.identity.actor,
								"replay",
							)
							const chat = yield* StoredChats.ref(
								db,
								fence.namespace,
								subject.chat,
							)
							if (
								Option.isNone(chat) ||
								ChatHost.hostState(chat.value).ownerExecutionId !== fence.id ||
								ChatHost.hostState(chat.value).closed === true
							)
								return yield* Execution.Conflict.make({ id: fence.id })
							const now = yield* Clock.currentTimeMillis
							const usage = yield* metering.read(fence, now)
							yield* metering.begin(fence, control.epoch, now)
							const changed = yield* delegations.change(
								saved.execution.identity.owner.organizationId,
								saved.stored.delegation.id,
								["paused"],
								(stored) => ({
									...stored,
									window: usage,
									delegation: {
										...Struct.omit(stored.delegation, ["pause"]),
										status: "running",
										usage,
									},
								}),
							)
							if (Option.isNone(changed))
								return yield* Execution.Conflict.make({ id: fence.id })
							const requestId = saved.stored.delegation.pause?.request
							if (requestId !== undefined && requestId !== null) {
								const request = yield* requests.find(
									saved.execution.identity.owner.organizationId,
									requestId,
								)
								if (
									Option.isNone(request) ||
									request.value.request.status !== "allowed"
								)
									return yield* Execution.Conflict.make({ id: fence.id })
								const reason = request.value.request.decision?.reason
								yield* inputs.submit(
									fence.namespace,
									Execution.CommandKey.make(
										`delegation-guidance:${fence.id}:${control.epoch}`,
									),
									{
										chat: subject.chat,
										identity: subject.execution.identity,
										content: Prompt.make(
											`[OpenBot] Your work reached a limit. The decision allows it to go on.${reason === undefined ? "" : ` ${reason}`}`,
										),
										queue: false,
										notice: { kind: "request", ref: requestId },
									},
								)
							}
							return { executionId: fence.id, start: false }
						}),
					)
				}),
		)
	}, inExecution)
	/** Read event cursors before state and usage. A change during the read stays visible. */
	const inspect = Effect.fn("DelegationCommands.inspect")(function* (
		fence: Fence,
	) {
		const snapshot = yield* metering.snapshot(fence)
		const saved = yield* load(fence)
		if (saved.execution.generation !== fence.generation)
			return yield* Execution.Conflict.make({ id: fence.id })
		if (
			saved.stored.delegation.status !== "running" ||
			saved.execution.record.status === "cancelling"
		)
			return { _tag: "Changed" } as const
		const chat = saved.stored.delegation.chat
		if (chat === null) return yield* Execution.Conflict.make({ id: fence.id })
		const found = yield* StoredChats.ref(db, fence.namespace, chat)
		if (Option.isNone(found))
			return yield* Execution.NotFound.make({ id: fence.id })
		const current = found.value
		const task = Arr.findFirst(
			snapshot.tasks,
			(task) => task.turn === current.turn?.id,
		)
		// A new Turn may have committed after the cursors were read.
		if (Option.isNone(task)) return { _tag: "Changed" } as const
		if (
			!snapshot.activeWork &&
			current.inbox.length === 0 &&
			current.turn !== undefined &&
			Turn.isTerminal(current.turn.status)
		) {
			const execution = yield* store.get(task.value.key)
			return {
				_tag: "Ended",
				task: task.value.key,
				result:
					execution.status === "completed" &&
					current.turn.status._tag === "Completed"
						? Option.some(current.turn.status.result.text)
						: Option.none<string>(),
			} as const
		}
		const limits = saved.stored.delegation.limits
		if (limits !== undefined) {
			const latest = yield* store.latestCalls(task.value.key)
			const pendingModel = Arr.some(
				latest,
				(call) =>
					call.retry === "read_only" &&
					call.status === "intended" &&
					Schema.is(Schema.Struct({ purpose: Schema.Literal("turn") }))(
						call.input,
					),
			)
			const wake =
				yield* sql`select 1 from openbot_execution_events where namespace = ${fence.namespace} and execution_id = ${fence.id} and event_key = ${`wake:limit:${saved.stored.limitEpoch ?? 0}:steps`} limit 1`
			const reached = Domain.reached(
				pendingModel || wake.length > 0
					? limits
					: Struct.omit(limits, ["steps"]),
				snapshot.usage,
				saved.stored.window ?? noUsage,
			)
			if (Option.isSome(reached))
				return {
					_tag: "Limit",
					control: {
						kind: "delegationLimit",
						turnExecutionId: task.value.key.id,
						epoch: (saved.stored.limitEpoch ?? 0) + 1,
					},
				} as const
		}
		return {
			_tag: "Wait",
			watch: snapshot.watch,
			...(limits === undefined || !snapshot.running
				? {}
				: {
						deadline:
							snapshot.at +
							Math.max(
								0,
								limits.timeMs -
									(snapshot.usage.timeMs -
										(saved.stored.window ?? noUsage).timeMs),
							),
					}),
		} as const
	}, storage)
	const view = Effect.fn("DelegationCommands.view")(function* (key: Key) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const initial = yield* store.loadMember(key)
				let owners: ReadonlyArray<Key> = [key]
				let current = key
				while (true) {
					const { ownerExecutionId } = yield* store.ownership(current)
					if (ownerExecutionId === undefined) break
					if (Arr.some(owners, (owner) => owner.id === ownerExecutionId))
						return yield* Execution.Forbidden.make({})
					current = yield* store.locate(
						ownerExecutionId,
						initial.identity.owner.organizationId,
					)
					owners = Arr.prepend(owners, current)
				}
				// Lock from the outer owner in. Both saved states and inherited pauses stay at one committed point.
				yield* Effect.forEach(owners, store.hold, { discard: true })
				const saved = yield* load(key)
				let delegation = saved.stored.delegation
				if (!Execution.isTerminal(saved.execution.record.status)) {
					for (const owner of owners) {
						if (owner.id === key.id) break
						const parent = yield* store.loadMember(owner)
						if (parent.record.resource.kind !== "Delegation") continue
						const found = yield* delegations.find(
							parent.identity.owner.organizationId,
							parent.record.resource.id,
						)
						if (Option.isNone(found)) return yield* Execution.Forbidden.make({})
						const pause = found.value.delegation.pause
						if (
							found.value.delegation.status !== "paused" ||
							pause === undefined
						)
							continue
						delegation = {
							...delegation,
							status: "paused",
							pause: {
								limit: pause.limit,
								at: pause.at,
								request: null,
								delegation: found.value.delegation.id,
							},
						}
						break
					}
				}
				return Domain.ExecutionView.make({
					delegation: { ...delegation, usage: yield* metering.read(key) },
					executionId: key.id,
					status: saved.execution.record.status,
					failure: saved.execution.record.failure,
				})
			}),
		)
	}, storage)
	const phase = (fence: Fence, status: "running" | "waiting") =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					yield* store.lock(fence)
					const saved = yield* load(fence)
					if (
						saved.execution.generation !== fence.generation ||
						(saved.execution.record.status !== "running" &&
							saved.execution.record.status !== "waiting")
					)
						return yield* Execution.Conflict.make({ id: fence.id })
					if (saved.execution.record.status !== status)
						yield* store.commit(fence, { status }, Effect.void)
				}),
			)
			.pipe(storage)
	const decide: Decide = () => Effect.fail(Execution.Forbidden.make({}))
	return DelegationCommands.of({
		submit,
		cancel,
		load,
		authorize,
		start,
		task,
		finish,
		close,
		view,
		inspect,
		pause,
		resume,
		stopLimit: (fence: Fence, control: PolicyOrigin.Control) =>
			store.commit(
				fence,
				{},
				Effect.gen(function* () {
					const saved = yield* load(fence)
					yield* policies.currentLimit(fence, control)
					return yield* store.cancel(
						fence,
						Execution.CommandKey.make(
							`delegation-stop:${fence.id}:${control.epoch}`,
						),
						saved.execution.identity.actor,
					)
				}),
			),
		phase,
		decide,
	})
})

export const layer = Layer.effect(DelegationCommands, make)
