import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { NoStore, OriginCheck, SessionAuth } from "./AuthApi.ts"

/** Every issued secret starts with this marker, so leaked keys are easy to spot. */
export const SecretPrefix = "obk_"
/** The most active keys that one account can have at the same time. */
export const MaxKeys = 25

export const ApiKeyName = Schema.String.check(
	Schema.makeFilter(
		(value) =>
			(value.trim().length >= 1 && value.trim().length <= 80) ||
			"Use an API key name between 1 and 80 characters.",
	),
)
export const ApiKey = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	/** The first characters of the secret. They help people spot a key without showing it. */
	prefix: Schema.String,
	createdAt: Schema.String,
	expiresAt: Schema.NullOr(Schema.String),
	lastUsedAt: Schema.NullOr(Schema.String),
})
export type ApiKey = typeof ApiKey.Type
export const CreateApiKeyRequest = Schema.Struct({
	name: ApiKeyName,
	/** Leave this out for a key that stays valid until someone revokes it. */
	expiresInDays: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })),
	),
})
export type CreateApiKeyRequest = typeof CreateApiKeyRequest.Type
export const CreatedApiKey = Schema.Struct({
	key: ApiKey,
	/** Returned only once. Platform stores a hash of it. */
	secret: Schema.String,
})
export type CreatedApiKey = typeof CreatedApiKey.Type
export const ApiKeyList = Schema.Struct({ keys: Schema.Array(ApiKey) })

export class ApiKeyNotFound extends Schema.TaggedError<ApiKeyNotFound>()(
	"ApiKeyNotFound",
	{},
) {}
export class ApiKeyLimitReached extends Schema.TaggedError<ApiKeyLimitReached>()(
	"ApiKeyLimitReached",
	{ limit: Schema.Int },
) {}
export class ApiKeyStorageUnavailable extends Schema.TaggedError<ApiKeyStorageUnavailable>()(
	"ApiKeyStorageUnavailable",
	{},
) {}
const errors = [
	ApiKeyStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const

/** Managing keys needs a signed-in session. An API key cannot create or revoke keys. */
export const ApiKeysApi = HttpApiGroup.make("apiKeys")
	.add(
		HttpApiEndpoint.get("listApiKeys", "/auth/api-keys", {
			success: ApiKeyList,
			error: errors,
		}),
		HttpApiEndpoint.post("createApiKey", "/auth/api-keys", {
			payload: CreateApiKeyRequest,
			success: CreatedApiKey.pipe(HttpApiSchema.status(201)),
			error: [...errors, ApiKeyLimitReached.pipe(HttpApiSchema.status(409))],
		}).middleware(OriginCheck),
		HttpApiEndpoint.delete("revokeApiKey", "/auth/api-keys/:keyId", {
			params: { keyId: Schema.String },
			success: HttpApiSchema.NoContent,
			error: [...errors, ApiKeyNotFound.pipe(HttpApiSchema.status(404))],
		}).middleware(OriginCheck),
	)
	.middleware(SessionAuth)
	.middleware(NoStore)
