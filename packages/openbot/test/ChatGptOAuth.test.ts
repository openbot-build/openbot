import { assert, describe, it } from "@effect/vitest"
import * as Accounts from "@openbot-build/domain/ProviderOAuth"
import {
	Array as Arr,
	Clock,
	Effect,
	Redacted,
	Ref,
	Schema,
	String as Str,
} from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose"
import * as OAuth from "../src/providers/chatgpt/OAuth.ts"

const issuer = "https://auth.openai.com"
const clientId = "oaiapp_test"
const nonce = "nonce-test"
const exchange = {
	clientId,
	code: "test-code",
	redirectUri: "http://127.0.0.1:1455/auth/callback",
	verifier: "test-verifier",
	nonce,
}
const scopes =
	"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"

const json = (
	request: HttpClientRequest.HttpClientRequest,
	value: unknown,
	status = 200,
) =>
	Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
		Effect.map((body) =>
			HttpClientResponse.fromWeb(
				request,
				new globalThis.Response(body, {
					status,
					headers: { "content-type": "application/json" },
				}),
			),
		),
		Effect.orDie,
	)

const signed = Effect.gen(function* () {
	const keys = yield* Effect.promise(() =>
		generateKeyPair("RS256", { extractable: true }),
	)
	const jwk = yield* Effect.promise(() => exportJWK(keys.publicKey))
	const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
	return {
		jwks: { keys: [{ ...jwk, kid: "test-key", use: "sig", alg: "RS256" }] },
		issue: (claims: JWTPayload = {}) =>
			Effect.promise(() =>
				new SignJWT({
					sub: "chatgpt-user",
					email: "user@example.com",
					nonce,
					...claims,
				})
					.setProtectedHeader({ alg: "RS256", kid: "test-key" })
					.setIssuer(issuer)
					.setAudience(clientId)
					.setIssuedAt(now)
					.setExpirationTime(now + 3600)
					.sign(keys.privateKey),
			),
	}
})

const tokenResult = (idToken: string) => ({
	access_token: "private-access",
	refresh_token: "private-refresh",
	id_token: idToken,
	token_type: "Bearer",
	expires_in: 3600,
	scope: scopes,
	earliest_refresh_at: "2026-10-28T10:00:00Z",
})

const oauthWith = (http: HttpClient.HttpClient) =>
	OAuth.make.pipe(Effect.provideService(HttpClient.HttpClient, http))

describe("ChatGPT OAuth", () => {
	it("uses the OpenBot name only for a new client", () => {
		const input = {
			...exchange,
			hostId: "urn:uuid:host",
			state: "state-test",
			challenge: "challenge-test",
			firstRegistration: true,
		}
		const first = new URL(
			OAuth.authorizeUrl({ ...input, clientId: "dynamic_agent_client" }),
		)
		assert.strictEqual(first.pathname, "/api/accounts/authorize")
		assert.strictEqual(first.searchParams.get("agent_name_hint"), "OpenBot")
		assert.strictEqual(
			first.searchParams.get("resource"),
			"https://api.openai.com/v1",
		)
		assert.strictEqual(first.searchParams.get("code_challenge_method"), "S256")
		assert.strictEqual(first.searchParams.get("scope"), scopes)
		const next = new URL(
			OAuth.authorizeUrl({ ...input, firstRegistration: false }),
		)
		assert.strictEqual(next.searchParams.get("client_id"), clientId)
		assert.strictEqual(next.searchParams.has("agent_name_hint"), false)
	})

	it.effect("checks the signed identity before it returns tokens", () =>
		Effect.gen(function* () {
			const identity = yield* signed
			const idToken = yield* identity.issue()
			const requests = yield* Ref.make<
				ReadonlyArray<HttpClientRequest.HttpClientRequest>
			>([])
			const oauth = yield* oauthWith(
				HttpClient.make((request) =>
					Effect.gen(function* () {
						yield* Ref.update(requests, Arr.append(request))
						return yield* json(
							request,
							Str.endsWith("/jwks.json")(request.url)
								? identity.jwks
								: tokenResult(idToken),
						)
					}),
				),
			)
			const result = yield* oauth.exchange(exchange)
			assert.strictEqual(result.subject, "chatgpt-user")
			assert.strictEqual(result.email, "user@example.com")
			assert.strictEqual(Redacted.value(result.accessToken), "private-access")
			assert.strictEqual(Redacted.value(result.refreshToken), "private-refresh")
			const sent = yield* Ref.get(requests)
			assert.strictEqual(sent[0]?.url, issuer + "/api/accounts/oauth/token")
			const body = sent[0]?.body
			assert.ok(body?._tag === "Uint8Array")
			const fields = new URLSearchParams(new TextDecoder().decode(body.body))
			assert.strictEqual(fields.get("code_verifier"), exchange.verifier)
			assert.strictEqual(fields.get("redirect_uri"), exchange.redirectUri)
			assert.strictEqual(fields.get("client_id"), clientId)
			assert.strictEqual(fields.get("resource"), "https://api.openai.com/v1")
			assert.strictEqual(sent[1]?.url, issuer + "/.well-known/jwks.json")
		}),
	)

	it.effect("refuses a wrong nonce or a different saved account", () =>
		Effect.gen(function* () {
			const identity = yield* signed
			for (const input of [
				{ claims: { nonce: "wrong" }, expectedSubject: undefined },
				{ claims: {}, expectedSubject: "another-user" },
			]) {
				const idToken = yield* identity.issue(input.claims)
				const oauth = yield* oauthWith(
					HttpClient.make((request) =>
						json(
							request,
							Str.endsWith("/jwks.json")(request.url)
								? identity.jwks
								: tokenResult(idToken),
						),
					),
				)
				const error = yield* oauth
					.exchange({
						...exchange,
						...(input.expectedSubject === undefined
							? {}
							: { expectedSubject: input.expectedSubject }),
					})
					.pipe(Effect.flip)
				assert.ok(Schema.is(Accounts.ModelProviderAuthorizationInvalid)(error))
			}
		}),
	)

	it.effect("refuses a token without permission to use the plan", () =>
		Effect.gen(function* () {
			const identity = yield* signed
			const idToken = yield* identity.issue()
			const oauth = yield* oauthWith(
				HttpClient.make((request) =>
					json(request, {
						...tokenResult(idToken),
						scope: "openid email",
					}),
				),
			)
			const error = yield* oauth.exchange(exchange).pipe(Effect.flip)
			assert.ok(Schema.is(Accounts.ModelProviderLoginRequired)(error))
		}),
	)

	it.effect("rotates the refresh token and keeps the granted scopes", () =>
		Effect.gen(function* () {
			const identity = yield* signed
			const idToken = yield* identity.issue()
			const current: OAuth.Credentials = {
				clientId,
				subject: "chatgpt-user",
				idToken: Redacted.make(idToken),
				accessToken: Redacted.make("old-access"),
				refreshToken: Redacted.make("old-refresh"),
				expiresAt: 0,
				scopes: Str.split(scopes, " "),
			}
			const requests = yield* Ref.make<
				ReadonlyArray<HttpClientRequest.HttpClientRequest>
			>([])
			const oauth = yield* oauthWith(
				HttpClient.make((request) =>
					Effect.gen(function* () {
						yield* Ref.update(requests, Arr.append(request))
						return yield* json(request, {
							access_token: "next-access",
							refresh_token: "next-refresh",
							earliest_refresh_at: "2026-10-28T10:00:00.000Z",
							token_type: "Bearer",
							expires_in: 3600,
						})
					}),
				),
			)
			const next = yield* oauth.refresh(current)
			assert.strictEqual(next.earliestRefreshAt, 1793181600000)
			assert.strictEqual(Redacted.value(next.refreshToken), "next-refresh")
			assert.strictEqual(Redacted.value(next.idToken), idToken)
			assert.deepStrictEqual(next.scopes, current.scopes)
			const sent = yield* Ref.get(requests)
			assert.strictEqual(sent.length, 1)
			const body = sent[0]?.body
			assert.ok(body?._tag === "Uint8Array")
			const fields = new URLSearchParams(new TextDecoder().decode(body.body))
			assert.strictEqual(fields.get("grant_type"), "refresh_token")
			assert.strictEqual(fields.get("refresh_token"), "old-refresh")
			assert.strictEqual(fields.has("scope"), false)
		}),
	)

	it.effect("asks for sign-in again only for a closed token session", () =>
		Effect.gen(function* () {
			const current: OAuth.Credentials = {
				clientId,
				subject: "user",
				idToken: Redacted.make("id"),
				accessToken: Redacted.make("access"),
				refreshToken: Redacted.make("refresh"),
				expiresAt: 0,
				scopes: [],
			}
			for (const errorCode of [
				"invalid_grant",
				"refresh_token_reused",
				"server_error",
			]) {
				const oauth = yield* oauthWith(
					HttpClient.make((request) =>
						json(
							request,
							{ error: errorCode },
							errorCode === "server_error" ? 503 : 400,
						),
					),
				)
				const failed = yield* oauth.refresh(current).pipe(Effect.flip)
				assert.strictEqual(
					failed._tag,
					errorCode === "server_error"
						? "ModelProviderOAuthUnavailable"
						: "ModelProviderLoginRequired",
				)
			}
		}),
	)

	it.effect("lists the account models in their given order", () =>
		Effect.gen(function* () {
			const oauth = yield* oauthWith(
				HttpClient.make((request) => {
					assert.strictEqual(request.url, "https://api.openai.com/v1/models")
					assert.strictEqual(
						request.headers["authorization"],
						"Bearer private-access",
					)
					return json(request, {
						models: [
							{
								slug: "second",
								display_name: "Second",
								visibility: "list",
								context_window: 1234,
							},
							{ slug: "hidden", display_name: "Hidden", visibility: "hide" },
							{
								slug: "first",
								display_name: "First",
								visibility: "list",
								supported_reasoning_levels: [
									{ effort: "low", description: "Fast" },
								],
							},
						],
					})
				}),
			)
			const result = yield* oauth.models(Redacted.make("private-access"))
			assert.deepStrictEqual(
				Arr.map(result.items, (model) => model.id),
				["second", "first"],
			)
			assert.deepStrictEqual(result.items[1]?.reasoningEfforts, ["low"])
			assert.strictEqual(result.items[0]?.contextWindow, 1234)
		}),
	)
	it.effect("keeps a key server failure separate from a bad signature", () =>
		Effect.gen(function* () {
			const identity = yield* signed
			const other = yield* signed
			const idToken = yield* other.issue()
			for (const unavailable of [false, true]) {
				const oauth = yield* oauthWith(
					HttpClient.make((request) => {
						if (Str.endsWith("/jwks.json")(request.url))
							return json(request, identity.jwks, unavailable ? 503 : 200)
						return json(request, tokenResult(idToken))
					}),
				)
				const failed = yield* oauth.exchange(exchange).pipe(Effect.flip)
				assert.strictEqual(
					failed._tag,
					unavailable
						? "ModelProviderOAuthUnavailable"
						: "ModelProviderAuthorizationInvalid",
				)
			}
		}),
	)

	it.effect("ends the renewable session with the issued client ID", () =>
		Effect.gen(function* () {
			const current: OAuth.Credentials = {
				clientId,
				subject: "user",
				idToken: Redacted.make("id"),
				accessToken: Redacted.make("access"),
				refreshToken: Redacted.make("private-refresh"),
				expiresAt: 0,
				scopes: [],
			}
			const oauth = yield* oauthWith(
				HttpClient.make((request) => {
					if (Str.endsWith("/.well-known/openid-configuration")(request.url))
						return json(request, {
							revocation_endpoint: issuer + "/api/accounts/oauth/revoke",
						})
					assert.strictEqual(request.url, issuer + "/api/accounts/oauth/revoke")
					const body = request.body
					assert.ok(body._tag === "Uint8Array")
					const fields = new URLSearchParams(
						new TextDecoder().decode(body.body),
					)
					assert.strictEqual(fields.get("client_id"), clientId)
					assert.strictEqual(fields.get("token_type_hint"), "refresh_token")
					assert.strictEqual(fields.get("token"), "private-refresh")
					return Effect.succeed(
						HttpClientResponse.fromWeb(
							request,
							new globalThis.Response("", { status: 200 }),
						),
					)
				}),
			)
			yield* oauth.revoke(current)
		}),
	)
})
