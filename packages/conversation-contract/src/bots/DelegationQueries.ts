import type { Caller, Delegations, Execution } from "@openbot-build/domain"
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
			id: Delegations.DelegationId,
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
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
>()("@openbot-build/openbot/conversation-contract/bots/DelegationQueries") {}
