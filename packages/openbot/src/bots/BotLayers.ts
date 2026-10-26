import { Layer } from "effect"
import * as Gate from "../capabilities/Gate.ts"
import * as Grants from "../capabilities/Grants.ts"
import * as Judge from "../capabilities/Judge.ts"
import * as Requests from "../capabilities/Requests.ts"
import * as Rules from "../capabilities/Rules.ts"
import * as BotMemories from "./BotMemories.ts"
import * as MemoryBot from "./MemoryBot.ts"
import * as BotPlugin from "../plugins/bots/BotPlugin.ts"
import * as WorkPlugin from "../plugins/work/WorkPlugin.ts"
import * as Reminders from "../plugins/work/Reminders.ts"
import * as Approvals from "../capabilities/Approvals.ts"
import * as OpenWorkCount from "./OpenWorkCount.ts"
import * as BotRecords from "./BotRecords.ts"
import * as Bots from "./Bots.ts"
import * as Delegations from "./Delegations.ts"
import * as Limits from "./Limits.ts"
import * as Signals from "./Signals.ts"

/**
 * The Bot services: records, Bots, memory, delegations and their limits, Grants, Rules, the judge,
 * requests, the capability gate, the approvals of tool calls, the Bot plugin and the work
 * plugin. The coordinator is separate, because it needs the Chat runtimes. The host gives the
 * helper models (`Judge.HelperModel`).
 */
export const layer = Layer.mergeAll(
	BotPlugin.layer,
	WorkPlugin.layer,
	Approvals.layer,
).pipe(
	Layer.provideMerge(OpenWorkCount.layer),
	Layer.provideMerge(Reminders.layer),
	Layer.provideMerge(Limits.layer),
	Layer.provideMerge(Gate.layer),
	Layer.provideMerge(Requests.layer),
	Layer.provideMerge(MemoryBot.layer),
	Layer.provideMerge(
		Layer.mergeAll(
			Judge.layer,
			Grants.layer,
			Rules.layer,
			Delegations.layer,
			BotMemories.layer,
			Bots.layer,
		),
	),
	Layer.provideMerge(Layer.merge(BotRecords.layer, Signals.layer)),
)
