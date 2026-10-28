import {
	type MemberExecution,
	Store,
	storage,
	type Fence,
	type Key,
} from "../execution/Store.ts"
import type { Check } from "../execution/Admission.ts"
import {
	type TokenId,
	type BotId,
	type DelegationId,
	type ToolExecution,
	type ChatKind,
	type PlanApproval,
	type Settings as SettingsData,
	CodeRuns,
	Execution,
	Vaults as VaultDomain,
} from "@openbot-build/domain"
import type { Chat, Config, Turn } from "@openbot-build/core"
import type { Prompt } from "effect/ai"
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
import { Hex } from "effect/encoding"
import { SqlClient } from "effect/sql"
import * as CallFrame from "../chats/CallFrame.ts"
import * as StoredChats from "../chats/StoredChats.ts"
import * as ToolOrigins from "../chats/ToolOrigins.ts"
import { TurnAccess } from "../chats/TurnAccess.ts"
import * as Db from "../database/Database.ts"
import { codeExecutions } from "../database/ExecutionSchema.ts"
import { type Authorize, type Decide } from "../execution/Engine.ts"
import { codeModeOf } from "../settings/Documents.ts"
import { Settings } from "../settings/Settings.ts"

export const workflowName = "openbot.code"
export const programStep = "program"
export const Input = Schema.Struct({
	code: CodeRuns.Code,
	reason: Schema.String,
	bindings: Schema.Array(CodeRuns.Binding),
	vault: Schema.Array(VaultDomain.ReferenceBinding),
})
export type Input = typeof Input.Type
const Saved = Schema.Struct({
	...Input.fields,
	site: Execution.CallSite,
	seed: Schema.Natural,
	clock: Schema.Finite,
	limits: Schema.Struct({
		timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
		memoryBytes: Schema.Int.check(Schema.isGreaterThan(0)),
		outputBytes: Schema.Int.check(Schema.isGreaterThan(0)),
	}),
})
const codec = Schema.toCodecJson(Saved)
const outputCodec = Schema.toCodecJson(CodeRuns.Output)

export interface Service {
	readonly admit: Check
	readonly submit: (
		source: Fence,
		site: Execution.CallSite,
		input: Input,
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly load: (key: Key) => Effect.Effect<
		{
			execution: MemberExecution
			input: typeof Saved.Type
			origin: {
				key: { namespace: string; id: Execution.Id }
				execution: MemberExecution
				child: {
					record: {
						readonly id: ToolExecution.Id
						readonly executionId: Execution.Id
						readonly parentExecutionId: Execution.Id
						readonly position: ToolExecution.Position
						readonly callId: string
						readonly tool: string
						readonly status: Execution.Status
						readonly detached: boolean
						readonly startedAt: number
						readonly deadline: number
						readonly failure: Execution.Failure | null
					}
					input: {
						readonly position: ToolExecution.Position
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
							readonly host: {
								readonly bot: BotId
								readonly kind: ChatKind
								readonly parent?: {
									readonly chat: Chat.Id
									readonly delegation: DelegationId
								}
								readonly ownerExecutionId?: Execution.Id
								readonly inputConstraints?: readonly (
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
								readonly chain: {
									readonly organizationId: string
									readonly userId: string
									readonly tokenId?: TokenId
									readonly owner?: string
									readonly bots: readonly BotId[]
									readonly chats: readonly Chat.Id[]
								}
								readonly review?: string
								readonly closed?: boolean
								readonly control?: Execution.Id
								readonly trigger?: string
								readonly channel?: {
									readonly channel: string
									readonly conversation: string
									readonly group?: boolean
								}
								readonly title?: string
								readonly planApproval?: PlanApproval.PlanApproval
							}
							readonly settings: {
								readonly mode: "build" | "plan"
								readonly model?: Config.Selection
							}
							readonly prompt: Prompt.Prompt
							readonly action?: {
								readonly name: string
								readonly arguments: { readonly [x: string]: Schema.Json }
								readonly source?: { readonly [x: string]: Schema.Json }
							}
						}
					}
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
				}
				toolKey: Key
				path: ReadonlyArray<string>
			}
			id: CodeRuns.CodeRunId
		},
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly authorize: Authorize
	readonly decide: Decide
	readonly enabled: Effect.Effect<
		{ timeoutMs: number; memoryBytes: number; outputBytes: number },
		Execution.Forbidden | SettingsData.SettingsUnavailable
	>
	readonly result: (
		key: Key,
	) => Effect.Effect<Option.Option<CodeRuns.Output>, Execution.StorageError>
	readonly view: (key: Key) => Effect.Effect<
		{
			id: CodeRuns.CodeRunId
			executionId: Execution.Id
			chat: Chat.Id
			turn: Turn.Id
			callId: string
			code: string
			reason: string
			status: Execution.Status
			failure: Execution.Failure | null
			result: CodeRuns.Output | null
			createdAt: number
			updatedAt: number
		},
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
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
	readonly finish: (
		fence: Fence,
		end:
			| { readonly status: "completed" }
			| { readonly status: "failed"; readonly failure: Execution.Failure }
			| { readonly status: "cancelled"; readonly epoch: number },
	) => Effect.Effect<
		undefined,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
}

export class CodeCommands extends Context.Service<CodeCommands, Service>()(
	"@openbot-build/openbot/code/CodeCommands",
) {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const access = yield* TurnAccess
	const frames = yield* CallFrame.make
	const origins = yield* ToolOrigins.make
	const settings = yield* Settings
	const crypto = yield* Crypto.Crypto
	const enabled = Effect.gen(function* () {
		const platform = yield* settings.platform
		if (Option.isNone(platform)) return yield* Execution.Forbidden.make({})
		const limits = codeModeOf(platform.value.document)
		if (!limits.enabled) return yield* Execution.Forbidden.make({})
		return {
			timeoutMs: limits.timeoutMs,
			memoryBytes: limits.memoryMb * 1024 * 1024,
			outputBytes: limits.outputBytes,
		}
	})
	const load = Effect.fn("CodeCommands.load")(function* (key: Key) {
		const execution = yield* store.loadMember(key)
		const row = Arr.head(
			yield* db
				.select()
				.from(codeExecutions)
				.where(
					and(
						eq(codeExecutions.namespace, key.namespace),
						eq(codeExecutions.executionId, key.id),
					),
				),
		)
		if (Option.isNone(row))
			return yield* Execution.NotFound.make({ id: key.id })
		const input = yield* Schema.decodeEffect(codec)(execution.input)
		const origin = yield* origins.find(key)
		if (
			execution.workflow !== workflowName ||
			execution.record.resource.kind !== "CodeRun" ||
			execution.record.resource.id !== row.value.id ||
			Option.isNone(origin) ||
			input.site.main !== origin.value.child.record.callId ||
			!Schema.toEquivalence(Schema.Array(Schema.String))(
				input.site.path,
				origin.value.path,
			)
		)
			return yield* Execution.Forbidden.make({})
		return {
			execution,
			input,
			origin: origin.value,
			id: CodeRuns.CodeRunId.make(row.value.id),
		}
	}, storage)
	const authorize: Authorize = (key, actor, mode) =>
		load(key).pipe(Effect.andThen(access.authorize(key, actor, mode)))
	const submit = Effect.fn("CodeCommands.submit")(function* (
		source: Fence,
		site: Execution.CallSite,
		input: Input,
	) {
		const frame = yield* frames.read(source, site)
		const origin = yield* origins.find(source)
		if (Option.isNone(origin)) return yield* Execution.Forbidden.make({})
		if (
			Arr.dedupe(Arr.map(input.bindings, (binding) => binding.alias)).length !==
				input.bindings.length ||
			Arr.some(
				input.bindings,
				(binding) => binding.source.definition === undefined,
			)
		)
			return yield* Execution.Conflict.make({ id: source.id })
		const path = yield* Schema.encodeEffect(
			Schema.fromJsonString(Schema.Array(Schema.String)),
		)([origin.value.toolKey.id, site.main, ...site.path])
		const hash = Hex.encode(
			yield* crypto.digest("SHA-256", new TextEncoder().encode(path)),
		)
		return yield* store.accept(
			source.namespace,
			Execution.CommandKey.make(`code:${hash}`),
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
					return yield* store.commit(
						source,
						{
							events: (child) => [
								{
									_tag: "ChildExecution",
									executionId: child.executionId,
									step: `code:${hash}`,
								},
							],
						},
						Effect.gen(function* () {
							const limits = yield* enabled
							const id = CodeRuns.CodeRunId.make(yield* crypto.randomUUIDv4())
							const key = yield* create({
								workflow: workflowName,
								...(yield* store.ownership(source)),
								resource: { kind: "CodeRun", id },
								identity: frame.identity,
								input: yield* Schema.encodeEffect(codec)({
									...input,
									site,
									limits,
									seed: yield* crypto.randomIntBetween(0, 2 ** 31, {
										halfOpen: true,
									}),
									clock: yield* Clock.currentTimeMillis,
								}),
							})
							yield* origins.attach(source, key, site)
							yield* db.insert(codeExecutions).values({
								namespace: key.namespace,
								executionId: key.id,
								sourceExecutionId: source.id,
								id,
							})
							return { executionId: key.id, start: true }
						}),
					)
				}),
		)
	}, storage)
	const result = Effect.fn("CodeCommands.result")(function* (key: Key) {
		const call = Arr.findFirst(
			yield* store.calls(key),
			(call) => call.step === programStep && call.attempt === 0,
		)
		if (Option.isNone(call) || call.value.status !== "completed")
			return Option.none<CodeRuns.Output>()
		return Option.some(
			yield* Schema.decodeEffect(outputCodec)(call.value.result),
		)
	}, storage)
	const view = Effect.fn("CodeCommands.view")(function* (key: Key) {
		const saved = yield* load(key)
		const record = saved.execution.record
		return {
			id: saved.id,
			executionId: key.id,
			chat: saved.origin.child.record.position.chat,
			turn: saved.origin.child.record.position.turn,
			callId: saved.input.site.main,
			code: saved.input.code,
			reason: saved.input.reason,
			status: record.status,
			failure: record.failure,
			result: Option.getOrNull(yield* result(key)),
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
		} satisfies Omit<CodeRuns.ExecutionView, "calls">
	}, storage)
	const phase = Effect.fn("CodeCommands.phase")(function* (
		fence: Fence,
		status: "running" | "waiting",
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* store.lock(fence)
				const saved = yield* store.loadMember(fence)
				if (
					saved.generation !== fence.generation ||
					(saved.record.status !== "running" &&
						saved.record.status !== "waiting")
				)
					return yield* Execution.Conflict.make({ id: fence.id })
				if (saved.record.status !== status)
					yield* store.commit(fence, { status }, Effect.void)
			}),
		)
	}, storage)
	const finish = Effect.fn("CodeCommands.finish")(function* (
		fence: Fence,
		end:
			| { readonly status: "completed" }
			| { readonly status: "failed"; readonly failure: Execution.Failure }
			| { readonly status: "cancelled"; readonly epoch: number },
	) {
		const saved = yield* load(fence)
		const events = [
			{ _tag: "Result" as const, resource: saved.execution.record.resource },
		]
		if (end.status === "cancelled")
			yield* store.finishCancellation(fence, end.epoch, (status) =>
				Effect.succeed(status === "outcome_unknown" ? [] : events),
			)
		else {
			if (end.status === "completed" && Option.isNone(yield* result(fence)))
				return yield* Execution.Conflict.make({ id: fence.id })
			yield* store.commit(
				fence,
				{
					status: end.status,
					events,
					...(end.status === "failed" ? { failure: end.failure } : {}),
				},
				Effect.void,
			)
		}
	}, storage)
	// App and approval children own their decisions. A Code execution has no separate approval channel.
	const decide: Decide = () => Effect.fail(Execution.Forbidden.make({}))
	return CodeCommands.of({
		admit: access.admit,
		submit,
		load,
		authorize,
		decide,
		enabled,
		result,
		view,
		phase,
		finish,
	})
})

export const layer = Layer.effect(CodeCommands, make)
