import { Array as Arr, Effect, Layer } from "effect"
import { OpenWork } from "../chats/OpenWork.ts"
import { Requests } from "../capabilities/Requests.ts"
import { Reminders } from "../plugins/work/Reminders.ts"
import { Delegations, isOpen } from "./Delegations.ts"

/** Counts the delegations, requests and reminders of a Chat that have not ended. */
export const layer = Layer.effect(
	OpenWork,
	Effect.gen(function* () {
		const delegations = yield* Delegations
		const requests = yield* Requests
		const reminders = yield* Reminders
		return OpenWork.of({
			count: (organizationId, chat) =>
				Effect.all({
					delegations: delegations
						.forChat(organizationId, chat)
						.pipe(Effect.map((list) => Arr.filter(list, isOpen).length)),
					requests: requests
						.forChat(organizationId, chat)
						.pipe(
							Effect.map(
								(list) =>
									Arr.filter(
										list,
										(stored) => stored.request.status === "pending",
									).length,
							),
						),
					reminders: reminders
						.forChat(organizationId, chat)
						.pipe(Effect.map((list) => list.length)),
				}),
		})
	}),
)
