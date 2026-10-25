import { Context, Effect, Redacted, Schema } from "effect"

export class TokenRejected extends Schema.TaggedError<TokenRejected>()(
	"TokenRejected",
	{
		reason: Schema.Literals(["Missing", "Invalid", "Expired", "WrongResource"]),
	},
) {}

export class AccessDenied extends Schema.TaggedError<AccessDenied>()(
	"AccessDenied",
	{
		scopes: Schema.Array(Schema.String),
	},
) {}

/** TokenVerifier must check the real signature or introspection, and the account identity. */
export class Identity extends Schema.Opaque<Identity>()(
	Schema.Struct({
		subject: Schema.NonEmptyString,
		issuer: Schema.NonEmptyString,
		audiences: Schema.NonEmptyArray(Schema.String),
		expiresAt: Schema.Finite,
		scopes: Schema.Array(Schema.String),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Identity)(value).pipe(
			Effect.mapError(() => TokenRejected.make({ reason: "Invalid" })),
		)
}

export class TokenVerifier extends Context.Service<
	TokenVerifier,
	{
		readonly verify: (
			token: Redacted.Redacted<string>,
		) => Effect.Effect<Identity, TokenRejected>
	}
>()("@openbot-build/protocol/publication/Protection/TokenVerifier") {}

export interface Operation {
	readonly method: string
	readonly target?: string
	readonly arguments?: Schema.JsonObject
}

export class AccessPolicy extends Context.Service<
	AccessPolicy,
	{
		readonly check: (
			identity: Identity,
			operation: Operation,
		) => Effect.Effect<void, AccessDenied>
		readonly visible: (
			identity: Identity,
			operation: Operation,
		) => Effect.Effect<boolean>
	}
>()("@openbot-build/protocol/publication/Protection/AccessPolicy") {}

export interface Options {
	readonly resource: string
	readonly metadataUrl: string
	readonly authorizationServers: ReadonlyArray<string>
	readonly scopes?: ReadonlyArray<string>
	readonly allowedOrigins?: ReadonlyArray<string>
}
