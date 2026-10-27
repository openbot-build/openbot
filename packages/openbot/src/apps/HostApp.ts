import { Schema } from "effect"
import type { Effect, Scope } from "effect"
import type {
	Client,
	Discovery,
	App as ProtocolApp,
	Store,
} from "@openbot-build/protocol"

export class AppError extends Schema.TaggedError<
	AppError,
	{ readonly brand: unique symbol }
>()("AppError", {
	reason: Schema.Literals([
		"unavailable",
		"storage-failed",
		"configuration-failed",
	]),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

export interface AddRequest {
	readonly key: Store.ConnectionKey
	readonly candidate: Discovery.Candidate
	readonly remoteIndex: number
	readonly values: Readonly<Record<string, string>>
	readonly confirmed: boolean
	readonly requiresAuthorization: boolean
}
export interface Added {
	readonly connection: Store.UserConnection
	readonly publicHints: {
		readonly cardUrl: string
		readonly sources: ReadonlyArray<Discovery.Source>
	}
}
export type ClientInfo = NonNullable<
	NonNullable<
		Client.Client["discovery"]["_meta"]
	>["io.modelcontextprotocol/serverInfo"]
>

export interface OpenRequest {
	readonly key: Store.ConnectionKey
	readonly clientInfo: ClientInfo
	readonly capabilities?: Client.InputHandler["capabilities"]
	readonly inputs?: Client.InputHandler
}
export type RevalidationResult =
	| {
			readonly _tag: "DescriptionUpdated"
			readonly connection: Store.UserConnection
			readonly candidate: Discovery.Candidate
	  }
	| {
			readonly _tag: "NeedsRevalidation"
			readonly key: Store.ConnectionKey
			readonly candidate: Discovery.Candidate
	  }
	| {
			readonly _tag: "Revalidated"
			readonly connection: Store.UserConnection
			readonly candidate: Discovery.Candidate
	  }

/** The App service for one owner. open belongs to the caller's Scope. */
export interface Service {
	readonly discover: (
		input: string,
	) => Effect.Effect<Discovery.Result, Discovery.Error>
	readonly add: (
		input: AddRequest,
	) => Effect.Effect<
		Added,
		ProtocolApp.AppError | Store.StoreError | Discovery.Error
	>
	readonly listConnections: Effect.Effect<
		ReadonlyArray<Store.UserConnection>,
		AppError
	>
	readonly getConnection: (
		key: Store.ConnectionKey,
	) => Effect.Effect<Store.UserConnection, Store.StoreError>
	readonly open: (
		input: OpenRequest,
	) => Effect.Effect<Client.Client, Client.Error, Scope.Scope>
	readonly revalidate: (
		input: ProtocolApp.RevalidationOptions,
	) => Effect.Effect<
		RevalidationResult,
		ProtocolApp.AppError | Store.StoreError | Discovery.Error
	>
}
