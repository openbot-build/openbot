import type { DelegationId } from "@openbot-build/domain/DelegationId"
import type { Caller } from "@openbot-build/domain/Identity"
import type { Delegations, Execution } from "@openbot-build/domain"
import { Context, type Effect } from "effect"

/** A delegation with the state of its execution. */
export type DelegationHistory = Delegations.Delegation & {
	readonly executionId: Execution.Id
	readonly executionStatus: Execution.Status
	readonly failure: Execution.Failure | null
}

/**
 * Reads delegated work for a person. The saved business record and the
 * execution record have one permission check.
 */
export class DelegationQueries extends Context.Service<
	DelegationQueries,
	{
		readonly read: (
			caller: Caller,
			id: DelegationId,
		) => Effect.Effect<
			DelegationHistory,
			| Delegations.DelegationConflict
			| Delegations.DelegationNotFound
			| Delegations.DelegationStorageUnavailable
			| Execution.Forbidden
			| Execution.NotFound
			| Execution.StorageError
		>
	}
>()("@openbot-build/conversation-contract/bots/DelegationQueries") {}
