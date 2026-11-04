import * as MemoryLogs from "../plugin-bots/MemoryLogs.ts"
import { Layer } from "effect"
import * as TurnContext from "../plugin-chats/TurnContext.ts"
import * as Grants from "../plugin-capabilities/Grants.ts"
import * as Requests from "../plugin-capabilities/Requests.ts"
import * as Rules from "../plugin-capabilities/Rules.ts"
import * as BotMemories from "../plugin-bots/BotMemories.ts"
import * as MemoryBot from "../plugin-bots/MemoryBot.ts"
import * as Reminders from "../plugin-work/Reminders.ts"
import * as OpenWorkCount from "../plugin-bots/OpenWorkCount.ts"
import * as BotRecords from "../plugin-bots/BotRecords.ts"
import * as Bots from "../plugin-bots/Bots.ts"
import * as Delegations from "../plugin-bots/Delegations.ts"

/**
 * The Bot services: records, Bots, memory, delegations, Grants, Rules and requests.
 * Turn workflows build tools, policy checks and approvals in their scopes.
 */
export const layer = TurnContext.layer.pipe(
	Layer.provideMerge(OpenWorkCount.layer),
	Layer.provideMerge(Reminders.layer),
	Layer.provideMerge(Requests.layer),
	Layer.provideMerge(MemoryBot.layer),
	Layer.provideMerge(
		Layer.mergeAll(
			Grants.layer,
			Rules.layer,
			Delegations.layer,
			BotMemories.layer,
			Bots.layer,
		),
	),
	Layer.provideMerge(Layer.merge(BotRecords.layer, MemoryLogs.layer)),
)
