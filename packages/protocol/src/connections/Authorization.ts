import { Context, Effect, Schema } from "effect"
import * as Store from "./Store.ts"

export class AuthorizationError extends Schema.TaggedError<AuthorizationError>()(
	"AuthorizationError",
	{
		reason: Schema.Literals([
			"Metadata",
			"CimdUnsupported",
			"ClientMetadata",
			"CallbackMismatch",
			"FlowExpired",
			"AlreadyConsumed",
			"GrantRejected",
			"RefreshUnavailable",
			"RefreshFailed",
			"ScopeRequired",
			"Crypto",
			"RevocationFailed",
		]),
		issue: Schema.String,
	},
) {}

export class ClientMetadata extends Schema.Opaque<ClientMetadata>()(
	Schema.StructWithRest(
		Schema.Struct({
			client_id: Schema.NonEmptyString,
			client_name: Schema.optional(Schema.String),
			redirect_uris: Schema.NonEmptyArray(Schema.String),
			token_endpoint_auth_method: Schema.Literal("none"),
			grant_types: Schema.Array(Schema.String),
			response_types: Schema.Array(Schema.String),
		}),
		[Schema.Record(Schema.String, Schema.Json)],
	),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(ClientMetadata)(value).pipe(
			Effect.mapError((error) =>
				AuthorizationError.make({
					reason: "ClientMetadata",
					issue: error.message,
				}),
			),
		)
}

export class ResourceMetadata extends Schema.Opaque<ResourceMetadata>()(
	Schema.StructWithRest(
		Schema.Struct({
			resource: Schema.NonEmptyString,
			authorization_servers: Schema.NonEmptyArray(Schema.String),
			scopes_supported: Schema.optional(Schema.Array(Schema.String)),
			bearer_methods_supported: Schema.optional(Schema.Array(Schema.String)),
		}),
		[Schema.Record(Schema.String, Schema.Json)],
	),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(ResourceMetadata)(value).pipe(
			Effect.mapError((error) =>
				AuthorizationError.make({
					reason: "Metadata",
					issue: error.message,
				}),
			),
		)
}

export class ServerMetadata extends Schema.Opaque<ServerMetadata>()(
	Schema.StructWithRest(
		Schema.Struct({
			issuer: Schema.NonEmptyString,
			authorization_endpoint: Schema.NonEmptyString,
			token_endpoint: Schema.NonEmptyString,
			revocation_endpoint: Schema.optional(Schema.String),
			client_id_metadata_document_supported: Schema.optional(Schema.Boolean),
			authorization_response_iss_parameter_supported: Schema.optional(
				Schema.Boolean,
			),
			code_challenge_methods_supported: Schema.Array(Schema.String),
			response_types_supported: Schema.Array(Schema.String),
			token_endpoint_auth_methods_supported: Schema.optional(
				Schema.Array(Schema.String),
			),
		}),
		[Schema.Record(Schema.String, Schema.Json)],
	),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(ServerMetadata)(value).pipe(
			Effect.mapError((error) =>
				AuthorizationError.make({
					reason: "Metadata",
					issue: error.message,
				}),
			),
		)
}

export class Flow extends Schema.Opaque<Flow>()(
	Schema.Struct({
		flowId: Schema.String,
		binding: Store.CredentialBinding,
		clientId: Schema.String,
		redirectUri: Schema.String,
		scopes: Schema.Array(Schema.String),
		verifier: Schema.Redacted(Schema.String),
		expiresAt: Schema.Finite,
		metadata: ServerMetadata,
		resourceMetadataUrl: Schema.optional(Schema.String),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Flow)(value).pipe(
			Effect.mapError(() =>
				AuthorizationError.make({
					reason: "CallbackMismatch",
					issue: "Invalid saved authorization flow",
				}),
			),
		)
}

export class FlowStore extends Context.Service<
	FlowStore,
	{
		readonly save: (flow: Flow) => Effect.Effect<void, Store.StoreError>
		readonly get: (input: {
			readonly key: Store.ConnectionKey
			readonly flowId: string
		}) => Effect.Effect<Flow, AuthorizationError | Store.StoreError>
		/** An atomic claim. Only one validated callback can redeem the code. */
		readonly consume: (input: {
			readonly key: Store.ConnectionKey
			readonly flowId: string
		}) => Effect.Effect<void, AuthorizationError | Store.StoreError>
	}
>()("@openbot-build/protocol/connections/Authorization/FlowStore") {}
