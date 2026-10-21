import { Context, Data, Effect, Option, Scope } from "effect"
import * as Discovery from "../discovery/Discovery.ts"
import * as Store from "./Store.ts"

export class AppError extends Data.TaggedError("AppError")<{
	readonly reason: "ConfirmationRequired" | "CandidateChanged" | "Unavailable"
}> {}

export class CleanupPending extends Data.TaggedError("CleanupPending")<{
	readonly key: Store.ConnectionKey
	readonly stage: "Credentials" | "Connection"
}> {}

export class ConnectionScopes extends Context.Service<
	ConnectionScopes,
	{
		readonly register: (input: {
			readonly key: Store.ConnectionKey
			readonly scope: Scope.Closeable
		}) => Effect.Effect<void>
		readonly close: (key: Store.ConnectionKey) => Effect.Effect<void>
	}
>()("@openbot-build/protocol/connections/App/ConnectionScopes") {}

export interface RevalidationOptions {
	readonly key: Store.ConnectionKey
	readonly candidate: Discovery.Candidate
	readonly remoteIndex?: number
	readonly values?: Readonly<Record<string, string>>
	/** The latest requirements that the trusted host got. None means the endpoint is not protected. */
	readonly authorization: Option.Option<{
		readonly issuer: string
		readonly scopes: ReadonlyArray<string>
	}>
	readonly confirmed: boolean
}
