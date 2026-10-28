import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Authorizer, Policy } from "@nmnmcc/ability"
import * as AbilityHttpApi from "@nmnmcc/ability/HttpApi"
import {
	AuthApi,
	Authorization as ApiAuthorization,
	FailureApi,
	OpenBotApi,
} from "@openbot-build/api"
import { Authorization, Execution, TokenId } from "@openbot-build/domain"
import * as Accounts from "@openbot-build/domain/ProviderOAuth"
import {
	Cause,
	Effect,
	HashMap,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
} from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { Auth } from "../src/auth/Auth.ts"
import {
	layerBotAuth,
	layerAccountAuth,
	layerNoStore,
} from "../src/auth/HttpMiddleware.ts"
import { CredentialRejected } from "../src/auth/Model.ts"
import { Tokens } from "../src/auth/Tokens.ts"
import { RateLimiter } from "../src/billing/RateLimit.ts"
import * as Failures from "../src/errors/Failures.ts"
import * as Boundary from "../src/errors/HttpBoundary.ts"
import { Records } from "../src/errors/Records.ts"
import * as PlatformHandlers from "../src/platform/HttpHandlers.ts"
import { PlatformAdmins } from "../src/platform/PlatformAdmins.ts"
import { Secrets } from "../src/secrets/Secrets.ts"
import * as Handlers from "../src/models/HttpHandlers.ts"
import { ProviderOAuth } from "../src/models/ProviderOAuth.ts"
import {
	ModelProviders,
	type Stored,
	organizationOwner,
	platformOwner,
} from "../src/models/ModelProviders.ts"
import { Models } from "../src/models/Models.ts"
import { ModelRegistry } from "../src/models/ModelRegistry.ts"
import { Billing } from "../src/billing/Billing.ts"
import * as Fixture from "./OrganizationFixture.ts"

const origin = "https://openbot.example.com"
const redirectUri = "http://127.0.0.1:1455/auth/callback"
const callbackUrl = redirectUri + "?code=code&state=state&client_id=client"
const errorId = Execution.ErrorId.make("provider-oauth-http-error")
class Inside extends Schema.TaggedError<
	Inside,
	{ readonly brand: unique symbol }
>()("ProviderOAuthTestFailure", { detail: Schema.String }) {}
const cookie = (user: string) => ({
	cookie: AuthApi.SessionCookie + "=" + user + "-session",
})
const token = (user: string) => ({ authorization: "Bearer " + user })
const memberPolicy = Policy.define(Authorization.OpenBot)(function* (_) {
	yield* _.allow("read", Authorization.ModelProvider, {
		when: ($) => $.under("org", $.principal("organizationId")),
	})
	yield* _.allow("write", Authorization.ModelProvider, {
		when: ($) => $.under("org", $.principal("organizationId")),
	})
})
const platformPolicy = Policy.define(Authorization.OpenBot)(function* (_) {
	yield* _.allow("read", Authorization.Platform)
	yield* _.allow("write", Authorization.Platform)
})
for (const scope of ["organization", "platform"] as const) {
	const isPlatform = scope === "platform"
	const path = "/v1/" + scope + "/model_providers/prov_test"
	const api = HttpApi.make("openbot-api")
		.add(OpenBotApi.groups.modelProviders)
		.add(OpenBotApi.groups.platform)
		.middleware(FailureApi.FailureBoundary)
	it.live(
		scope + " provider OAuth uses its rights with API keys and sessions",
		() =>
			Effect.gen(function* () {
				const pending = yield* Ref.make(HashMap.empty<string, string>())
				const unavailable = yield* Ref.make(false)
				const saved = yield* Ref.make<ReadonlyArray<Cause.Cause<unknown>>>([])
				const value: Stored = {
					id: "prov_test",
					owner: isPlatform ? platformOwner : organizationOwner("org"),
					kind: "chatgpt",
					name: "Test",
					endpoint: null,
					apiKey: null,
					apiKeyHint: null,
					models: [],
					availability: null,
					version: 1,
					createdAt: 1,
					updatedAt: 1,
					oauth: { connected: false, loginRequired: false },
				}
				const state = yield* Ref.make(value)
				const providerStore = Layer.mock(ModelProviders, {
					get: (owner, id) =>
						Ref.get(state).pipe(
							Effect.map((value) =>
								(isPlatform
									? owner.kind === "platform"
									: owner.kind === "organization" && owner.id === "org") &&
								id === value.id
									? Option.some(value)
									: Option.none(),
							),
						),
				})
				const providerOAuth = Layer.mock(ProviderOAuth, {
					start: (owner, id, user) =>
						Effect.gen(function* () {
							if (
								(isPlatform
									? owner.kind !== "platform"
									: owner.kind !== "organization" || owner.id !== "org") ||
								id !== "prov_test"
							)
								return yield* Accounts.ModelProviderAuthorizationInvalid.make({
									message: "Unknown provider.",
								})
							const attempt = "authorization-" + user
							yield* Ref.update(pending, HashMap.set(attempt, user))
							return {
								id: attempt,
								url: "https://auth.openai.com/api/accounts/authorize?state=state",
								expiresAt: "2099-01-01T00:00:00.000Z",
							}
						}),
					complete: (_owner, _provider, user, id) =>
						Effect.gen(function* () {
							if (
								!Option.contains(HashMap.get(yield* Ref.get(pending), id), user)
							)
								return yield* Accounts.ModelProviderAuthorizationInvalid.make({
									message: "This sign-in request has ended. Start again.",
								})
							yield* Ref.update(pending, HashMap.remove(id))
							yield* Ref.update(state, (value) => ({
								...value,
								oauth: {
									connected: true,
									loginRequired: false,
									email: "owner@example.com",
								},
							}))
						}),
					disconnect: () =>
						Ref.update(state, (value) => ({
							...value,
							oauth: { connected: false, loginRequired: false },
						})).pipe(Effect.as({ revoked: true })),
					models: () =>
						Effect.gen(function* () {
							if (yield* Ref.get(unavailable))
								return yield* Effect.fail(
									Inside.make({ detail: "private-model-token" }),
								).pipe(
									Failures.replace("Could not list provider models", () =>
										Accounts.ModelProviderOAuthUnavailable.make({}),
									),
								)
							return { items: [] }
						}),
				})
				const auth = Layer.mock(Auth, {
					resolveSession: (credential) => {
						const value = Redacted.value(credential)
						if (value !== "alice-session" && value !== "bob-session")
							return Effect.fail(CredentialRejected.make({ kind: "session" }))
						return Effect.succeed({
							userId: value === "alice-session" ? "alice" : "bob",
							profile: {},
							platformAdmin: false,
							memberships: [
								{
									organizationId: "org",
									name: "Org",
									status: "active" as const,
									roles: ["member"],
								},
							],
							expiresAt: "2099-01-01T00:00:00.000Z",
							setCookies: [],
						})
					},
				})
				const tokens = Layer.mock(Tokens, {
					authenticate: (credential) => {
						const value = Redacted.value(credential)
						return ["alice", "bob", "alice-other", "blocked"].includes(value)
							? Effect.succeed({
									kind: "user_token" as const,
									userId: value === "alice-other" ? "alice" : value,
									organizationId: value === "alice-other" ? "other-org" : "org",
									tokenId: TokenId.make(value),
								})
							: Effect.fail(CredentialRejected.make({ kind: "token" }))
					},
				})
				const policy = Authorizer.layer(Authorization.Auth, {
					policy: (caller) =>
						Effect.succeed(
							caller.userId === "blocked"
								? Authorization.emptyPolicy
								: memberPolicy,
						),
				})
				const records = Layer.succeed(Records, {
					record: (cause, category) =>
						Ref.update(saved, (items) => [...items, cause]).pipe(
							Effect.as({ errorId, category }),
						),
				})
				const routes = HttpApiBuilder.layer(api).pipe(
					Layer.provide(Layer.merge(Handlers.layer, PlatformHandlers.layer)),
					Layer.provide(Boundary.layer),
					Layer.provide(
						AbilityHttpApi.layer(
							ApiAuthorization.Authorize,
							Authorization.Auth,
						),
					),
					Layer.provide(
						Layer.mergeAll(layerBotAuth, layerAccountAuth, layerNoStore),
					),
					Layer.provide(
						AbilityHttpApi.layer(
							ApiAuthorization.PlatformAuthorize,
							Authorization.PlatformAuth,
						),
					),
					Layer.provide(
						Layer.mergeAll(
							providerOAuth,
							Layer.mock(Secrets, {}),
							Layer.mock(PlatformAdmins, {}),
							Authorizer.layer(Authorization.PlatformAuth, {
								policy: (caller) =>
									Effect.succeed(
										caller.userId === "blocked"
											? Authorization.emptyPolicy
											: platformPolicy,
									),
							}),
							providerStore,
							Fixture.layerNoAudit,
							Layer.mock(Models, {}),
							Layer.mock(ModelRegistry, { defaultModel: Option.none() }),
							Layer.mock(Billing, {}),
							auth,
							tokens,
							policy,
							records,
							Fixture.layerEveryoneAdministrator,
							Fixture.layerSettings({ publicOrigin: origin }),
							Layer.succeed(RateLimiter, { hit: () => Effect.void }),
						),
					),
				)
				const server = HttpRouter.serve(routes, {
					disableLogger: true,
					disableListenLog: true,
				}).pipe(
					Layer.provideMerge(NodeHttpServer.layerTest),
					Layer.provide(NodeServices.layer),
				)
				return yield* Effect.gen(function* () {
					const client = yield* HttpClient.HttpClient
					const write = (
						route: string,
						headers: Readonly<Record<string, string>>,
						body: unknown,
					) =>
						HttpClientRequest.post(route, { headers }).pipe(
							HttpClientRequest.bodyJson(body),
							Effect.flatMap(client.execute),
						)
					const start = (headers: Readonly<Record<string, string>>) =>
						write(path + "/oauth/authorizations", headers, {
							redirectUri,
							expectedVersion: 1,
						})
					const complete = (
						user: string,
						headers: Readonly<Record<string, string>>,
					) =>
						write(
							path +
								"/oauth/authorizations/authorization-" +
								user +
								"/complete",
							headers,
							{ callbackUrl },
						)
					for (const headers of [{}, token("invalid"), cookie("invalid")])
						assert.strictEqual(
							(yield* client.get(path, { headers })).status,
							401,
						)
					assert.strictEqual(
						(yield* client.get(path, { headers: token("blocked") })).status,
						403,
					)
					assert.strictEqual((yield* start(token("blocked"))).status, 403)
					assert.strictEqual((yield* start(cookie("alice"))).status, 403)
					assert.strictEqual(
						(yield* start({
							...cookie("alice"),
							origin: "https://other.example",
						})).status,
						403,
					)
					assert.strictEqual((yield* start(token("alice"))).status, 200)
					assert.strictEqual(
						(yield* complete("alice", token("bob"))).status,
						400,
					)
					const finished = yield* complete("alice", token("alice"))
					assert.strictEqual(finished.status, 200)
					assert.notMatch(
						yield* finished.text,
						/private-|access_token|refresh_token/,
					)
					for (const headers of [
						token("alice"),
						token("bob"),
						cookie("alice"),
						cookie("bob"),
					]) {
						const response = yield* client.get(path, { headers })
						assert.strictEqual(response.status, 200)
						assert.include(yield* response.text, "owner@example.com")
					}
					assert.strictEqual(
						(yield* client.get(path, { headers: token("alice-other") })).status,
						isPlatform ? 200 : 404,
					)
					assert.strictEqual(
						(yield* start({ ...cookie("bob"), origin })).status,
						200,
					)
					assert.strictEqual(
						(yield* complete("bob", { ...cookie("bob"), origin })).status,
						200,
					)
					assert.strictEqual(
						(yield* client.del(path + "/oauth", { headers: cookie("alice") }))
							.status,
						403,
					)
					assert.strictEqual(
						(yield* client.del(path + "/oauth", {
							headers: { ...cookie("alice"), origin },
						})).status,
						200,
					)
					yield* Ref.set(unavailable, true)
					const failed = yield* client.get(path + "/available_models", {
						headers: token("alice"),
					})
					assert.strictEqual(failed.status, 503)
					assert.strictEqual(failed.headers[Boundary.errorIdHeader], errorId)
					assert.notMatch(yield* failed.text, /private-/)
					assert.strictEqual((yield* Ref.get(saved)).length, 1)
				}).pipe(Effect.provide(server))
			}),
	)
}
