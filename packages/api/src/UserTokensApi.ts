import { Schema } from "effect"
import {
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { TokenId } from "./TokenId.ts"
export { TokenId } from "./TokenId.ts"
import { NoStore } from "./AuthApi.ts"
import { Required } from "./Authorization.ts"
import {
	Token,
	CreateTokenRequest,
	CreatedToken,
	TokenVerification,
	TokenNotFound,
	TokenLimitReached,
	TokenStorageUnavailable,
} from "@openbot-build/domain/Tokens"
export {
	SecretPrefix,
	MaxTokens,
	TokenName,
	Token,
	CreateTokenRequest,
	CreatedToken,
	TokenVerification,
	TokenNotFound,
	TokenLimitReached,
	TokenStorageUnavailable,
} from "@openbot-build/domain/Tokens"

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
			error: [...errors, TokenLimitReached.pipe(HttpApiSchema.status(409))],
		}),
		HttpApiEndpoint.delete(
			"revokeToken",
			`${UserTokensPath}/:tokenId` as const,
			{
				params: { tokenId: TokenId },
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
				"Shows who the caller is and, for a token, its policy. Every caller can use it.",
			),
	)
	.middleware(NoStore)
