import type { Check as CheckType } from "@openbot-build/server-execution/execution/Admission"
import { Chat, type Config } from "@openbot-build/core"
import {
	Caller,
	Execution,
	type ExecutionIdentity,
} from "@openbot-build/domain"
import { Context, Effect } from "effect"
import type { Authorize } from "@openbot-build/server-execution/execution/Engine"
import { type Key } from "@openbot-build/server-execution/execution/Store"

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
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
	"@openbot-build/openbot/conversation-contract/chats/TurnAccess",
) {}

export { type Failure }
