import { Models } from "@openbot-build/domain"
import * as Contract from "@openbot-build/domain/ProviderOAuth"
import { Context, Effect, Redacted } from "effect"
import { type Owner } from "./ModelProviders.ts"

export type Errors =
	| Contract.ModelProviderLoginRequired
	| Contract.ModelProviderAuthorizationInvalid
	| Contract.ModelProviderOAuthUnavailable
	| Models.ModelProviderNotFound
	| Models.ModelProviderInvalid
	| Models.ModelProviderConflict

/** OAuth sessions belong to providers, not to callers of a model. */
export class ProviderOAuth extends Context.Service<
	ProviderOAuth,
	{
		readonly start: (
			owner: Owner,
			providerId: string,
			userId: string,
			request: Contract.StartProviderOAuthAuthorizationRequest,
		) => Effect.Effect<Contract.ProviderOAuthAuthorization, Errors>
		readonly complete: (
			owner: Owner,
			providerId: string,
			userId: string,
			id: string,
			request: Contract.CompleteProviderOAuthAuthorizationRequest,
		) => Effect.Effect<void, Errors>
		readonly disconnect: (
			owner: Owner,
			providerId: string,
		) => Effect.Effect<{ readonly revoked: boolean }, Errors>
		readonly remove: (
			owner: Owner,
			providerId: string,
		) => Effect.Effect<{ readonly revoked: boolean }, Errors>
		readonly models: (
			owner: Owner,
			providerId: string,
		) => Effect.Effect<Contract.ProviderOAuthModels, Errors>
		readonly invalidate: (
			providerId: string,
			token: Redacted.Redacted<string>,
		) => Effect.Effect<void, Errors>
		readonly accessToken: (
			providerId: string,
		) => Effect.Effect<Redacted.Redacted<string>, Errors>
	}
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
>()("@openbot-build/openbot/models-contract/models/ProviderOAuth") {}
