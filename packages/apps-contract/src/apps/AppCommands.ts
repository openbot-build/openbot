import { Caller } from "@openbot-build/domain/Identity"
import type { BotId } from "@openbot-build/domain/BotId"
import type { ChatKind } from "@openbot-build/domain/Chats"
import type { DelegationId } from "@openbot-build/domain/DelegationId"
import type { TokenId } from "@openbot-build/domain/TokenId"
import {
	type MemberExecution,
	type Fence,
	type Key,
} from "@openbot-build/server-execution/Store"
import type { Check } from "@openbot-build/server-execution/Admission"
import {
	type ToolExecution,
	type PlanApproval,
	AppCalls,
	CodeRuns,
	Execution,
	Vaults,
} from "@openbot-build/domain"
import type { Chat, Config } from "@openbot-build/core"
import type { Prompt } from "effect/ai"
import { Context, Effect, Option, Schema } from "effect"
import {
	type Authorize,
	type Decide,
} from "@openbot-build/server-execution/Engine"
import * as AppCall from "./AppCall.ts"

export const workflowName = "openbot.app-call"

export const Input = Schema.Struct({
	source: AppCalls.Source,
	arguments: Schema.JsonObject,
	toolName: Schema.String,
	reason: Schema.String,
	code: Schema.optionalKey(CodeRuns.RequestCode),
	vault: Schema.optionalKey(Schema.Array(Vaults.ReferenceBinding)),
})

export type Input = typeof Input.Type

const Saved = Schema.Struct({
	...Input.fields,
	site: Execution.CallSite,
	readOnly: Schema.Boolean,
})

const Response = Schema.Struct({ actor: Caller, responses: Schema.JsonObject })

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
								readonly inputConstraints?: readonly Caller[]
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
						readonly actor: Caller
						readonly constraints?: readonly Caller[]
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
			id: AppCalls.AppOperationId
			sourceKey: { namespace: string; id: Execution.Id }
		},
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly authorize: Authorize
	readonly current: (key: Key) => Effect.Effect<
		| {
				_tag: "Send"
				input: AppCall.Input
				call: Option.Option<Execution.Call>
				answer: Option.Option<typeof Response.Type>
				result?: never
				round?: never
				request?: never
		  }
		| {
				input?: never
				answer?: never
				_tag: "Done"
				round: number
				result:
					| { readonly _tag: "Completed"; readonly result: Schema.Json }
					| { readonly _tag: "Failed"; readonly failure: Execution.Failure }
				call: Execution.Call
				request?: never
		  }
		| {
				input?: never
				answer?: never
				result?: never
				_tag: "Input"
				round: number
				request: { readonly [x: string]: Schema.Json }
				call: Execution.Call
		  },
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly view: (
		key: Key,
	) => Effect.Effect<
		AppCalls.ExecutionView,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly first: (key: Key) => Effect.Effect<
		{
			id: AppCalls.AppOperationId
			execution: Execution.Record
			outcome: Option.Option<AppCalls.Outcome>
		},
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly respond: (
		key: Key,
		actor: Caller,
		commandKey: Execution.CommandKey,
		round: number,
		responses: Schema.JsonObject,
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly decide: Decide
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
	readonly waitInput: (
		fence: Fence,
		round: number,
	) => Effect.Effect<
		boolean,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly finish: (
		fence: Fence,
		end:
			| { readonly status: "completed" | "interrupted" }
			| { readonly status: "failed"; readonly failure: Execution.Failure }
			| { readonly status: "cancelled"; readonly epoch: number },
	) => Effect.Effect<
		Execution.Record,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
}

export class AppCommands extends Context.Service<AppCommands, Service>()(
	"@openbot-build/apps-contract/apps/AppCommands",
) {}

export { Saved, Response }
