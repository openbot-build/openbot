import { Schema } from "effect"
import {
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { NoStore } from "./AuthApi.ts"
import { Caller } from "./Identity.ts"
import { Policies, Required } from "./Permissions.ts"

/** Every user token starts with this marker, so leaked tokens are easy to spot. */
export const SecretPrefix = "obut_"
/** The most tokens that one member can have at the same time. */
export const MaxTokens = 25

export const TokenName = Schema.String.check(
	Schema.makeFilter(
		(value) =>
			(value.trim().length >= 1 && value.trim().length <= 80) ||
			"Use a token name between 1 and 80 characters.",
	),
)
export const Token = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	/** The first characters of the secret. They help people spot a token without showing it. */
	prefix: Schema.String,
	/** A token can never do more than its member can do at the time of the request. */
	policies: Policies,
	createdAt: Schema.String,
	expiresAt: Schema.NullOr(Schema.String),
	lastUsedAt: Schema.NullOr(Schema.String),
})
export type Token = typeof Token.Type
export const CreateTokenRequest = Schema.Struct({
	name: TokenName,
	/** Leave this out for a token that stays valid until someone revokes it. */
	expiresInDays: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })),
	),
	/** Leave this out to allow everything that the member can do, except managing tokens. */
	policies: Schema.optionalKey(Policies.check(Schema.isMinLength(1))),
})
export type CreateTokenRequest = typeof CreateTokenRequest.Type
export const CreatedToken = Schema.Struct({
	token: Token,
	/** Returned only once. Platform stores a hash of it. */
	secret: Schema.String,
})
export type CreatedToken = typeof CreatedToken.Type
export const TokenVerification = Schema.Struct({
	caller: Caller,
	/** The token that made the request, or null for the session cookie. */
	token: Schema.NullOr(Token),
})
export type TokenVerification = typeof TokenVerification.Type

export class TokenNotFound extends Schema.TaggedError<TokenNotFound>()(
	"TokenNotFound",
	{},
) {}
export class TokenLimitReached extends Schema.TaggedError<TokenLimitReached>()(
	"TokenLimitReached",
	{ limit: Schema.Int },
) {}
export class TokenPolicyInvalid extends Schema.TaggedError<TokenPolicyInvalid>()(
	"TokenPolicyInvalid",
	{ message: Schema.String },
) {}
export class TokenStorageUnavailable extends Schema.TaggedError<TokenStorageUnavailable>()(
	"TokenStorageUnavailable",
	{},
) {}
const errors = [
	TokenStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const

export const UserTokensPath = "/v1/user/tokens"

export const UserTokensApi = HttpApiGroup.make("userTokens")
	.add(
		HttpApiEndpoint.get("listTokens", UserTokensPath, {
			success: Schema.Struct({ items: Schema.Array(Token) }),
			error: errors,
		}),
		HttpApiEndpoint.post("createToken", UserTokensPath, {
			payload: CreateTokenRequest,
			success: CreatedToken.pipe(HttpApiSchema.status(201)),
			error: [
				...errors,
				TokenLimitReached.pipe(HttpApiSchema.status(409)),
				TokenPolicyInvalid.pipe(HttpApiSchema.status(400)),
			],
		}),
		HttpApiEndpoint.delete(
			"revokeToken",
			`${UserTokensPath}/:tokenId` as const,
			{
				params: { tokenId: Schema.String },
				success: HttpApiSchema.NoContent,
				error: [...errors, TokenNotFound.pipe(HttpApiSchema.status(404))],
			},
		),
		HttpApiEndpoint.get("verifyToken", "/v1/tokens/verify", {
			success: TokenVerification,
			error: errors,
		})
			.annotate(Required, [])
			.annotate(
				OpenApi.Description,
				"Shows who the caller is and, for a token, its policies. Every caller can use it.",
			),
	)
	.middleware(NoStore)
