import type { Check as CheckType } from "../../server-execution/execution/Admission.ts"
import { Chat, type Config } from "@openbot-build/core"
import {
	Caller,
	Execution,
	type ExecutionIdentity,
} from "@openbot-build/domain"
import { Context, Effect } from "effect"
import type { Authorize } from "../../server-execution/execution/Engine.ts"
import { type Key } from "../../server-execution/execution/Store.ts"

type Failure = Execution.Forbidden | Execution.NotFound | Execution.StorageError

/** Turn commands and restored steps use the same current resource policy. */
export interface Service {
	readonly admit: CheckType
	readonly input: (
		chat: Chat.Ref,
		identity: ExecutionIdentity,
	) => Effect.Effect<void, Failure>
	readonly command: (
		chat: Chat.Ref,
		caller: Caller,
	) => Effect.Effect<void, Failure>
	readonly authorize: Authorize
	readonly model: (
		key: Key,
		selection: Config.Selection,
	) => Effect.Effect<void, Failure>
	readonly notice: (
		chat: Chat.Ref,
		identity: ExecutionIdentity,
	) => Effect.Effect<boolean, Failure>
}

export class TurnAccess extends Context.Service<TurnAccess, Service>()(
	"@openbot-build/openbot/conversation-contract/chats/TurnAccess",
) {}

export { type Failure }
