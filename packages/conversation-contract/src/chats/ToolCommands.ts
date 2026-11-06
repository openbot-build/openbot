import type { TokenId } from "@openbot-build/domain/TokenId"
import type { BotId } from "@openbot-build/domain/BotId"
import type { DelegationId } from "@openbot-build/domain/DelegationId"
import { Execution, ToolExecution } from "@openbot-build/domain"
import type { Check } from "@openbot-build/server-execution/Admission"
import * as DecisionWait from "@openbot-build/server-execution/DecisionWait"
import { type Definition } from "@openbot-build/tools-contract/ToolDefinitions"
import * as ToolRecords from "./ToolRecords.ts"
import { Chat, type Operations } from "@openbot-build/core"
import { Context, Duration, Effect, Schema } from "effect"
import { Prompt } from "effect/ai"
import { type Authorize } from "@openbot-build/server-execution/Engine"
import { type Fence, type Key } from "@openbot-build/server-execution/Store"

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
	"@openbot-build/conversation-contract/chats/ToolCommands",
) {}
