import { Data } from "effect"
import type { Effect, Schema, Scope } from "effect"
import type {
	Authorization,
	Client,
	Discovery,
	Network,
	App as ProtocolApp,
	Store,
} from "@openbot-build/protocol"

export class AppError extends Data.TaggedError("AppError")<{
	readonly reason: "unavailable" | "storage-failed" | "configuration-failed"
	readonly message: string
}> {}

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
export interface BeginAuthorizationRequest {
	readonly key: Store.ConnectionKey
	readonly issuer: string
	readonly clientId: string
	readonly redirectUri: string
	readonly scopes: ReadonlyArray<string>
	readonly resourceMetadataUrl?: string
	readonly expiresInMs?: number
}
export interface PendingAuthorization {
	readonly _tag: "PendingAuthorization"
	readonly flowId: string
	readonly authorizationUrl: string
	readonly key: Store.ConnectionKey
	readonly resource: string
	readonly issuer: string
	readonly scopes: ReadonlyArray<string>
}
export interface CompleteAuthorizationRequest {
	readonly key: Store.ConnectionKey
	readonly flowId: string
	readonly callbackUrl: string
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
export interface Removed {
	readonly _tag: "Removed"
	readonly key: Store.ConnectionKey
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
	readonly list: Effect.Effect<ReadonlyArray<Store.AppRecord>, AppError>
	readonly get: (
		cardUrl: string,
	) => Effect.Effect<Store.AppRecord, Store.StoreError>
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
	readonly beginAuthorization: (
		input: BeginAuthorizationRequest,
	) => Effect.Effect<
		PendingAuthorization,
		| Authorization.AuthorizationError
		| Network.NetworkError
		| ProtocolApp.AppError
		| Schema.SchemaError
		| Store.StoreError
	>
	readonly completeAuthorization: (
		input: CompleteAuthorizationRequest,
	) => Effect.Effect<
		Store.UserConnection,
		Authorization.AuthorizationError | ProtocolApp.AppError | Store.StoreError
	>
	readonly open: (
		input: OpenRequest,
	) => Effect.Effect<Client.Client, Client.Error, Scope.Scope>
	readonly setEnabled: (input: {
		readonly key: Store.ConnectionKey
		readonly enabled: boolean
	}) => Effect.Effect<Store.UserConnection, AppError | Store.StoreError>
	readonly remove: (
		key: Store.ConnectionKey,
	) => Effect.Effect<Removed, ProtocolApp.CleanupPending | Store.StoreError>
	readonly revalidate: (
		input: ProtocolApp.RevalidationOptions,
	) => Effect.Effect<
		RevalidationResult,
		ProtocolApp.AppError | Store.StoreError | Discovery.Error
	>
}
