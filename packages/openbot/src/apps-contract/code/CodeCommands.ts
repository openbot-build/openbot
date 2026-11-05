import {
	type MemberExecution,
	type Fence,
	type Key,
} from "@openbot-build/server-execution/execution/Store"
import type { Check } from "@openbot-build/server-execution/execution/Admission"
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
import { Context, Effect, Option, Schema } from "effect"
import {
	type Authorize,
	type Decide,
} from "@openbot-build/server-execution/execution/Engine"

export const workflowName = "openbot.code"

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
	"@openbot-build/openbot/apps-contract/code/CodeCommands",
) {}

export { Saved }
