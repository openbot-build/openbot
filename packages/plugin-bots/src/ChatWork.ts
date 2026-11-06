import type { Chat } from "@openbot-build/core"
import { Array as Arr, Effect } from "effect"
import { Requests } from "@openbot-build/conversation-contract/capabilities/Requests"
import { Reminders } from "@openbot-build/conversation-contract/work/Reminders"
import { Delegations } from "@openbot-build/conversation-contract/bots/Delegations"
import { isOpen } from "./Delegations.ts"

/** The Chat count and the model prompt read the same work that can still return. */
export const make = Effect.gen(function* () {
	const delegations = yield* Delegations
	const requests = yield* Requests
	const reminders = yield* Reminders
	const read = Effect.fn("ChatWork.read")(function* (
		organizationId: string,
		chat: Chat.Id,
	) {
		return yield* Effect.all({
			delegations: delegations
				.forChat(organizationId, chat)
				.pipe(Effect.map(Arr.filter(isOpen))),
			requests: requests
				.forChat(organizationId, chat)
				.pipe(
					Effect.map(
						Arr.filter((stored) => stored.request.status === "pending"),
					),
				),
			reminders: reminders.forChat(organizationId, chat),
		})
	})
	return { read }
})
