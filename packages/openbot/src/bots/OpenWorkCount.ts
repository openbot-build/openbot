import { Effect, Layer } from "effect"
import { OpenWork } from "../chats/OpenWork.ts"
import * as ChatWork from "./ChatWork.ts"

/** Counts work that can still send a result to this Chat. */
export const layer = Layer.effect(
	OpenWork,
	Effect.gen(function* () {
		const work = yield* ChatWork.make
		return OpenWork.of({
			count: (organizationId, chat) =>
				work.read(organizationId, chat).pipe(
					Effect.map((work) => ({
						delegations: work.delegations.length,
						requests: work.requests.length,
						reminders: work.reminders.length,
					})),
				),
		})
	}),
)
