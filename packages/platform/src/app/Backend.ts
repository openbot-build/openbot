import { Context, Effect } from "effect"
import { Session, SessionStore } from "@openbot-build/core"
import * as Sessions from "../sessions/Sessions.ts"
import type { Identity } from "@openbot-build/platform-api"

export class Backend extends Context.Service<
	Backend,
	{
		readonly get: (
			namespace: string,
			owner?: typeof Identity.Service,
		) => Effect.Effect<
			typeof Sessions.Sessions.Service,
			SessionStore.SessionStoreError | Session.SessionError
		>
	}
>()("@openbot-build/platform/app/Backend") {}
