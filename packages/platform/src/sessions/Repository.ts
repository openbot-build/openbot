import { Session, SessionStore } from "@openbot-build/core"
import { SessionResponse, SessionSummary } from "@openbot-build/platform-api"
import { Context, type Effect } from "effect"

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
		readonly response: (
			namespace: string,
			session: Session.Id,
		) => Effect.Effect<SessionResponse | null, SessionStore.SessionStoreError>
		readonly save: (
			namespace: string,
			input: {
				readonly delta: SessionStore.Delta
				readonly response: SessionResponse | null
			},
		) => Effect.Effect<void, SessionStore.SessionStoreError>
		readonly remove: (
			namespace: string,
			ref: Session.Ref,
		) => Effect.Effect<void, SessionStore.SessionStoreError>
	}
>()("@openbot-build/platform/sessions/Repository") {}
