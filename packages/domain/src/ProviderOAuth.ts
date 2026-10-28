import { Model } from "@openbot-build/core"
import { Schema } from "effect"

/** The browser returns to the local API caller after sign-in. */
export const ProviderOAuthRedirectUri = Schema.NonEmptyString.check(
	Schema.isMaxLength(4096),
	Schema.makeFilter(
		(value) => {
			const match =
				/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/auth\/callback$/.exec(value)
			return match !== null && Number(match[1]) <= 65535
		},
		{ message: "Expected http://127.0.0.1:<port>/auth/callback" },
	),
)

/** The server checks this URL against the saved sign-in request. */
export const ProviderOAuthCallbackUrl = Schema.NonEmptyString.check(
	Schema.isMaxLength(16384),
	Schema.makeFilter(
		(value) => {
			if (!URL.canParse(value)) return false
			const url = new URL(value)
			return (
				/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/auth\/callback(?:\?|$)/.test(
					value,
				) &&
				url.protocol === "http:" &&
				url.hostname === "127.0.0.1" &&
				url.username === "" &&
				url.password === "" &&
				url.pathname === "/auth/callback" &&
				url.hash === ""
			)
		},
		{ message: "Expected a local sign-in callback URL" },
	),
)

/** The provider's sign-in state. Tokens never leave the server. */
export const ProviderOAuthState = Schema.Struct({
	connected: Schema.Boolean,
	loginRequired: Schema.Boolean,
	email: Schema.optionalKey(Schema.String),
	subject: Schema.optionalKey(Schema.String),
})
export type ProviderOAuthState = typeof ProviderOAuthState.Type

export const StartProviderOAuthAuthorizationRequest = Schema.Struct({
	redirectUri: ProviderOAuthRedirectUri,
	expectedVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type StartProviderOAuthAuthorizationRequest =
	typeof StartProviderOAuthAuthorizationRequest.Type

export const ProviderOAuthAuthorization = Schema.Struct({
	id: Schema.NonEmptyString,
	url: Schema.String,
	expiresAt: Schema.String,
})
export type ProviderOAuthAuthorization = typeof ProviderOAuthAuthorization.Type

export const CompleteProviderOAuthAuthorizationRequest = Schema.Struct({
	callbackUrl: ProviderOAuthCallbackUrl,
})
export type CompleteProviderOAuthAuthorizationRequest =
	typeof CompleteProviderOAuthAuthorizationRequest.Type

export const ProviderOAuthModels = Schema.Struct({
	items: Schema.Array(
		Schema.Struct({
			id: Model.Id,
			name: Schema.String,
			reasoningEfforts: Schema.Array(Schema.String),
			serviceTiers: Schema.Array(Schema.String),
			contextWindow: Schema.optionalKey(Schema.Int),
		}),
	),
})
export type ProviderOAuthModels = typeof ProviderOAuthModels.Type

/** Local sign-out succeeds even when the remote session cannot be ended. */
export const ProviderOAuthDisconnect = Schema.Struct({
	revoked: Schema.Boolean,
})

export class ModelProviderLoginRequired extends Schema.TaggedError<
	ModelProviderLoginRequired,
	{ readonly brand: unique symbol }
>()("ModelProviderLoginRequired", {}) {}

export class ModelProviderAuthorizationInvalid extends Schema.TaggedError<
	ModelProviderAuthorizationInvalid,
	{ readonly brand: unique symbol }
>()("ModelProviderAuthorizationInvalid", { message: Schema.String }) {}

export class ModelProviderOAuthUnavailable extends Schema.TaggedError<
	ModelProviderOAuthUnavailable,
	{ readonly brand: unique symbol }
>()("ModelProviderOAuthUnavailable", {}) {}
