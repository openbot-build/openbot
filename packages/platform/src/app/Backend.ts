import { Context, Effect } from "effect"
import { Session, SessionStore } from "@openbot-build/core"
import * as Sessions from "../sessions/Sessions.ts"
import type { Caller, Identity } from "@openbot-build/platform-api"

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
		/**
		 * The Sessions of one member. Members of the same organization do not share Sessions.
		 * The runtime acts for the member, never for one of their tokens.
		 */
		readonly forCaller: (
			caller: Caller,
		) => Effect.Effect<
			typeof Sessions.Sessions.Service,
			SessionStore.SessionStoreError | Session.SessionError
		>
	}
>()("@openbot-build/platform/app/Backend") {}
