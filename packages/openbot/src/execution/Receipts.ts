import { Execution } from "@openbot-build/domain"
import { Effect } from "effect"
import type { Store } from "./Store.ts"

/** Read command-local input IDs from its committed checkpoint, without replaying a command. */
export const withInputItems = (
	store: Store["Service"],
	namespace: string,
	receipt: Execution.Receipt,
) =>
	Effect.gen(function* () {
		const events = yield* store.events(
			{ namespace, id: receipt.executionId },
			receipt.sequence - 1,
		)
		const event = events[0]
		return event?.sequence === receipt.sequence &&
			event.body._tag === "Checkpoint" &&
			event.body.inputItems !== undefined
			? { ...receipt, inputItems: event.body.inputItems }
			: receipt
	})
