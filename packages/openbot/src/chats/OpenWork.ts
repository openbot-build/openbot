import type { Chat } from "@openbot-build/core"
import type { OpenWork as OpenWorkView } from "@openbot-build/api"
import { Context, Effect, Layer } from "effect"

/**
 * Counts the work of a Chat that has not ended yet: delegations, requests and reminders.
 * The parts of OpenBot that keep this work provide it.
 */
export class OpenWork extends Context.Service<
	OpenWork,
	{
		readonly count: (
			organizationId: string,
			chat: Chat.Id,
		) => Effect.Effect<OpenWorkView>
	}
>()("@openbot-build/openbot/chats/OpenWork") {}

export const none: OpenWorkView = { delegations: 0, requests: 0, reminders: 0 }

/** For hosts that keep no such work, such as tests of the Chats alone. */
export const layerNone = Layer.succeed(OpenWork, {
	count: () => Effect.succeed(none),
})
