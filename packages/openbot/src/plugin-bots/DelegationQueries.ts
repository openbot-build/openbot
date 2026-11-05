import { type Caller, Delegations as Domain } from "@openbot-build/domain"
import { Effect, Layer, Option } from "effect"
import * as Failures from "@openbot-build/server-kernel/errors/Failures"
import * as Imported from "@openbot-build/server-execution/imported/Executions"
import { ImportedRecords } from "@openbot-build/server-execution/imported/ImportedRecords"
import { Store } from "@openbot-build/server-execution/execution/Store"
import { Commands } from "@openbot-build/server-execution/execution/Commands"
import { DelegationCommands } from "./DelegationCommands.ts"
import { Delegations } from "../conversation-contract/bots/Delegations.ts"
import { DelegationQueries } from "../conversation-contract/bots/DelegationQueries.ts"

/** Saved business records and execution records have one permission check. */
export const make = Effect.gen(function* () {
	const records = yield* Delegations
	const work = yield* DelegationCommands
	const commands = yield* Commands
	const store = yield* Store
	const imported = yield* ImportedRecords
	const locate = Effect.fn("DelegationQueries.locate")(function* (
		caller: Caller,
		id: Domain.DelegationId,
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
		if (found.value.executionId === undefined)
			return yield* Domain.DelegationConflict.make({
				message: "The work has no execution.",
			})
		const key = yield* store.locate(
			found.value.executionId,
			caller.organizationId,
		)
		const saved = yield* store.load(key)
		if (saved.workflow === Imported.workflowName) {
			const { input } = yield* imported.read(key, caller)
			if (
				saved.record.resource.kind !== "Delegation" ||
				saved.record.resource.id !== id ||
				input.owner.userId !== found.value.userId ||
				saved.context?.kind !== "Chat" ||
				saved.context.id !== found.value.delegation.parent.chat
			)
				return yield* Domain.DelegationConflict.make({
					message: "The old work does not match its execution.",
				})
			return {
				key,
				history: {
					...found.value.delegation,
					executionId: key.id,
					executionStatus: saved.record.status,
					failure: saved.record.failure,
				},
			}
		}
		yield* work.authorize(key, caller, "read")
		return { key, history: undefined }
	})
	const read = Effect.fn("DelegationQueries.read")(function* (
		caller: Caller,
		id: Domain.DelegationId,
	) {
		const found = yield* locate(caller, id)
		if (found.history !== undefined) return found.history
		const saved = yield* work.view(found.key)
		return {
			...saved.delegation,
			executionId: saved.executionId,
			executionStatus: saved.status,
			failure: saved.failure,
		}
	})
	const cancel = Effect.fn("DelegationQueries.cancel")(function* (
		caller: Caller,
		id: Domain.DelegationId,
		commandKey: Parameters<typeof commands.cancel>[2],
	) {
		return yield* commands.cancel(
			(yield* locate(caller, id)).key.id,
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
