import { Context, Effect, Option, Schema, Scope } from "effect"
import * as Discovery from "../discovery/Discovery.ts"
import * as Store from "./Store.ts"

export class AppError extends Schema.TaggedError<AppError>()("AppError", {
	reason: Schema.Literals([
		"ConfirmationRequired",
		"CandidateChanged",
		"Unavailable",
	]),
}) {}

/** The part of a connection that still waits for cleanup. */
export const CleanupStage = Schema.Literals(["Credentials", "Connection"])
export type CleanupStage = typeof CleanupStage.Type

export class CleanupPending extends Schema.TaggedError<CleanupPending>()(
	"CleanupPending",
	{
		key: Store.ConnectionKey,
		stage: CleanupStage,
	},
) {}

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
