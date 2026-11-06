import { TokenId } from "@openbot-build/domain/TokenId"
import { Access } from "@openbot-build/identity-contract/access/Access"
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
import { Authorization, Execution } from "@openbot-build/domain"
import * as Accounts from "@openbot-build/domain/ProviderOAuth"
import {
	Cause,
	Effect,
	HashMap,
	Layer,
	Option,
	Record as Rec,
	Redacted,
	Ref,
	Schema,
} from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import {
	type AccountCaller,
	Account,
	type Caller,
	Identity,
} from "@openbot-build/domain/Identity"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { layerNoStore } from "@openbot-build/identity-contract/auth/SessionHttp"
import * as Failures from "@openbot-build/server-kernel/Failures"
import * as Boundary from "@openbot-build/server-kernel/HttpBoundary"
import { Records } from "@openbot-build/server-kernel/Records"
import { PlatformAdmins } from "@openbot-build/identity-contract/platform/PlatformAdmins"
import { Secrets } from "@openbot-build/server-kernel/Secrets"
import { platformDefaults } from "@openbot-build/server-kernel/Documents"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as Handlers from "../src/HttpHandlers.ts"
import { ProviderOAuth } from "@openbot-build/models-contract/ProviderOAuth"
import {
	ModelProviders,
	type Stored,
	organizationOwner,
} from "@openbot-build/models-contract/ModelProviders"
import { Models } from "@openbot-build/models-contract/Models"
import { ModelRegistry } from "@openbot-build/models-contract/ModelRegistry"
import { Billing } from "@openbot-build/server-billing/Billing"
import { Mail } from "@openbot-build/identity-contract/mail/Mail"

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
/** The member of each test session. */
const sessions: Readonly<Record<string, Caller>> = {
	"alice-session": { kind: "member", organizationId: "org", userId: "alice" },
	"bob-session": { kind: "member", organizationId: "org", userId: "bob" },
}
/** The caller of each test token. */
const tokens: Readonly<Record<string, Caller>> = Rec.map(
	{
		alice: { organizationId: "org", userId: "alice" },
		bob: { organizationId: "org", userId: "bob" },
		"alice-other": { organizationId: "other-org", userId: "alice" },
		blocked: { organizationId: "org", userId: "blocked" },
	},
	(owner, secret): Caller => ({
		kind: "user_token",
		...owner,
		tokenId: TokenId.make(secret),
	}),
)
/** The caller of a known credential. Any other credential fails with 401. */
const callerOf = (
	callers: Readonly<Record<string, Caller>>,
	credential: Redacted.Redacted<string>,
) =>
	Rec.get(callers, Redacted.value(credential)).pipe(
		Effect.fromOption,
		Effect.catchTag("NoSuchElementError", () =>
			Effect.fail(AuthApi.AuthenticationRequired.make({})),
		),
	)
/**
 * Each known test token or session names its caller. The auth plugin checks
 * real credentials and the browser origin, and its own tests check them.
 * This test checks the rights of the provider routes.
 */
const layerBotAuth = Layer.succeed(AuthApi.BotAuth, {
	token: (route, { credential }) =>
		Effect.flatMap(callerOf(tokens, credential), (caller) =>
			Effect.provideService(route, Identity, caller),
		),
	session: (route, { credential }) =>
		Effect.flatMap(callerOf(sessions, credential), (caller) =>
			Effect.provideService(route, Identity, caller),
		),
})
const layerAccountAuth = Layer.succeed(AuthApi.AccountAuth, {
	token: (route, { credential }) =>
		Effect.flatMap(callerOf(tokens, credential), (caller) => {
			const account: AccountCaller = caller
			return Effect.provideService(route, Account, account)
		}),
	session: (route, { credential }) =>
		Effect.flatMap(callerOf(sessions, credential), (caller) => {
			const account: AccountCaller = { kind: "member", userId: caller.userId }
			return Effect.provideService(route, Account, account)
		}),
})
/** Platform settings in memory, with the public origin of the test. */
const layerSettings = Layer.mock(Settings, {
	platform: Effect.succeedSome({
		document: {
			...platformDefaults,
			publicOrigin: origin,
			authSecret: "unused",
			identityProvider: null,
		},
		version: 1,
		updatedAt: 0,
	}),
})
const layerNoAudit = Layer.succeed(AuditLog, {
	record: () => Effect.void,
	list: () => Effect.succeed({ items: [], next: null }),
})
const path = "/v1/organization/model_providers/prov_test"
const api = HttpApi.make("openbot-api")
	.add(OpenBotApi.groups.modelProviders)
	.middleware(FailureApi.FailureBoundary)
it.live(
	"organization provider OAuth uses its rights with API keys and sessions",
	() =>
		Effect.gen(function* () {
			const pending = yield* Ref.make(HashMap.empty<string, string>())
			const unavailable = yield* Ref.make(false)
			const saved = yield* Ref.make<ReadonlyArray<Cause.Cause<unknown>>>([])
			const value: Stored = {
				id: "prov_test",
				owner: organizationOwner("org"),
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
							owner.kind === "organization" &&
							owner.id === "org" &&
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
							owner.kind !== "organization" ||
							owner.id !== "org" ||
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
				Layer.provide(Handlers.layer),
				Layer.provide(Boundary.layer),
				Layer.provide(Layer.mock(Access, {})),
				Layer.provide(
					AbilityHttpApi.layer(ApiAuthorization.Authorize, Authorization.Auth),
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
						Layer.mock(Mail, {}),
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
						layerNoAudit,
						layerSettings,
						Layer.mock(Models, {}),
						Layer.mock(ModelRegistry, { defaultModel: Option.none() }),
						Layer.mock(Billing, {}),
						policy,
						records,
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
						path + "/oauth/authorizations/authorization-" + user + "/complete",
						headers,
						{ callbackUrl },
					)
				for (const headers of [{}, token("invalid"), cookie("invalid")])
					assert.strictEqual((yield* client.get(path, { headers })).status, 401)
				assert.strictEqual(
					(yield* client.get(path, { headers: token("blocked") })).status,
					403,
				)
				assert.strictEqual((yield* start(token("blocked"))).status, 403)
				assert.strictEqual((yield* start(token("alice"))).status, 200)
				assert.strictEqual((yield* complete("alice", token("bob"))).status, 400)
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
					404,
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
