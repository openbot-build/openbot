import type { Execution } from "@openbot-build/domain"
import { Context, type Schema } from "effect"
import type { Fence } from "./Store.ts"

/** The saved call and current owner. Tool handlers receive this at each send. */
export class CallContext extends Context.Service<
	CallContext,
	{
		readonly fence: Fence
		readonly id: Execution.CallId
		readonly inputState?: Schema.Json
	}
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
>()("@openbot-build/openbot/server-execution/execution/CallContext") {}
