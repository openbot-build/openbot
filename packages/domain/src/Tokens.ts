import { Schema, String as Str } from "effect"
import { TokenId } from "./TokenId.ts"
export { TokenId } from "./TokenId.ts"
import { SecretOutput } from "./Secret.ts"
import { Caller } from "./Identity.ts"
import { PolicyInput, PolicySchema } from "./Authorization.ts"

/** Every user token starts with this marker, so leaked tokens are easy to spot. */
export const SecretPrefix = "obut_"
/** The most tokens that one member can have at the same time. */
export const MaxTokens = 25

export const TokenName = Schema.String.check(
	Schema.makeFilter((value) => {
		const length = Str.trim(value).length
		return (
			(length >= 1 && length <= 80) ||
			"Use a token name between 1 and 80 characters."
		)
	}),
)

export const Token = Schema.Struct({
	id: TokenId,
	name: Schema.String,
	/** The first characters of the secret. They help people spot a token without showing it. */
	prefix: Schema.String,
	/** A token can never do more than its member can do at the time of the request. */
	policy: PolicySchema,
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
	policy: Schema.optionalKey(PolicyInput),
})
export type CreateTokenRequest = typeof CreateTokenRequest.Type
export const CreatedToken = Schema.Struct({
	token: Token,
	/** Returned only once. OpenBot stores a hash of it. */
	secret: SecretOutput,
})
export type CreatedToken = typeof CreatedToken.Type
export const TokenVerification = Schema.Struct({
	caller: Caller,
	/** The token that made the request, or null for the session cookie. */
	token: Schema.NullOr(Token),
})
export type TokenVerification = typeof TokenVerification.Type

export class TokenNotFound extends Schema.TaggedError<
	TokenNotFound,
	{ readonly brand: unique symbol }
>()("TokenNotFound", {}) {}
export class TokenLimitReached extends Schema.TaggedError<
	TokenLimitReached,
	{ readonly brand: unique symbol }
>()("TokenLimitReached", { limit: Schema.Int }) {}
export class TokenStorageUnavailable extends Schema.TaggedError<
	TokenStorageUnavailable,
	{ readonly brand: unique symbol }
>()("TokenStorageUnavailable", {}) {}
