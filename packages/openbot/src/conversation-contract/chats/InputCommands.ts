import { type ChatStore, Chat, Item, Turn } from "@openbot-build/core"
import { type SqlError } from "effect/sql"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import type { SecretStorageError } from "../../server-kernel/secrets/Secrets.ts"
import { Definition } from "../../tools-contract/chats/ToolDefinitions.ts"
import { Caller, Execution, ExecutionIdentity } from "@openbot-build/domain"
import { Context, Effect, Option, Schema } from "effect"
import { type Fence } from "../../server-execution/execution/Store.ts"

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
	"@openbot-build/openbot/conversation-contract/chats/InputCommands",
) {}
