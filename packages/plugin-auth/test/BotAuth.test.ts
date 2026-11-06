import { Caller, Identity } from "@openbot-build/domain/Identity"
import { TokenId } from "@openbot-build/domain/TokenId"
import { NodeCrypto, NodeHttpServer, NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { AuthApi, FailureApi, OpenBotApi } from "@openbot-build/api"
import { Billing, Execution } from "@openbot-build/domain"
import { emptyPolicy } from "@openbot-build/domain/Authorization"
import { Cause, Context, Effect, Layer, Redacted, Ref, Schema } from "effect"
import {
	HttpClient,
	HttpClientRequest,
	HttpRouter,
	HttpServer,
} from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	OpenApi,
} from "effect/http-api"
import { Auth } from "@openbot-build/identity-contract/auth/Auth"
import {
	AuthUnavailable,
	CredentialRejected,
} from "@openbot-build/server-kernel/AuthModel"
import { Tokens } from "@openbot-build/identity-contract/auth/Tokens"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import { RateLimiter } from "@openbot-build/server-billing/RateLimit"
import { platformDefaults } from "@openbot-build/server-kernel/Documents"
import * as Boundary from "@openbot-build/server-kernel/HttpBoundary"
import * as Failures from "@openbot-build/server-kernel/Failures"
import { Records } from "@openbot-build/server-kernel/Records"
import * as Reporting from "@openbot-build/server-kernel/Reporting"
import { Settings } from "@openbot-build/server-kernel/Settings"
import { codec, snapshot } from "@openbot-build/server-kernel/Snapshot"
import { layerBotAuth } from "../src/HttpMiddleware.ts"

const origin = "https://openbot.example.com"
/** A public origin on this computer, as a development server has. */
const localOrigin = "https://localhost:8443"

/** Platform settings in memory, with this public origin. */
const layerSettings = (publicOrigin: string) =>
	Layer.mock(Settings, {
		platform: Effect.succeedSome({
			document: {
				...platformDefaults,
				publicOrigin,
				authSecret: "unused",
				identityProvider: null,
			},
			version: 1,
			updatedAt: 0,
		}),
	})

/** Every member of every organization is active, so every token stays valid. */
const layerActiveMembers = Layer.mock(Organization, {
	activeMember: (_, userId) =>
		Effect.succeedSome({
			userId,
			email: null,
			name: null,
			status: "active" as const,
			roles: ["member" as const],
			policy: emptyPolicy,
			joinedAt: "2026-01-01T00:00:00.000Z",
		}),
})
class Inside extends Schema.TaggedError<
	Inside,
	{ readonly brand: unique symbol }
>()("Inside", { detail: Schema.String }) {}
class Api extends HttpApi.make("failure-auth-test")
	.add(
		HttpApiGroup.make("probe")
			.add(
				HttpApiEndpoint.get("read", "/identity", { success: Caller }),
				HttpApiEndpoint.post("write", "/identity", {
					payload: Schema.Struct({}),
					success: Caller,
				}),
			)
			.middleware(AuthApi.BotAuth),
	)
	.middleware(FailureApi.FailureBoundary) {}

it.live(
	"the failure boundary keeps token, cookie, origin, and rate limit checks",
	() => {
		let saved: ReadonlyArray<Cause.Cause<unknown>> = []
		let sessions = 0
		const auth = Layer.mock(Auth, {
			resolveSession: (credential) =>
				Effect.suspend(
					(): ReturnType<(typeof Auth.Service)["resolveSession"]> => {
						sessions++
						const secret = Redacted.value(credential)
						if (secret === "unavailable")
							return Effect.fail(
								Inside.make({ detail: "private-auth-secret" }),
							).pipe(
								Failures.replace("The sign-in store failed.", () =>
									AuthUnavailable.make({ dependency: "storage" }),
								),
							)
						if (secret !== "session" && secret !== "limited-session")
							return Effect.fail(CredentialRejected.make({ kind: "session" }))
						return Effect.succeed({
							userId: secret === "limited-session" ? "limited-user" : "user",
							profile: {},
							platformAdmin: false,
							canCreateOrganization: false,
							memberships: [
								{
									organizationId: "org",
									name: "Org",
									status: "active",
									roles: ["member"],
								},
							],
							expiresAt: "2099-01-01T00:00:00.000Z",
							setCookies: [],
						})
					},
				),
		})
		const tokens = Layer.mock(Tokens, {
			authenticate: (credential) => {
				const secret = Redacted.value(credential)
				return secret === "token" || secret === "limited"
					? Effect.succeed({
							kind: "user_token",
							organizationId: "org",
							userId: "user",
							tokenId: TokenId.make(secret),
						})
					: Effect.fail(CredentialRejected.make({ kind: "token" }))
			},
		})
		const limit = Layer.succeed(RateLimiter, {
			hit: (caller) =>
				caller.userId === "limited-user" ||
				(caller.kind === "user_token" && caller.tokenId === "limited")
					? Effect.fail(Billing.RateLimited.make({ retryAfterSeconds: 23 }))
					: Effect.void,
		})
		const records = Layer.succeed(Records, {
			record: (cause, category) =>
				Effect.sync(() => {
					saved = [...saved, cause]
					return {
						errorId: Execution.ErrorId.make(`auth-failure-${saved.length}`),
						category,
					}
				}),
		})
		const handlers = HttpApiBuilder.group(Api, "probe", (handlers) =>
			handlers.handle("read", () => Identity).handle("write", () => Identity),
		)
		const routes = HttpApiBuilder.layer(Api).pipe(
			Layer.provide(handlers),
			Layer.provide(
				layerBotAuth.pipe(
					Layer.provide(
						Layer.mergeAll(
							auth,
							tokens,
							limit,
							layerActiveMembers,
							layerSettings(origin),
						),
					),
				),
			),
			Layer.provide(Boundary.layer),
		)
		const server = HttpRouter.serve(Layer.merge(routes, Reporting.layerHttp), {
			disableLogger: true,
			disableListenLog: true,
		}).pipe(
			Layer.provide(records),
			Layer.provideMerge(NodeHttpServer.layerTest),
			Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
		)
		const cookie = (value: string) => ({
			cookie: `${AuthApi.SessionCookie}=${value}`,
		})
		return Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient
			// A valid token over its limit must not try the valid session as a second caller.
			const limited = yield* client.get("/identity", {
				headers: { authorization: "Bearer limited", ...cookie("session") },
			})
			assert.strictEqual(limited.status, 429)
			assert.deepStrictEqual(yield* limited.json, {
				_tag: "RateLimited",
				retryAfterSeconds: 23,
			})
			assert.strictEqual(sessions, 0)
			const limitedSession = yield* client.get("/identity", {
				headers: cookie("limited-session"),
			})
			assert.strictEqual(limitedSession.status, 429)
			assert.deepStrictEqual(yield* limitedSession.json, {
				_tag: "RateLimited",
				retryAfterSeconds: 23,
			})
			for (const [headers, kind] of [
				[{ authorization: "Bearer token" }, "user_token"],
				[cookie("session"), "member"],
			] as const) {
				const response = yield* client.get("/identity", { headers })
				assert.strictEqual(response.status, 200)
				const caller = yield* response.json.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Caller)),
				)
				assert.strictEqual(caller.kind, kind)
				assert.strictEqual(caller.organizationId, "org")
				assert.strictEqual(caller.userId, "user")
			}
			for (const headers of [
				{},
				{ authorization: "Bearer bad" },
				cookie("bad"),
			]) {
				const response = yield* client.get("/identity", { headers })
				assert.strictEqual(response.status, 401)
			}
			const write = (headers: Readonly<Record<string, string>>) =>
				client.execute(
					HttpClientRequest.post("/identity", { headers }).pipe(
						HttpClientRequest.bodyJsonUnsafe({}),
					),
				)
			assert.strictEqual((yield* write(cookie("session"))).status, 403)
			assert.strictEqual(
				(yield* write({
					...cookie("session"),
					origin: "https://other.example.com",
				})).status,
				403,
			)
			assert.strictEqual(
				(yield* write({ ...cookie("session"), origin })).status,
				200,
			)
			assert.strictEqual(
				(yield* write({ authorization: "Bearer token" })).status,
				200,
			)
			assert.strictEqual(saved.length, 0)
			const unavailable = yield* client.get("/identity", {
				headers: cookie("unavailable"),
			})
			assert.strictEqual(unavailable.status, 503)
			const failure = yield* unavailable.json.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(FailureApi.RequestFailed)),
			)
			assert.strictEqual(failure.category, "unavailable")
			assert.strictEqual(
				unavailable.headers[Boundary.errorIdHeader],
				failure.errorId,
			)
			assert.strictEqual(saved.length, 1)
			assert.include(
				yield* saved[0]!.pipe(snapshot, Schema.encodeEffect(codec)),
				"private-auth-secret",
			)
		}).pipe(Effect.provide(server))
	},
)

// The probe API runs on a real test server, so this test needs the real clock.
it.live(
	"bot authentication keeps session Origin checks and typed failures",
	() =>
		Effect.gen(function* () {
			const unavailable = yield* Ref.make(true)
			const failure = Effect.fail(
				AuthUnavailable.make({ dependency: "storage" }),
			)
			const auth = Layer.mock(Auth, {
				handle: () => Effect.succeed(new Response(null, { status: 503 })),
				signInProvider: () => Effect.succeedNone,
				resolveSession: (credential) =>
					Redacted.value(credential) !== "signed-session"
						? Effect.fail(CredentialRejected.make({ kind: "session" }))
						: Effect.flatMap(Ref.get(unavailable), (down) =>
								down
									? failure
									: Effect.succeed({
											userId: "session-user",
											memberships: [
												{
													organizationId: "session-user",
													name: "Session",
													status: "active" as const,
													roles: ["super_administrator"],
												},
											],
											platformAdmin: false,
											canCreateOrganization: false,
											profile: {},
											expiresAt: "2099-01-01T00:00:00.000Z",
											setCookies: [],
										}),
							),
			})
			const tokens = Layer.mock(Tokens, {
				authenticate: (credential) =>
					Redacted.value(credential) === "obut_valid"
						? Effect.succeed({
								kind: "user_token" as const,
								userId: "key-user",
								organizationId: "key-user",
								tokenId: TokenId.make("key-1"),
							})
						: Effect.fail(CredentialRejected.make({ kind: "token" })),
			})
			const api = HttpApi.make("auth-probe").add(
				HttpApiGroup.make("probe")
					.add(
						HttpApiEndpoint.get("identity", "/identity", { success: Caller }),
						HttpApiEndpoint.post("write", "/identity", {
							payload: Schema.Struct({}),
							success: Caller,
						}),
					)
					.middleware(AuthApi.BotAuth),
			)
			const handlers = HttpApiBuilder.group(api, "probe", (handlers) =>
				handlers
					.handle("identity", () => Identity)
					.handle("write", () => Identity),
			)
			const app = HttpApiBuilder.layer(api).pipe(
				Layer.provide(handlers),
				Layer.provide(
					layerBotAuth.pipe(
						Layer.provide(
							Layer.mergeAll(
								auth,
								tokens,
								layerActiveMembers,
								layerSettings(localOrigin),
								Layer.succeed(RateLimiter, { hit: () => Effect.void }),
							),
						),
					),
				),
				Layer.provide(HttpServer.layerServices),
			)
			// The test client sends each request to the test server.
			const client = Context.get(
				yield* Layer.build(
					HttpRouter.serve(app, {
						disableLogger: true,
						disableListenLog: true,
					}).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
				),
				HttpClient.HttpClient,
			)
			const cookie = { cookie: AuthApi.SessionCookie + "=signed-session" }
			const failed = yield* client.get("/identity", { headers: cookie })
			assert.strictEqual(failed.status, 503)
			assert.deepStrictEqual(yield* failed.json, {
				_tag: "AuthenticationUnavailable",
			})
			yield* Ref.set(unavailable, false)
			const session = yield* client.get("/identity", { headers: cookie })
			assert.deepStrictEqual(yield* session.json, {
				kind: "member",
				userId: "session-user",
				organizationId: "session-user",
			})
			for (const headers of [
				{},
				{ authorization: "Bearer retired" },
				{ cookie: AuthApi.SessionCookie + "=invalid" },
			]) {
				assert.strictEqual(
					(yield* client.get("/identity", { headers })).status,
					401,
				)
			}
			const write = (headers: Readonly<Record<string, string>>) =>
				HttpClientRequest.post("/identity", { headers }).pipe(
					HttpClientRequest.bodyJson({}),
					Effect.flatMap(client.execute),
				)
			assert.strictEqual((yield* write(cookie)).status, 403)
			assert.strictEqual(
				(yield* write({ ...cookie, origin: "https://other.example" })).status,
				403,
			)
			assert.strictEqual(
				(yield* write({ ...cookie, origin: localOrigin })).status,
				200,
			)
			assert.strictEqual(
				(yield* write({ authorization: "Bearer retired" })).status,
				401,
			)
			const keyed = yield* write({ authorization: "Bearer obut_valid" })
			assert.strictEqual(keyed.status, 200)
			assert.deepStrictEqual(yield* keyed.json, {
				kind: "user_token",
				userId: "key-user",
				organizationId: "key-user",
				tokenId: "key-1",
			})
		}),
)

it.effect(
	"the contract offers a token and the session cookie, and no other scheme",
	() =>
		Effect.sync(() => {
			const spec = OpenApi.fromApi(OpenBotApi)
			assert.deepStrictEqual(
				spec.paths["/v1/bots/{botId}/messages"]?.post?.security,
				[{ token: [] }, { session: [] }],
			)
			assert.strictEqual(spec.components.securitySchemes["bearer"], undefined)
			assert.deepStrictEqual(spec.components.securitySchemes["session"], {
				type: "apiKey",
				in: "cookie",
				name: AuthApi.SessionCookie,
			})
		}),
)
