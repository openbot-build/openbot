import type { Caller, UserTokensApi } from "@openbot-build/api"
import { Context, type Effect, type Option, type Redacted } from "effect"
import type { AuthUnavailable, CredentialRejected } from "./Model.ts"

interface Owner {
	readonly userId: string
	readonly organizationId: string
}

/** Credentials for programs. Each token acts for one member and works only in its organization. */
export class Tokens extends Context.Service<
	Tokens,
	{
		readonly create: (
			owner: Owner,
			input: UserTokensApi.CreateTokenRequest,
		) => Effect.Effect<
			UserTokensApi.CreatedToken,
			| UserTokensApi.TokenLimitReached
			| UserTokensApi.TokenPolicyInvalid
			| UserTokensApi.TokenStorageUnavailable
		>
		readonly list: (
			owner: Owner,
		) => Effect.Effect<
			ReadonlyArray<UserTokensApi.Token>,
			UserTokensApi.TokenStorageUnavailable
		>
		readonly revoke: (
			owner: Owner,
			id: string,
		) => Effect.Effect<
			UserTokensApi.Token,
			UserTokensApi.TokenNotFound | UserTokensApi.TokenStorageUnavailable
		>
		/** Find one token of the caller, for its policies. */
		readonly find: (
			owner: Owner,
			id: string,
		) => Effect.Effect<
			Option.Option<UserTokensApi.Token>,
			UserTokensApi.TokenStorageUnavailable
		>
		/** Find the caller for a secret, and record when the secret was last used. */
		readonly authenticate: (
			secret: Redacted.Redacted<string>,
		) => Effect.Effect<Caller, CredentialRejected | AuthUnavailable>
	}
>()("@openbot-build/openbot/auth/Tokens") {}
