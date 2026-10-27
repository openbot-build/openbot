import type { Tokens as TokensModel } from "@openbot-build/domain"
import type { Caller } from "@openbot-build/domain"
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
			input: TokensModel.CreateTokenRequest,
		) => Effect.Effect<
			TokensModel.CreatedToken,
			TokensModel.TokenLimitReached | TokensModel.TokenStorageUnavailable
		>
		readonly list: (
			owner: Owner,
		) => Effect.Effect<
			ReadonlyArray<TokensModel.Token>,
			TokensModel.TokenStorageUnavailable
		>
		readonly revoke: (
			owner: Owner,
			id: string,
		) => Effect.Effect<
			TokensModel.Token,
			TokensModel.TokenNotFound | TokensModel.TokenStorageUnavailable
		>
		/** Find one token of the caller, for its policies. */
		readonly find: (
			owner: Owner,
			id: string,
		) => Effect.Effect<
			Option.Option<TokensModel.Token>,
			TokensModel.TokenStorageUnavailable
		>
		/** Find the caller for a secret, and record when the secret was last used. */
		readonly authenticate: (
			secret: Redacted.Redacted<string>,
		) => Effect.Effect<Caller, CredentialRejected | AuthUnavailable>
	}
>()("@openbot-build/openbot/auth/Tokens") {}
