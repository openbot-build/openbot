import { Session, SessionStore } from "@openbot-build/core"
import { SessionResponse, SessionSummary } from "@openbot-build/api"
import { Context, type Effect, type Option } from "effect"

export class Repository extends Context.Service<
	Repository,
	{
		readonly store: (namespace: string) => SessionStore.Persistence
		readonly list: (
			namespace: string,
			input?: Parameters<SessionStore.Persistence["listRefs"]>[0],
		) => Effect.Effect<
			ReadonlyArray<SessionSummary>,
			SessionStore.SessionStoreError
		>
		readonly save: (
			namespace: string,
			input: {
				readonly delta: SessionStore.Delta
				/** The response of the current Turn, when the Session has one. */
				readonly response: Option.Option<SessionResponse>
			},
		) => Effect.Effect<void, SessionStore.SessionStoreError>
		readonly remove: (
			namespace: string,
			ref: Session.Ref,
		) => Effect.Effect<void, SessionStore.SessionStoreError>
	}
>()("@openbot-build/openbot/sessions/Repository") {}
