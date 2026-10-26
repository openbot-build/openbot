import { assert, it, layer, vi } from "@effect/vitest"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import {
	DatabasePostgres,
	HostTools,
	OpenBot,
	Server,
} from "@openbot-build/openbot"
import {
	AuthApi,
	Caller,
	Identity,
	OpenBotApi,
	UserTokensApi,
} from "@openbot-build/api"
import { Config, Model, Provider } from "@openbot-build/core"
import {
	Clock,
	Context,
	Crypto,
	Duration,
	Effect,
	Exit,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
	Scope,
	Stream,
	String as Str,
	SynchronizedRef,
} from "effect"
import { LanguageModel, Response as ModelResponse } from "effect/ai"
import {
	Cookies,
	FetchHttpClient,
	Headers,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
	type HttpMethod,
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
// OrganizationFixture uses the source files, so the Auth layer must come from them too.
import * as Auth from "../src/auth/index.ts"
import * as PostgresTest from "./PostgresTest.ts"
import * as Development from "../dist/Development.js"
import * as OrganizationFixture from "./OrganizationFixture.ts"
import * as DefaultBot from "./DefaultBot.ts"
import * as Organizations from "./Organizations.ts"
import { bot, message, type Send } from "./Messages.ts"

const publicOrigin = "https://localhost:8443"
const authSecret = "DevelopmentIntegrationSecretMustStayStable123456"

/** The parts of the OpenAPI document that the test checks. */
const OpenApiDocument = Schema.Struct({
	paths: Schema.Record(
		Schema.String,
		Schema.Struct({
			post: Schema.optionalKey(
				Schema.Struct({
					security: Schema.Unknown,
					responses: Schema.Record(Schema.String, Schema.Unknown),
				}),
			),
		}),
	),
	components: Schema.Struct({
		securitySchemes: Schema.Record(Schema.String, Schema.Unknown),
	}),
})

/** The Max-Age of a cookie in seconds. */
const maxAgeOf = (cookie: Cookies.Cookie) =>
	cookie.options?.maxAge === undefined
		? undefined
		: Duration.toSeconds(cookie.options.maxAge)

/** The cookie as a browser sends it back in a Cookie header. */
const cookieHeader = (cookie: Cookies.Cookie) =>
	cookie.name + "=" + cookie.valueEncoded

it.effect(
	"the development sign-in secret comes from the first secret key and stays the same",
	() =>
		Effect.sync(() => {
			const keys = Redacted.make(
				"dev:" + Str.repeat(32)("11") + ",old:" + Str.repeat(32)("22"),
			)
			const first = Redacted.value(Development.developmentSecret(keys))
			assert.strictEqual(
				first,
				Redacted.value(Development.developmentSecret(keys)),
			)
			assert.ok(first.length >= 32)
			assert.notStrictEqual(
				first,
				Redacted.value(
					Development.developmentSecret(
						Redacted.make("dev:" + Str.repeat(32)("33")),
					),
				),
			)
		}),
)

it.effect(
	"development authentication accepts only origins on this computer in standard form",
	() =>
		Effect.gen(function* () {
			const decode = (publicOrigin: string) =>
				Schema.decodeEffect(Auth.Model.Configuration)({
					mode: "development",
					publicOrigin,
					secret: Redacted.make(authSecret),
				}).pipe(Effect.result)
			assert.strictEqual(
				(yield* decode("https://localhost:8443"))._tag,
				"Success",
			)
			assert.strictEqual(
				(yield* decode("https://127.0.0.1:8443"))._tag,
				"Success",
			)
			assert.strictEqual((yield* decode("https://[::1]:8443"))._tag, "Success")
			assert.strictEqual(
				(yield* decode("https://openbot.localhost"))._tag,
				"Success",
			)
			assert.strictEqual(
				(yield* decode("https://openbot.localhost.example.com"))._tag,
				"Failure",
			)
			assert.strictEqual(
				(yield* decode("https://e.example.com"))._tag,
				"Failure",
			)
			assert.strictEqual(
				(yield* decode("http://openbot.localhost"))._tag,
				"Success",
			)
			assert.strictEqual(
				(yield* decode("http://e.example.com"))._tag,
				"Failure",
			)
			assert.strictEqual(
				(yield* decode("https://localhost:8443/path"))._tag,
				"Failure",
			)
			assert.strictEqual((yield* decode("invalid"))._tag, "Failure")
		}),
)

// The servers here are real, so the test needs the real clock.
layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer), {
	excludeTestServices: true,
})((it) => {
	it.effect(
		"local login keeps normal sign-in sessions and Chats across a restart",
		() =>
			Effect.gen(function* () {
				const crypto = yield* Crypto.Crypto
				const database = yield* PostgresTest.start
				yield* Effect.acquireRelease(
					Effect.sync(() => {
						const actualFetch = globalThis.fetch
						return vi
							.spyOn(globalThis, "fetch")
							.mockImplementation(
								(input: Parameters<typeof fetch>[0], init?: RequestInit) => {
									const url = new URL(
										input instanceof Request ? input.url : String(input),
									)
									assert.notStrictEqual(
										url.origin,
										"https://id.example.com",
										"Development login must not contact the identity provider",
									)
									// @effect-diagnostics-next-line globalFetch:off -- The spy stands in for the global fetch that better-auth calls, so every other call must still reach the real network.
									return actualFetch(input, init)
								},
							)
					}),
					(network) => Effect.sync(() => network.mockRestore()),
				)
				const model = Config.Selection.make({
					provider: Provider.Id.make("test"),
					model: Model.Id.make("answer"),
				})
				const options = {
					host: "127.0.0.1",
					port: 0,
					// A Chat needs a model. This one gives the same short answer to each Turn.
					builtinModels: {
						providers: [{ id: model.provider, name: "Test" }],
						models: [
							Config.Model.make({
								provider: model.provider,
								id: model.model,
								name: "Answer",
								reasoningEfforts: [],
								serviceTiers: [],
							}),
						],
						resolve: () =>
							LanguageModel.make({
								generateText: () =>
									Effect.succeed([
										ModelResponse.makePart("text", { text: "answer" }),
									]),
								streamText: () =>
									Stream.make(
										ModelResponse.makePart("text-start", { id: "text" }),
										ModelResponse.makePart("text-delta", {
											id: "text",
											delta: "answer",
										}),
										ModelResponse.makePart("text-end", { id: "text" }),
										ModelResponse.makePart("finish", {
											reason: "stop",
											usage: ModelResponse.Usage.make({
												inputTokens: { total: 1 },
												outputTokens: { total: 1 },
											}),
										}),
									),
							}),
					},
					databaseUrl: Redacted.make(database.url),
					secretKeys: Redacted.make(
						"test:" +
							"1111111111111111111111111111111111111111111111111111111111111111",
					),
					auth: {
						mode: "development" as const,
						publicOrigin,
						secret: Redacted.make(authSecret),
					},
				}
				// The migration has its own database pool. It closes after the migration.
				yield* DatabasePostgres.migrate.pipe(
					Effect.provide(
						DatabasePostgres.layer(options).pipe(
							Layer.provide(NodeServices.layer),
						),
					),
				)
				const scope = yield* Effect.scope
				/**
				 * Starts the server in its own scope, so that a restart can stop it alone.
				 * A new memo map builds every layer again, as in a new process.
				 */
				const launch = Effect.gen(function* () {
					const serverScope = yield* Scope.fork(scope)
					const services = yield* Layer.buildWithMemoMap(
						Server.layerFixed(options).pipe(
							Layer.provide(Layer.merge(OpenBot.layerOutside, HostTools.none)),
							Layer.provideMerge(OpenBot.layerShared(options)),
						),
						yield* Layer.makeMemoMap,
						serverScope,
					)
					return {
						scope: serverScope,
						address: HttpServer.formatAddress(
							Context.get(services, HttpServer.HttpServer).address,
						),
					}
				})
				const server = yield* SynchronizedRef.make(yield* launch)
				const request = Effect.fnUntraced(function* (
					path: string,
					init: {
						readonly method?: HttpMethod.HttpMethod
						readonly headers?: Readonly<Record<string, string>>
						readonly payload?: unknown
					} = {},
				) {
					const { address } = yield* SynchronizedRef.get(server)
					const base = HttpClientRequest.make(init.method ?? "GET")(
						address + path,
						{ headers: init.headers ?? {} },
					)
					const response = yield* (
						init.payload === undefined
							? Effect.succeed(base)
							: HttpClientRequest.bodyJson(base, init.payload)
					).pipe(
						Effect.flatMap(HttpClient.execute),
						Effect.provideService(FetchHttpClient.RequestInit, {
							redirect: "manual",
						}),
					)
					if (Str.startsWith("/auth/")(path))
						assert.strictEqual(
							Option.getOrNull(Headers.get(response.headers, "cache-control")),
							"no-store",
						)
					return response
				})
				const status = (path: string, init?: Parameters<typeof request>[1]) =>
					Effect.map(request(path, init), (response) => response.status)
				const sessionInfo = (response: HttpClientResponse.HttpClientResponse) =>
					HttpClientResponse.schemaBodyJson(AuthApi.SessionInfo)(response)
				const login = Effect.gen(function* () {
					const response = yield* request("/auth/development/sign-in", {
						method: "POST",
						headers: { origin: publicOrigin },
						payload: {},
					})
					assert.strictEqual(response.status, 200)
					const cookie = Cookies.get(response.cookies, AuthApi.SessionCookie)
					assert.ok(Option.isSome(cookie))
					assert.strictEqual(cookie.value.options?.secure, true)
					assert.strictEqual(cookie.value.options?.httpOnly, true)
					assert.strictEqual(cookie.value.options?.sameSite, "lax")
					assert.strictEqual(maxAgeOf(cookie.value), 30 * 86400)
					return cookieHeader(cookie.value)
				})
				const session = yield* login
				let accountHeaders = { cookie: session, origin: publicOrigin }
				const send: Send = (path, method, payload) =>
					request(path, { method, headers: accountHeaders, payload })
				yield* Organizations.ensure(send)
				assert.strictEqual(yield* status("/auth/session"), 401)
				const infoResponse = yield* request("/auth/session", {
					headers: accountHeaders,
				})
				assert.strictEqual(infoResponse.status, 200)
				const info = yield* sessionInfo(infoResponse)
				assert.strictEqual(info.profile.name, "Local Developer")
				assert.strictEqual(info.profile.email, "developer@localhost.test")
				assert.strictEqual(
					yield* status("/v1/chats", { headers: accountHeaders }),
					200,
				)
				assert.strictEqual(
					Headers.has(
						(yield* request("/auth/callback/oidc?code=anything")).headers,
						"set-cookie",
					),
					false,
				)
				const secondSession = yield* login
				const same = yield* Effect.flatMap(
					request("/auth/session", { headers: { cookie: secondSession } }),
					sessionInfo,
				)
				assert.strictEqual(same.userId, info.userId)
				assert.deepStrictEqual(same.memberships, info.memberships)
				assert.notStrictEqual(secondSession, session)
				const newBot = {
					name: "Blocked",
					role: "Helps in tests",
					instructions: "Help the person.",
				}
				for (const origin of [undefined, "https://foreign.example"]) {
					const blocked = yield* request("/v1/bots", {
						method: "POST",
						headers: {
							cookie: session,
							...(origin === undefined ? {} : { origin }),
						},
						payload: newBot,
					})
					assert.strictEqual(blocked.status, 403)
				}
				const body = (path: string, init?: Parameters<typeof request>[1]) =>
					Effect.flatMap(request(path, init), (response) => response.json)
				assert.deepStrictEqual(
					yield* body("/v1/bots", { headers: accountHeaders }),
					[],
				)
				assert.deepStrictEqual(
					yield* body("/v1/chats", { headers: accountHeaders }),
					[],
				)
				for (const authorization of [
					"Bearer invalid",
					"Basic invalid",
					"Bearer",
					"",
				]) {
					const denied = yield* request("/v1/chats", {
						headers: { authorization },
					})
					assert.strictEqual(denied.status, 401)
					assert.deepStrictEqual(yield* denied.json, {
						_tag: "AuthenticationRequired",
					})
				}
				yield* DefaultBot.ensure(send)
				const saved = yield* bot(send, { name: "Saved", model })
				const receipt = yield* message(send, saved, "Keep this Chat")
				const path = "/v1/chats/" + receipt.chat
				assert.strictEqual(
					yield* status(path, { headers: accountHeaders }),
					200,
				)
				const renewalCookie = (
					response: HttpClientResponse.HttpClientResponse,
				) => {
					const cookie = Cookies.get(response.cookies, AuthApi.SessionCookie)
					assert.ok(
						Option.isSome(cookie),
						"Renewal must reach the browser through Set-Cookie",
					)
					assert.strictEqual(maxAgeOf(cookie.value), 30 * 86400)
					assert.strictEqual(cookie.value.options?.secure, true)
					assert.strictEqual(cookie.value.options?.httpOnly, true)
					assert.strictEqual(cookie.value.options?.sameSite, "lax")
					assert.strictEqual(cookie.value.options?.path, "/")
					assert.strictEqual(cookie.value.options?.domain, undefined)
					return cookieHeader(cookie.value)
				}
				const originalExpiration = Date.parse(info.expiresAt)
				const startedAt = yield* Clock.currentTimeMillis
				// Only Date is fake. Real timers keep the server going.
				yield* Effect.acquireRelease(
					Effect.sync(() => {
						vi.useFakeTimers({ toFake: ["Date"], now: startedAt })
					}),
					() =>
						Effect.sync(() => {
							vi.useRealTimers()
						}),
				)
				vi.advanceTimersByTime(61 * 60 * 1000)
				assert.strictEqual(
					yield* status("/auth/session", { headers: accountHeaders }),
					200,
				)
				vi.setSystemTime(startedAt + 2 * 86400000)
				for (const origin of [undefined, "https://foreign.example"]) {
					const denied = yield* request(`/v1/bots/${saved}/messages`, {
						method: "POST",
						headers: {
							cookie: session,
							...(origin === undefined ? {} : { origin }),
						},
						payload: { input: "Blocked renewal" },
					})
					assert.strictEqual(denied.status, 403)
					assert.strictEqual(Headers.has(denied.headers, "set-cookie"), false)
				}
				const renewed = yield* request("/auth/session", {
					headers: accountHeaders,
				})
				assert.strictEqual(renewed.status, 200)
				accountHeaders = { ...accountHeaders, cookie: renewalCookie(renewed) }
				const renewedInfo = yield* sessionInfo(renewed)
				assert.strictEqual(renewedInfo.userId, info.userId)
				assert.deepStrictEqual(renewedInfo.memberships, info.memberships)
				assert.ok(Date.parse(renewedInfo.expiresAt) > originalExpiration)
				const unchanged = yield* request("/auth/session", {
					headers: accountHeaders,
				})
				assert.strictEqual(unchanged.status, 200)
				assert.strictEqual(Headers.has(unchanged.headers, "set-cookie"), false)
				assert.strictEqual(
					(yield* sessionInfo(unchanged)).expiresAt,
					renewedInfo.expiresAt,
				)
				vi.advanceTimersByTime(2 * 86400000)
				const businessRenewal = yield* request(path, {
					headers: accountHeaders,
				})
				assert.strictEqual(businessRenewal.status, 200)
				accountHeaders = {
					...accountHeaders,
					cookie: renewalCookie(businessRenewal),
				}
				vi.advanceTimersByTime(2 * 86400000)
				const missing = yield* request(
					"/v1/chats/" + (yield* crypto.randomUUIDv4()),
					{ headers: accountHeaders },
				)
				assert.strictEqual(missing.status, 404)
				accountHeaders = { ...accountHeaders, cookie: renewalCookie(missing) }
				vi.setSystemTime(originalExpiration + 1)
				assert.strictEqual(
					yield* status(path, { headers: accountHeaders }),
					200,
				)
				const openapi = yield* Effect.flatMap(
					request("/openapi.json"),
					HttpClientResponse.schemaBodyJson(OpenApiDocument),
				)
				const sendPath = openapi.paths["/v1/bots/{botId}/messages"]
				assert.deepStrictEqual(sendPath?.post?.security, [
					{ token: [] },
					{ session: [] },
				])
				assert.deepStrictEqual(openapi.components.securitySchemes["token"], {
					type: "http",
					scheme: "Bearer",
				})
				assert.deepStrictEqual(openapi.components.securitySchemes["session"], {
					type: "apiKey",
					in: "cookie",
					name: AuthApi.SessionCookie,
				})
				assert.ok(sendPath?.post?.responses["403"])
				assert.ok(sendPath?.post?.responses["503"])
				yield* SynchronizedRef.updateEffect(server, (current) =>
					Scope.close(current.scope, Exit.void).pipe(Effect.andThen(launch)),
				)
				assert.strictEqual(
					yield* status(path, { headers: accountHeaders }),
					200,
				)
				assert.strictEqual(
					yield* status(path, { headers: accountHeaders }),
					200,
				)
				assert.strictEqual(
					yield* status("/auth/session", { headers: accountHeaders }),
					200,
				)
				const restartedSession = yield* login
				const restarted = yield* Effect.flatMap(
					request("/auth/session", {
						headers: { cookie: restartedSession },
					}),
					sessionInfo,
				)
				assert.strictEqual(restarted.userId, info.userId)
				assert.deepStrictEqual(restarted.memberships, info.memberships)
				assert.strictEqual(
					yield* status("/auth/sign-out", {
						method: "POST",
						payload: {},
						headers: { ...accountHeaders, origin: "https://foreign.example" },
					}),
					403,
				)
				assert.strictEqual(
					yield* status("/auth/sign-out", {
						method: "POST",
						payload: {},
						headers: accountHeaders,
					}),
					200,
				)
				assert.strictEqual(
					yield* status("/auth/session", { headers: accountHeaders }),
					401,
				)
				assert.strictEqual(
					yield* status(path, { headers: accountHeaders }),
					401,
				)
				assert.strictEqual(yield* status(path), 401)
				const signedInAgain = yield* login
				assert.strictEqual(
					yield* status(path, { headers: { cookie: signedInAgain } }),
					200,
				)
				vi.advanceTimersByTime(31 * 86400000)
				assert.strictEqual(
					yield* status("/auth/session", {
						headers: { cookie: signedInAgain },
					}),
					401,
				)
				assert.strictEqual(
					yield* status(path, { headers: { cookie: signedInAgain } }),
					401,
				)
			}),
		60000,
	)
})

// The probe API runs on a real test server, so this test needs the real clock.
it.live(
	"business authentication keeps session Origin checks and typed failures",
	() =>
		Effect.gen(function* () {
			const unavailable = yield* Ref.make(true)
			const failure = Effect.fail(
				Auth.Model.AuthUnavailable.make({ dependency: "storage" }),
			)
			const auth = Layer.mock(Auth.Auth, {
				handle: () => Effect.succeed(new Response(null, { status: 503 })),
				signInProvider: () => Effect.succeedNone,
				resolveSession: (credential) =>
					Redacted.value(credential) !== "signed-session"
						? Effect.fail(
								Auth.Model.CredentialRejected.make({ kind: "session" }),
							)
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
											profile: {},
											expiresAt: "2099-01-01T00:00:00.000Z",
											setCookies: [],
										}),
							),
			})
			const tokens = Layer.mock(Auth.Tokens, {
				authenticate: (credential) =>
					Redacted.value(credential) === "obut_valid"
						? Effect.succeed({
								kind: "user_token" as const,
								userId: "key-user",
								organizationId: "key-user",
								tokenId: UserTokensApi.TokenId.make("key-1"),
							})
						: Effect.fail(
								Auth.Model.CredentialRejected.make({ kind: "token" }),
							),
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
					Auth.HttpHandlers.layer.pipe(
						Layer.provide(OrganizationFixture.layerSettings({ publicOrigin })),
					),
				),
				Layer.provide(auth),
				Layer.provide(tokens),
				Layer.provide(OrganizationFixture.layerEveryoneAdministrator),
				Layer.provide(OrganizationFixture.layerUnusedPlatform),
				Layer.provide(OrganizationFixture.layerNoAudit),
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
				(yield* write({ ...cookie, origin: publicOrigin })).status,
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

it.effect(
	"return destinations accept same-origin client paths and reject open redirects",
	() =>
		Effect.sync(() => {
			const accepts = Schema.is(AuthApi.ReturnTo)
			for (const target of [
				"/",
				"/docs",
				"/developer/tests/test-1",
				"/apps?query=documents",
				"/chats/chat-1",
			])
				assert.strictEqual(accepts(target), true, target)
			for (const target of [
				"https://external.example/developer",
				"//external.example/developer",
				"/\\external.example",
				"/developer/../auth/callback",
				"/auth/login",
				"/v1/chats",
				"/development/sign-in",
			])
				assert.strictEqual(accepts(target), false, target)
		}),
)
