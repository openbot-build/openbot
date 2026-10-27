import { Chat, ChatStore, type Turn } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { Effect } from "effect"
import type { Calls } from "../execution/Calls.ts"
import type { Database } from "../database/Database.ts"
import type { Fence, Store } from "../execution/Store.ts"
import { databaseError } from "./ChatEncoding.ts"
import * as StoredChats from "./StoredChats.ts"

/** A Turn may write only while it holds its execution and is current in its Chat. */
export const make = (
	db: Database,
	executions: typeof Store.Service,
	calls: typeof Calls.Service,
	input: {
		readonly fence: Fence
		readonly chat: Chat.Id
		readonly turn: Turn.Id
	},
): ChatStore.Persistence => {
	const { fence, chat, turn } = input
	const conflict = Effect.fail(Execution.Conflict.make({ id: fence.id }))
	return {
		...StoredChats.persistence(db, fence.namespace),
		save: (delta) =>
			db
				.transaction(() =>
					Effect.gen(function* () {
						if (delta.chat !== chat) return yield* conflict
						yield* StoredChats.lock(db, fence.namespace, chat)
						// Saved outside results can arrive during a pause. State waits for its owner.
						yield* calls.admission(fence, true)
						const execution = yield* executions.get(fence)
						if (
							execution.resource.kind !== "Turn" ||
							execution.resource.id !== turn
						)
							return yield* conflict
						yield* executions.commit(
							fence,
							{
								events: [
									{
										_tag: "Checkpoint",
										resource: { kind: "Chat", id: chat },
										revision: delta.revision,
									},
								],
							},
							StoredChats.save(db, fence.namespace, delta, turn),
						)
					}),
				)
				.pipe(calls.stopOnPause, Effect.mapError(databaseError)),
		// Removing a Chat is an application command, never a step of its Turn.
		remove: () => conflict.pipe(Effect.mapError(databaseError)),
	}
}
