import { Layer } from "effect"
import * as Gate from "../capabilities/Gate.ts"
import * as Grants from "../capabilities/Grants.ts"
import * as Judge from "../capabilities/Judge.ts"
import * as Requests from "../capabilities/Requests.ts"
import * as Rules from "../capabilities/Rules.ts"
import * as AgentMemories from "./AgentMemories.ts"
import * as AgentPlugin from "../plugins/agents/AgentPlugin.ts"
import * as WorkPlugin from "../plugins/work/WorkPlugin.ts"
import * as Waits from "../plugins/work/Waits.ts"
import * as AgentRecords from "./AgentRecords.ts"
import * as Agents from "./Agents.ts"
import * as Delegations from "./Delegations.ts"
import * as Signals from "./Signals.ts"

/**
 * The Agent services: records, Agents, memory, delegations, Grants, Rules, the judge,
 * requests, the capability gate, the Agent plugin and the work plugin. The coordinator is separate,
 * because it needs the Session runtimes.
 */
export const layer = <R>(options: {
	readonly helper: Layer.Layer<Judge.HelperModel, never, R>
}) =>
	Layer.merge(AgentPlugin.layer, WorkPlugin.layer).pipe(
		Layer.provideMerge(Waits.layer),
		Layer.provideMerge(Gate.layer),
		Layer.provideMerge(Requests.layer),
		Layer.provideMerge(
			Layer.mergeAll(
				Judge.layer,
				Grants.layer,
				Rules.layer,
				Delegations.layer,
				AgentMemories.layer,
				Agents.layer,
			),
		),
		Layer.provideMerge(options.helper),
		Layer.provideMerge(Layer.merge(AgentRecords.layer, Signals.layer)),
	)
