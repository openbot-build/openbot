import { assert, layer, vi } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import {
	DatabasePostgres,
	HostTools,
	OpenBot,
	Server,
} from "@openbot-build/openbot"
import { AuthApi } from "@openbot-build/api"
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
	HttpServer,
} from "effect/http"

import {
	PostgresTest,
	DefaultBot,
	Organizations,
	Messages,
} from "@openbot-build/openbot/testing"
const { bot, message } = Messages
type Send = Messages.Send

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
					clusterSecret: Redacted.make(
						"test-cluster-secret-with-at-least-32-characters",
					),
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
