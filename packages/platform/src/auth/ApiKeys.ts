import { ApiKeysApi, type Caller } from "@openbot-build/platform-api"
import { Context, type Effect, type Redacted } from "effect"
import type { AuthUnavailable, CredentialRejected } from "./Model.ts"

type Owner = typeof Caller.Type

/** Credentials for programs. Each belongs to one account and works only in its tenant. */
export class ApiKeys extends Context.Service<
	ApiKeys,
	{
		readonly create: (
			owner: Owner,
			input: ApiKeysApi.CreateApiKeyRequest,
		) => Effect.Effect<
			ApiKeysApi.CreatedApiKey,
			ApiKeysApi.ApiKeyLimitReached | ApiKeysApi.ApiKeyStorageUnavailable
		>
		readonly list: (
			owner: Owner,
		) => Effect.Effect<
			ReadonlyArray<ApiKeysApi.ApiKey>,
			ApiKeysApi.ApiKeyStorageUnavailable
		>
		readonly revoke: (
			owner: Owner,
			id: string,
		) => Effect.Effect<
			void,
			ApiKeysApi.ApiKeyNotFound | ApiKeysApi.ApiKeyStorageUnavailable
		>
		/** Find the owner of a given secret, and record when the secret was last used. */
		readonly authenticate: (
			secret: Redacted.Redacted<string>,
		) => Effect.Effect<Owner, CredentialRejected | AuthUnavailable>
	}
>()("@openbot-build/platform/auth/ApiKeys") {}
