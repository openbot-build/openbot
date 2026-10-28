import { Model } from "@openbot-build/core"
import * as Accounts from "@openbot-build/domain/ProviderOAuth"
import {
	Array as Arr,
	Clock,
	Context,
	DateTime,
	Effect,
	Layer,
	Redacted,
	Result,
	Schema,
	String as Str,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { createLocalJWKSet, jwtVerify } from "jose"
import * as Failures from "../../errors/Failures.ts"

const issuer = "https://auth.openai.com"
const resource = "https://api.openai.com/v1"
const scope =
	"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
const secret = Schema.RedactedFromValue(Schema.NonEmptyString)

/** Tokens stay redacted in memory. Only the sealed store encodes them. */
export const Credentials = Schema.Struct({
	clientId: Schema.NonEmptyString,
	subject: Schema.NonEmptyString,
	email: Schema.optionalKey(Schema.String),
	idToken: secret,
	accessToken: secret,
	refreshToken: secret,
	expiresAt: Schema.Finite,
	scopes: Schema.Array(Schema.String),
	earliestRefreshAt: Schema.optionalKey(Schema.Finite),
})
export type Credentials = typeof Credentials.Type

export type OAuthErrors =
	| Accounts.ModelProviderLoginRequired
	| Accounts.ModelProviderAuthorizationInvalid
	| Accounts.ModelProviderOAuthUnavailable

export interface Exchange {
	readonly clientId: string
	readonly code: string
	readonly redirectUri: string
	readonly verifier: string
	readonly nonce: string
	readonly expectedSubject?: string
}

export class ChatGptOAuth extends Context.Service<
	ChatGptOAuth,
	{
		readonly exchange: (
			input: Exchange,
		) => Effect.Effect<Credentials, OAuthErrors>
		readonly refresh: (
			credentials: Credentials,
		) => Effect.Effect<Credentials, OAuthErrors>
		readonly models: (
			accessToken: Redacted.Redacted<string>,
		) => Effect.Effect<Accounts.ProviderOAuthModels, OAuthErrors>
		readonly revoke: (
			credentials: Credentials,
		) => Effect.Effect<void, OAuthErrors>
	}
>()("@openbot-build/openbot/providers/chatgpt/OAuth/ChatGptOAuth") {}

/** OpenAI returns an issued client ID after the first registration. */
export const authorizeUrl = (input: {
	readonly clientId: string
	readonly redirectUri: string
	readonly hostId: string
	readonly state: string
	readonly nonce: string
	readonly challenge: string
	readonly idTokenHint?: Redacted.Redacted<string>
	readonly firstRegistration: boolean
}): string => {
	const url = new URL("/api/accounts/authorize", issuer)
	url.search = new URLSearchParams({
		client_id: input.clientId,
		ext_agent_host_id: input.hostId,
		response_type: "code",
		redirect_uri: input.redirectUri,
		scope,
		resource,
		state: input.state,
		nonce: input.nonce,
		code_challenge: input.challenge,
		code_challenge_method: "S256",
		...(input.firstRegistration ? { agent_name_hint: "OpenBot" } : {}),
		...(input.idTokenHint === undefined
			? {}
			: { id_token_hint: Redacted.value(input.idTokenHint) }),
	}).toString()
	return url.toString()
}

const TokenResponse = Schema.Struct({
	access_token: secret,
	refresh_token: secret,
	id_token: Schema.optionalKey(secret),
	token_type: Schema.NonEmptyString,
	expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
	scope: Schema.optionalKey(Schema.String),
	earliest_refresh_at: Schema.optionalKey(Schema.String),
})
const ProviderError = Schema.Struct({ error: Schema.String })
const Jwks = Schema.Struct({
	keys: Schema.Array(
		Schema.Struct({
			kty: Schema.NonEmptyString,
			kid: Schema.optionalKey(Schema.String),
			use: Schema.optionalKey(Schema.String),
			alg: Schema.optionalKey(Schema.String),
			n: Schema.optionalKey(Schema.String),
			e: Schema.optionalKey(Schema.String),
			x: Schema.optionalKey(Schema.String),
			y: Schema.optionalKey(Schema.String),
			crv: Schema.optionalKey(Schema.String),
		}),
	),
})
const ModelList = Schema.Struct({
	models: Schema.Array(
		Schema.Struct({
			slug: Schema.NonEmptyString,
			display_name: Schema.NonEmptyString,
			visibility: Schema.String,
			description: Schema.optionalKey(Schema.String),
			context_window: Schema.optionalKey(
				Schema.Int.check(Schema.isGreaterThan(0)),
			),
			supported_reasoning_levels: Schema.optionalKey(
				Schema.Array(
					Schema.Struct({
						effort: Schema.String,
						description: Schema.String,
					}),
				),
			),
		}),
	),
})

class ReplyFailed extends Schema.TaggedError<
	ReplyFailed,
	{ readonly brand: unique symbol }
>()("ChatGptReplyFailed", { operation: Schema.String, status: Schema.Int }) {}

class IdentityFailed extends Schema.TaggedError<
	IdentityFailed,
	{ readonly brand: unique symbol }
>()("ChatGptIdentityFailed", { cause: Schema.Defect() }) {}

const unavailable = (operation: string) =>
	Failures.replace(operation, () =>
		Accounts.ModelProviderOAuthUnavailable.make({}),
	)
const invalid = () =>
	Accounts.ModelProviderAuthorizationInvalid.make({
		message: "The ChatGPT sign-in result is not valid. Start sign-in again.",
	})

export const make = Effect.gen(function* () {
	const client = yield* HttpClient.HttpClient
	const clock = yield* Clock.Clock

	const token = Effect.fn("ChatGptOAuth.token")(function* (
		fields: Readonly<Record<string, string>>,
	) {
		const response = yield* client
			.execute(
				HttpClientRequest.post(issuer + "/api/accounts/oauth/token").pipe(
					HttpClientRequest.bodyUrlParams({ ...fields, resource }),
				),
			)
			.pipe(unavailable("Could not reach ChatGPT sign-in"))
		if (response.status !== 200) {
			const error = yield* response.json.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(ProviderError)),
				unavailable("Could not read the ChatGPT token error"),
			)
			const terminal = Arr.contains(
				[
					"invalid_grant",
					"invalid_client",
					"invalid_refresh_token",
					"token_expired",
					"refresh_token_expired",
					"refresh_token_invalidated",
					"refresh_token_reused",
				],
				error.error,
			)
			return yield* Effect.fail(
				ReplyFailed.make({ operation: "token", status: response.status }),
			).pipe(
				Failures.replace("ChatGPT refused the token request", () =>
					terminal
						? Accounts.ModelProviderLoginRequired.make({})
						: Accounts.ModelProviderOAuthUnavailable.make({}),
				),
			)
		}
		return yield* response.json.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(TokenResponse)),
			unavailable("Could not read the ChatGPT token result"),
		)
	})

	const verify = Effect.fn("ChatGptOAuth.verify")(function* (
		idToken: Redacted.Redacted<string>,
		clientId: string,
		nonce?: string,
		expectedSubject?: string,
	) {
		const response = yield* client
			.get(issuer + "/.well-known/jwks.json")
			.pipe(unavailable("Could not read the ChatGPT signing keys"))
		if (response.status !== 200)
			return yield* Effect.fail(
				ReplyFailed.make({ operation: "keys", status: response.status }),
			).pipe(unavailable("Could not read the ChatGPT signing keys"))
		const jwks = yield* response.json.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Jwks)),
			unavailable("Could not read the ChatGPT signing keys"),
		)
		const now = yield* clock.currentTimeMillis
		const verified = yield* Effect.tryPromise({
			try: () =>
				jwtVerify(
					Redacted.value(idToken),
					createLocalJWKSet({
						keys: Arr.map(jwks.keys, (key) => ({ ...key })),
					}),
					{
						issuer,
						audience: clientId,
						requiredClaims: ["sub", "exp", "iat"],
						algorithms: ["RS256"],
						clockTolerance: 5,
						currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(now)),
					},
				),
			catch: (cause) => IdentityFailed.make({ cause }),
		}).pipe(Failures.replace("Could not check the ChatGPT ID token", invalid))
		const claims = verified.payload
		if (
			typeof claims.sub !== "string" ||
			claims.sub.length === 0 ||
			(nonce !== undefined && claims["nonce"] !== nonce) ||
			(expectedSubject !== undefined && claims.sub !== expectedSubject)
		)
			return yield* invalid()
		return {
			subject: claims.sub,
			...(typeof claims["email"] === "string"
				? { email: claims["email"] }
				: {}),
		}
	})

	const credentials = Effect.fn("ChatGptOAuth.credentials")(function* (
		result: typeof TokenResponse.Type,
		input: {
			readonly clientId: string
			readonly nonce?: string
			readonly expectedSubject?: string
			readonly previous?: Credentials
		},
	) {
		const scopes =
			result.scope === undefined
				? (input.previous?.scopes ?? [])
				: Str.split(result.scope, " ")
		if (
			Str.toLowerCase(result.token_type) !== "bearer" ||
			!Arr.contains(scopes, "chatgpt.tokens.use.direct") ||
			!Arr.contains(scopes, "resource.invoke")
		)
			return yield* Accounts.ModelProviderLoginRequired.make({})
		const idToken = result.id_token ?? input.previous?.idToken
		if (idToken === undefined) return yield* invalid()
		const identity =
			result.id_token === undefined && input.previous !== undefined
				? {
						subject: input.previous.subject,
						...(input.previous.email === undefined
							? {}
							: { email: input.previous.email }),
					}
				: yield* verify(
						idToken,
						input.clientId,
						input.nonce,
						input.expectedSubject,
					)
		const now = yield* clock.currentTimeMillis
		return {
			clientId: input.clientId,
			...identity,
			idToken,
			accessToken: result.access_token,
			refreshToken: result.refresh_token,
			expiresAt: now + result.expires_in * 1000,
			scopes,
			...(result.earliest_refresh_at === undefined
				? {}
				: {
						earliestRefreshAt: yield* Schema.decodeEffect(
							Schema.DateTimeUtcFromString,
						)(result.earliest_refresh_at).pipe(
							Effect.map(DateTime.toEpochMillis),
							unavailable("Could not read the token refresh time"),
						),
					}),
		} satisfies Credentials
	})

	return ChatGptOAuth.of({
		exchange: Effect.fn("ChatGptOAuth.exchange")(function* (input) {
			const result = yield* token({
				grant_type: "authorization_code",
				client_id: input.clientId,
				code: input.code,
				redirect_uri: input.redirectUri,
				code_verifier: input.verifier,
			})
			return yield* credentials(result, input)
		}),
		refresh: Effect.fn("ChatGptOAuth.refresh")(function* (current) {
			const result = yield* token({
				grant_type: "refresh_token",
				client_id: current.clientId,
				refresh_token: Redacted.value(current.refreshToken),
			})
			return yield* credentials(result, {
				clientId: current.clientId,
				expectedSubject: current.subject,
				previous: current,
			})
		}),
		models: Effect.fn("ChatGptOAuth.models")(function* (accessToken) {
			const response = yield* client
				.execute(
					HttpClientRequest.get(resource + "/models").pipe(
						HttpClientRequest.bearerToken(accessToken),
					),
				)
				.pipe(unavailable("Could not read the ChatGPT models"))
			if (response.status === 401)
				return yield* Accounts.ModelProviderLoginRequired.make({})
			if (response.status !== 200)
				return yield* Effect.fail(
					ReplyFailed.make({ operation: "models", status: response.status }),
				).pipe(unavailable("Could not read the ChatGPT models"))
			const result = yield* response.json.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(ModelList)),
				unavailable("Could not read the ChatGPT model list"),
			)
			return {
				items: Arr.filterMap(result.models, (model) =>
					model.visibility !== "list"
						? Result.failVoid
						: Result.succeed({
								id: Model.Id.make(model.slug),
								name: model.display_name,
								reasoningEfforts: Arr.map(
									model.supported_reasoning_levels ?? [],
									(level) => level.effort,
								),
								serviceTiers: [],
								...(model.description === undefined
									? {}
									: { description: model.description }),
								...(model.context_window === undefined
									? {}
									: { contextWindow: model.context_window }),
							}),
				),
			}
		}),
		revoke: Effect.fn("ChatGptOAuth.revoke")(function* (current) {
			const discovery = yield* client
				.get(issuer + "/.well-known/openid-configuration")
				.pipe(unavailable("Could not read ChatGPT sign-in settings"))
			const settings = yield* discovery.json.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(
						Schema.Struct({ revocation_endpoint: Schema.String }),
					),
				),
				unavailable("Could not read ChatGPT sign-in settings"),
			)
			if (
				!URL.canParse(settings.revocation_endpoint) ||
				new URL(settings.revocation_endpoint).origin !== issuer
			)
				return yield* Accounts.ModelProviderOAuthUnavailable.make({})
			const response = yield* client
				.execute(
					HttpClientRequest.post(settings.revocation_endpoint).pipe(
						HttpClientRequest.bodyUrlParams({
							token: Redacted.value(current.refreshToken),
							token_type_hint: "refresh_token",
							client_id: current.clientId,
						}),
					),
				)
				.pipe(unavailable("Could not end the ChatGPT session"))
			if (response.status !== 200)
				return yield* Effect.fail(
					ReplyFailed.make({ operation: "revoke", status: response.status }),
				).pipe(unavailable("Could not end the ChatGPT session"))
		}),
	})
})

export const layer = Layer.effect(ChatGptOAuth, make)
