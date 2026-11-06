import type { DelegationId } from "@openbot-build/domain/DelegationId"
import type { Caller } from "@openbot-build/domain/Identity"
import { Delegations as Domain } from "@openbot-build/domain"
import { Effect, Layer, Option } from "effect"
import * as Failures from "@openbot-build/server-kernel/Failures"
import { Store } from "@openbot-build/server-execution/Store"
import { Commands } from "@openbot-build/server-execution/Commands"
import { DelegationCommands } from "./DelegationCommands.ts"
import { Delegations } from "@openbot-build/conversation-contract/bots/Delegations"
import { DelegationQueries } from "@openbot-build/conversation-contract/bots/DelegationQueries"

/** Saved business records and execution records have one permission check. */
export const make = Effect.gen(function* () {
	const records = yield* Delegations
	const work = yield* DelegationCommands
	const commands = yield* Commands
	const store = yield* Store
	const locate = Effect.fn("DelegationQueries.locate")(function* (
		caller: Caller,
		id: DelegationId,
	) {
		const found = yield* records
			.find(caller.organizationId, id)
			.pipe(
				Failures.replace("The work could not be read.", () =>
					Domain.DelegationStorageUnavailable.make({}),
				),
			)
		if (
			Option.isNone(found) ||
			(found.value.userId !== caller.userId &&
				found.value.chain.userId !== caller.userId)
		)
			return yield* Domain.DelegationNotFound.make({ delegation: id })
		const key = yield* store.locate(
			found.value.executionId,
			caller.organizationId,
		)
		yield* work.authorize(key, caller, "read")
		return key
	})
	const read = Effect.fn("DelegationQueries.read")(function* (
		caller: Caller,
		id: DelegationId,
	) {
		const saved = yield* work.view(yield* locate(caller, id))
		return {
			...saved.delegation,
			executionId: saved.executionId,
			executionStatus: saved.status,
			failure: saved.failure,
		}
	})
	const cancel = Effect.fn("DelegationQueries.cancel")(function* (
		caller: Caller,
		id: DelegationId,
		commandKey: Parameters<typeof commands.cancel>[2],
	) {
		return yield* commands.cancel(
			(yield* locate(caller, id)).id,
			caller,
			commandKey,
		)
	})
	return { read, cancel }
})

/** Gives `DelegationQueries` to the features that show delegated work. */
export const layer = Layer.effect(
	DelegationQueries,
	Effect.map(make, (queries) => DelegationQueries.of({ read: queries.read })),
)
