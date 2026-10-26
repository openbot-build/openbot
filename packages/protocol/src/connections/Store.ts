import { Context, Effect, Schema } from "effect"
import * as Discovery from "../discovery/Discovery.ts"
import * as Document from "../Document.ts"

export class StoreError extends Schema.TaggedError<
	StoreError,
	{ readonly brand: unique symbol }
>()("StoreError", {
	reason: Schema.Literals([
		"Missing",
		"AlreadyExists",
		"Invalid",
		"Unavailable",
	]),
	operation: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * A key is any value with an owner and a connection ID.
 * Connections and credential bindings are also keys, so this schema is a plain struct and not a class with a brand.
 */
export const ConnectionKey = Schema.Struct({
	owner: Schema.NonEmptyString,
	connectionId: Schema.NonEmptyString,
})

export type ConnectionKey = typeof ConnectionKey.Type

export class CredentialBinding extends Schema.Opaque<
	CredentialBinding,
	{ readonly brand: unique symbol }
>()(
	Schema.Struct({
		owner: Schema.NonEmptyString,
		connectionId: Schema.NonEmptyString,
		resource: Schema.NonEmptyString,
		issuer: Schema.NonEmptyString,
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(CredentialBinding)(value).pipe(
			Effect.mapError((cause) =>
				StoreError.make({
					reason: "Invalid",
					operation: "CredentialBinding.decode",
					cause,
				}),
			),
		)
}

export class Credential extends Schema.Opaque<
	Credential,
	{ readonly brand: unique symbol }
>()(
	Schema.Struct({
		binding: CredentialBinding,
		clientId: Schema.optional(Schema.String),
		accessToken: Schema.Redacted(Schema.NonEmptyString),
		refreshToken: Schema.optional(Schema.Redacted(Schema.NonEmptyString)),
		expiresAt: Schema.optional(Schema.Finite),
		scopes: Schema.Array(Schema.String),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Credential)(value).pipe(
			Effect.mapError((cause) =>
				StoreError.make({
					reason: "Invalid",
					operation: "Credential.decode",
					cause,
				}),
			),
		)
}

export const AuthorizationState = Schema.TaggedUnion({
	Unprotected: {},
	PendingAuthorization: {
		resource: Schema.String,
		scopes: Schema.Array(Schema.String),
	},
	Authorized: {
		binding: CredentialBinding,
		credentialRef: Schema.String,
		scopes: Schema.Array(Schema.String),
		resourceMetadataUrl: Schema.optional(Document.Link),
	},
	AuthorizationFailed: { reason: Schema.String },
	ScopeRequired: {
		resource: Schema.String,
		scopes: Schema.Array(Schema.String),
	},
})

export type AuthorizationState = typeof AuthorizationState.Type

export class AppRecord extends Schema.Opaque<
	AppRecord,
	{ readonly brand: unique symbol }
>()(
	Schema.Struct({
		cardUrl: Schema.String,
		card: Document.ServerCard,
		sources: Schema.Array(Discovery.Source),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(AppRecord)(value).pipe(
			Effect.mapError((cause) =>
				StoreError.make({
					reason: "Invalid",
					operation: "AppRecord.decode",
					cause,
				}),
			),
		)
}

export class UserConnection extends Schema.Opaque<
	UserConnection,
	{ readonly brand: unique symbol }
>()(
	Schema.Struct({
		owner: Schema.NonEmptyString,
		connectionId: Schema.NonEmptyString,
		cardUrl: Schema.String,
		endpoint: Schema.String,
		remoteIndex: Schema.Natural,
		configuration: Schema.Redacted(Schema.Record(Schema.String, Schema.String)),
		headers: Schema.Redacted(Schema.Record(Schema.String, Schema.String)),
		state: Schema.Literals([
			"Enabled",
			"Disabled",
			"NeedsRevalidation",
			"CleanupPending",
		]),
		authorization: AuthorizationState,
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(UserConnection)(value).pipe(
			Effect.mapError((cause) =>
				StoreError.make({
					reason: "Invalid",
					operation: "UserConnection.decode",
					cause,
				}),
			),
		)
}

export class AppStore extends Context.Service<
	AppStore,
	{
		readonly save: (input: {
			readonly app: AppRecord
			readonly connection: UserConnection
		}) => Effect.Effect<UserConnection, StoreError>
		readonly get: (
			key: ConnectionKey,
		) => Effect.Effect<UserConnection, StoreError>
		readonly getApp: (cardUrl: string) => Effect.Effect<AppRecord, StoreError>
		readonly update: (input: {
			readonly key: ConnectionKey
			readonly change: (connection: UserConnection) => UserConnection
		}) => Effect.Effect<UserConnection, StoreError>
		readonly updateApp: (app: AppRecord) => Effect.Effect<void, StoreError>
		readonly delete: (key: ConnectionKey) => Effect.Effect<void, StoreError>
	}
>()("@openbot-build/protocol/connections/Store/AppStore") {}

export class CredentialStore extends Context.Service<
	CredentialStore,
	{
		readonly put: (credential: Credential) => Effect.Effect<string, StoreError>
		readonly get: (input: {
			readonly binding: CredentialBinding
			readonly reference: string
		}) => Effect.Effect<Credential, StoreError>
		readonly deleteConnection: (
			key: ConnectionKey,
		) => Effect.Effect<void, StoreError>
	}
>()("@openbot-build/protocol/connections/Store/CredentialStore") {}
