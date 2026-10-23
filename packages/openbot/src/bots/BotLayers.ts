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
import * as Waits from "../plugins/work/Waits.ts"
import * as BotRecords from "./BotRecords.ts"
import * as Bots from "./Bots.ts"
import * as Delegations from "./Delegations.ts"
import * as Signals from "./Signals.ts"

/**
 * The Bot services: records, Bots, memory, delegations, Grants, Rules, the judge,
 * requests, the capability gate, the Bot plugin and the work plugin. The coordinator is separate,
 * because it needs the Session runtimes.
 */
export const layer = <R>(options: {
	readonly helper: Layer.Layer<Judge.HelperModel, never, R>
}) =>
	Layer.merge(BotPlugin.layer, WorkPlugin.layer).pipe(
		Layer.provideMerge(Waits.layer),
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
		Layer.provideMerge(options.helper),
		Layer.provideMerge(Layer.merge(BotRecords.layer, Signals.layer)),
	)
