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
>()("@openbot-build/openbot/execution/CallContext") {}
