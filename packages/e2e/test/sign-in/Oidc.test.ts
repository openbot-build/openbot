import {
	Messages,
	Caller,
	PostgresTest,
	DefaultBot,
	Organizations,
} from "@openbot-build/openbot/testing"
import {
	Array as Arr,
	Context,
	Option,
	HashMap,
	Crypto,
	Effect,
	Exit,
	Layer,
	pipe,
	Redacted,
	Schema,
	Scope,
	Stream,
	String as Str,
} from "effect"
import { assert, layer, vi } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import {
	HostTools,
	OpenBot,
	Server,
	DatabasePostgres,
} from "@openbot-build/openbot"
import { Config, Model, Provider } from "@openbot-build/core"
import { AuthApi, BotsApi, ChatCommandReceipt } from "@openbot-build/api"

import { LanguageModel, Response } from "effect/ai"
import { Base64, Base64Url } from "effect/encoding"
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
import { SqlClient, type SqlError } from "effect/sql"
import { exportJWK, generateKeyPair, SignJWT } from "jose"

const { settled } = Messages

/** The services of the login test: the Node services and the fetch HTTP client. */
const platform = Layer.merge(NodeServices.layer, FetchHttpClient.layer)

const SignInStart = Schema.Struct({ url: Schema.String })
const ModelMissing = Schema.Struct({ reason: Schema.String })
const Items = Schema.Struct({ items: Schema.Array(Schema.Unknown) })

/** Reads the JSON body of an answer, as JSON with no schema. */
const body = (call: Caller.Call) =>
	Effect.flatMap(call, (response) => response.json)

// The servers and the database are real, so the test uses real time.
layer(platform, { excludeTestServices: true })((it) => {
	it.effect(
		"signed OIDC login, session lifecycle, member isolation and PostgreSQL restart",
		() =>
			Effect.gen(function* () {
				const crypto = yield* Crypto.Crypto
				const database = yield* PostgresTest.start
				const issuer = "https://id.example.com"
				const publicOrigin = "https://e.example.com"
				const pair = yield* Effect.promise(() =>
					generateKeyPair("EdDSA", { extractable: true }),
				)
				const publicKey = yield* Effect.promise(() => exportJWK(pair.publicKey))
				let pending = HashMap.empty<
					string,
					{ nonce: string; challenge: string }
				>()
				let accessSubject = ""
				let tokenCalls = 0
				let forged = false
				let wrongIdentity = false
				let providerUnavailable = false
				let publicClient = false
				const isIssuer = (input: string | URL | globalThis.Request) =>
					new URL(
						input instanceof globalThis.Request ? input.url : String(input),
					).origin === issuer
				/** Answers the calls of the server to the test identity provider. */
				const provider = Effect.fn("OpenBotTest.provider")(function* (
					request: globalThis.Request,
				) {
					const url = new URL(request.url)
					assert.strictEqual(url.origin, issuer)
					const json = (value: unknown, status = 200) =>
						globalThis.Response.json(value, { status })
					if (url.pathname === "/.well-known/openid-configuration")
						return providerUnavailable
							? json({}, 503)
							: json({
									issuer,
									authorization_endpoint: issuer + "/authorize",
									token_endpoint: issuer + "/token",
									userinfo_endpoint: issuer + "/userinfo",
									jwks_uri: issuer + "/jwks",
									code_challenge_methods_supported: ["S256"],
									token_endpoint_auth_methods_supported: [
										"client_secret_basic",
										"none",
									],
									id_token_signing_alg_values_supported: ["EdDSA"],
								})
					if (url.pathname === "/jwks")
						return json({
							keys: [{ ...publicKey, kid: "test", alg: "EdDSA", use: "sig" }],
						})
					if (url.pathname === "/userinfo")
						return json({
							sub: wrongIdentity ? "another-identity" : accessSubject,
							name: "Test User",
							email:
								(wrongIdentity ? "another-identity" : accessSubject) +
								"@example.com",
							email_verified: true,
						})
					assert.strictEqual(url.pathname, "/token")
					tokenCalls++
					const form = new URLSearchParams(
						yield* Effect.promise(() => request.text()),
					)
					assert.strictEqual(
						request.headers.get("authorization"),
						publicClient ? null : "Basic " + Base64.encode("client:secret"),
					)
					assert.strictEqual(form.get("client_secret"), null)
					if (publicClient) assert.strictEqual(form.get("client_id"), "client")
					assert.strictEqual(
						form.get("redirect_uri"),
						publicOrigin + "/auth/callback/oidc",
					)
					const [subject, state] = Str.split(":")(form.get("code") ?? "")
					const transaction = Option.getOrUndefined(
						HashMap.get(pending, state ?? ""),
					)
					assert.ok(transaction)
					const challenge = yield* crypto
						.digest(
							"SHA-256",
							new TextEncoder().encode(form.get("code_verifier") ?? ""),
						)
						.pipe(Effect.orDie)
					assert.strictEqual(Base64Url.encode(challenge), transaction.challenge)
					accessSubject = subject ?? ""
					const idToken = yield* Effect.promise(() =>
						new SignJWT({
							nonce: forged ? "wrong-nonce" : transaction.nonce,
						})
							.setProtectedHeader({ alg: "EdDSA", kid: "test" })
							.setIssuer(issuer)
							.setAudience("client")
							.setSubject(accessSubject)
							.setExpirationTime("1 hour")
							.sign(pair.privateKey),
					)
					return json({
						access_token: "access",
						id_token: idToken,
						token_type: "Bearer",
						scope: "openid profile email",
					})
				})
				const context = yield* Effect.context<never>()
				/** Gives the provider the shape of fetch, for code outside of Effect. */
				const providerFetch: typeof globalThis.fetch = (input, init) =>
					Effect.runPromiseWith(context)(
						provider(new globalThis.Request(input, init)),
					)
				// better-auth calls the global fetch, so the test sends its calls to the
				// identity provider, and puts the real fetch back at the end.
				yield* Effect.acquireRelease(
					Effect.sync(() => {
						const actual = globalThis.fetch
						return vi
							.spyOn(globalThis, "fetch")
							.mockImplementation((input, init) => {
								if (isIssuer(input)) return providerFetch(input, init)
								// @effect-diagnostics-next-line globalFetch:off -- better-auth calls the global fetch, so every other call must still reach the real network.
								return actual(input, init)
							})
					}),
					(spy) => Effect.sync(() => spy.mockRestore()),
				)
				const languageModel = LanguageModel.make({
					generateText: () =>
						Effect.succeed([Response.makePart("text", { text: "answer" })]),
					streamText: () => importStream(),
				})
				const testProvider = Provider.Id.make("test")
				const options = {
					host: "127.0.0.1",
					port: 0,
					// Every organization can use this model, so each test account can run a Turn.
					builtinModels: {
						providers: [{ id: testProvider, name: "Test" }],
						models: [
							Config.Model.make({
								provider: testProvider,
								id: Model.Id.make("answer"),
								name: "Answer",
								reasoningEfforts: [],
								serviceTiers: [],
							}),
						],
						resolve: () => languageModel,
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
						publicOrigin,
						issuer,
						clientId: "client",
						clientSecret: Redacted.make("secret"),
						secret: Redacted.make(
							"IntegrationSecretForBetterAuthMustStayStable123456",
						),
					},
				}
				const server = () =>
					Server.layerFixed({
						...options,
						auth: publicClient
							? {
									publicOrigin,
									issuer,
									clientId: "client",
									secret: options.auth.secret,
								}
							: options.auth,
					}).pipe(
						Layer.provide(Layer.merge(OpenBot.layerOutside, HostTools.none)),
						Layer.provideMerge(OpenBot.layerShared(options)),
						// The HTTP calls of the server go to the test identity provider.
						Layer.provide(FetchHttpClient.layer),
						Layer.provide(Layer.succeed(FetchHttpClient.Fetch, providerFetch)),
					)
				const scope = yield* Effect.scope
				/**
				 * Starts a server in its own scope, so that it can stop alone.
				 * A new memo map builds every layer again, as in a new process.
				 */
				const start = Effect.gen(function* () {
					const serverScope = yield* Scope.fork(scope)
					const services = yield* Layer.buildWithMemoMap(
						server(),
						yield* Layer.makeMemoMap,
						serverScope,
					)
					return {
						scope: serverScope,
						services,
						address: HttpServer.formatAddress(
							Context.get(services, HttpServer.HttpServer).address,
						),
					}
				})
				const migration = yield* Layer.build(
					DatabasePostgres.layer(options).pipe(
						Layer.provide(NodeServices.layer),
					),
				)
				/** Runs SQL on the test database, past the server. */
				const sql = (
					query: (
						client: SqlClient.SqlClient,
					) => Effect.Effect<unknown, SqlError.SqlError>,
				) =>
					Effect.provideContext(
						Effect.flatMap(SqlClient.SqlClient, query),
						migration,
					)
				assert.ok(Exit.isFailure(yield* Effect.exit(start)))
				yield* Effect.provideContext(DatabasePostgres.migrate, migration)
				let running = yield* start
				/** Stops the running server and starts a new one on the same database. */
				const restart = Effect.gen(function* () {
					yield* Scope.close(running.scope, Exit.void)
					running = yield* start
				})
				/** Calls the running server. It follows no redirect. */
				const request = (
					path: string,
					init: {
						readonly method?: HttpMethod.HttpMethod
						readonly headers?: Record<string, string>
						readonly payload?: unknown
					} = {},
				) =>
					Effect.gen(function* () {
						const base = HttpClientRequest.make(init.method ?? "GET")(
							running.address + path,
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
								Option.getOrNull(
									Headers.get(response.headers, "cache-control"),
								),
								"no-store",
							)
						return response
					})
				/** The value of a header, or null when the answer has none. */
				const header = (
					response: HttpClientResponse.HttpClientResponse,
					name: string,
				) => Option.getOrNull(Headers.get(response.headers, name))
				const login = Effect.fn("OpenBotTest.login")(function* (
					subject: string,
				) {
					const response = yield* request("/auth/sign-in/social", {
						method: "POST",
						headers: { origin: publicOrigin },
						payload: {
							provider: "oidc",
							callbackURL: publicOrigin + "/",
						},
					})
					assert.strictEqual(response.status, 200)
					const loginCookie = yield* Effect.fromOption(
						Cookies.get(response.cookies, AuthApi.LoginCookie),
					)
					assert.strictEqual(loginCookie.options?.secure, true)
					assert.strictEqual(loginCookie.options?.httpOnly, true)
					assert.strictEqual(loginCookie.options?.sameSite, "lax")
					const authorization = new URL(
						(yield* HttpClientResponse.schemaBodyJson(SignInStart)(response))
							.url,
					)
					assert.strictEqual(authorization.origin, issuer)
					assert.ok(
						pipe(
							Option.fromNullishOr(authorization.searchParams.get("scope")),
							Option.exists((scope) =>
								Arr.contains(Str.split(" ")(scope), "openid"),
							),
						),
					)
					const state = authorization.searchParams.get("state") ?? ""
					pending = HashMap.set(pending, state, {
						nonce: authorization.searchParams.get("nonce") ?? "",
						challenge: authorization.searchParams.get("code_challenge") ?? "",
					})
					const callback = `/auth/callback/oidc?state=${state}&iss=${encodeURIComponent(issuer)}&code=${subject}:${state}`
					return {
						callback,
						cookie: loginCookie.name + "=" + loginCookie.valueEncoded,
						state,
					}
				})
				/** The session cookie that an answer sets, as a cookie header, or "". */
				const sessionOf = (response: HttpClientResponse.HttpClientResponse) =>
					Option.match(Cookies.get(response.cookies, AuthApi.SessionCookie), {
						onNone: () => ({ session: "", token: "" }),
						onSome: (cookie) => ({
							session: cookie.name + "=" + cookie.valueEncoded,
							token: cookie.value,
						}),
					})
				const sessionCookie = (
					response: HttpClientResponse.HttpClientResponse,
				) => sessionOf(response).session
				/** Better Auth sends a failed callback to its error page and sets no session. */
				const rejected = (response: HttpClientResponse.HttpClientResponse) => {
					assert.strictEqual(response.status, 302)
					assert.strictEqual(sessionCookie(response), "")
					assert.ok(
						new URL(
							header(response, "location") ?? "",
							publicOrigin,
						).searchParams.has("error"),
					)
				}
				const complete = Effect.fn("OpenBotTest.complete")(function* (
					subject: string,
				) {
					const transaction = yield* login(subject)
					const response = yield* request(transaction.callback, {
						headers: { cookie: transaction.cookie },
					})
					assert.strictEqual(response.status, 302)
					assert.strictEqual(header(response, "location"), publicOrigin + "/")
					return { ...transaction, ...sessionOf(response) }
				})
				const alice = yield* complete("alice")
				assert.ok(alice.session)
				const count = tokenCalls
				rejected(
					yield* request(alice.callback, { headers: { cookie: alice.cookie } }),
				)
				assert.strictEqual(tokenCalls, count)
				const wrongBrowser = yield* login("bob")
				rejected(
					yield* request(wrongBrowser.callback, {
						headers: { cookie: AuthApi.LoginCookie + "=incorrect" },
					}),
				)
				const bobResponse = yield* request(wrongBrowser.callback, {
					headers: { cookie: wrongBrowser.cookie },
				})
				assert.strictEqual(bobResponse.status, 302)
				const bobSession = sessionCookie(bobResponse)
				const session = (
					cookie: string,
					path: string,
					method: HttpMethod.HttpMethod = "GET",
					payload?: unknown,
				) =>
					request(path, {
						method,
						headers: { cookie, origin: publicOrigin },
						payload,
					})
				// New accounts have no organization, so each one makes its own.
				for (const cookie of [alice.session, bobSession])
					yield* Organizations.ensure((path, method, payload) =>
						session(cookie, path, method, payload),
					)
				forged = true
				const bad = yield* login("alice")
				rejected(
					yield* request(bad.callback, { headers: { cookie: bad.cookie } }),
				)
				forged = false
				wrongIdentity = true
				const wrong = yield* login("alice")
				rejected(
					yield* request(wrong.callback, { headers: { cookie: wrong.cookie } }),
				)
				wrongIdentity = false
				const expiredLogin = yield* login("alice")
				yield* sql(
					(sql) =>
						sql`UPDATE openbot_auth_verification SET expires_at = to_timestamp(0), value = jsonb_set(value::jsonb, '{expiresAt}', '0')::text WHERE identifier = ${"auth-state:" + expiredLogin.state}`,
				)
				const beforeExpiredLogin = tokenCalls
				rejected(
					yield* request(expiredLogin.callback, {
						headers: { cookie: expiredLogin.cookie },
					}),
				)
				assert.strictEqual(tokenCalls, beforeExpiredLogin)
				const repeated = yield* request(
					"/auth/callback/oidc?state=one&state=two&iss=bad&code=bad",
					{ headers: { cookie: alice.cookie } },
				)
				assert.strictEqual(repeated.status, 400)
				assert.strictEqual(sessionCookie(repeated), "")
				providerUnavailable = true
				const unavailable = yield* start
				const unavailableSignIn = yield* HttpClientRequest.post(
					unavailable.address + "/auth/sign-in/social",
					{ headers: { origin: publicOrigin } },
				).pipe(
					HttpClientRequest.bodyJson({ provider: "oidc" }),
					Effect.flatMap(HttpClient.execute),
				)
				assert.notStrictEqual(unavailableSignIn.status, 200)
				providerUnavailable = false
				forged = false
				rejected(
					yield* request(bad.callback, { headers: { cookie: bad.cookie } }),
				)
				for (const origin of [undefined, "https://foreign.example"]) {
					assert.strictEqual(
						(yield* request("/auth/sign-out", {
							method: "POST",
							payload: {},
							headers: {
								cookie: alice.session,
								...(origin === undefined ? {} : { origin }),
							},
						})).status,
						403,
					)
				}
				for (const [method, status] of [
					["GET", 200],
					["POST", 400],
					["DELETE", 404],
				] as const) {
					assert.strictEqual(
						(yield* request(
							"/v1/user/tokens" + (method === "DELETE" ? "/unknown" : ""),
							{
								method,
								headers: { cookie: alice.session, origin: publicOrigin },
							},
						)).status,
						status,
					)
				}
				assert.strictEqual(
					(yield* request("/v1/chats", {
						headers: { authorization: "Bearer retired" },
					})).status,
					401,
				)
				assert.strictEqual((yield* request("/v1/chats")).status, 401)
				const cookieChats = yield* request("/v1/chats", {
					headers: { cookie: alice.session },
				})
				assert.strictEqual(cookieChats.status, 200)
				assert.deepStrictEqual(yield* cookieChats.json, [])
				const defaultBot = (cookie: string) =>
					DefaultBot.ensure((path, method, payload) =>
						session(cookie, path, method, payload),
					)
				const aliceDefault = yield* defaultBot(alice.session)
				yield* defaultBot(bobSession)
				// A Chat needs a model from its Bot. There is no default model.
				const withoutModel = yield* session(
					alice.session,
					`/v1/bots/${aliceDefault}/messages`,
					"POST",
					{ input: "hello", commandKey: "hello-no-model" },
				)
				assert.strictEqual(withoutModel.status, 400)
				assert.strictEqual(
					(yield* HttpClientResponse.schemaBodyJson(ModelMissing)(withoutModel))
						.reason,
					"missing",
				)
				const model = {
					_tag: "Config.Selection",
					provider: "test",
					model: "answer",
				}
				const aliceBot = yield* Effect.flatMap(
					session(alice.session, "/v1/bots", "POST", {
						name: "Answers",
						role: "Answers questions",
						instructions: "Answer the person.",
						model,
					}),
					Caller.json(Schema.toEncoded(BotsApi.Bot), 201),
				)
				const receipt = yield* Effect.flatMap(
					session(alice.session, `/v1/bots/${aliceBot.id}/messages`, "POST", {
						input: "hello",
						commandKey: "hello",
					}),
					Caller.json(Schema.toEncoded(ChatCommandReceipt), 202),
				)
				assert.ok(receipt.executionId.length > 0)
				const path = "/v1/chats/" + receipt.chat
				const cookieChat = yield* request(path, {
					headers: { cookie: alice.session },
				})
				assert.strictEqual(cookieChat.status, 200)
				assert.strictEqual(
					(yield* HttpClientResponse.schemaBodyJson(
						Schema.Struct({ chat: Schema.Struct({ id: Schema.String }) }),
					)(cookieChat)).chat.id,
					receipt.chat,
				)
				for (const suffix of [
					"",
					"/items",
					"/turns",
					"/turns/" + receipt.turn,
					"/todos",
					"/models",
					"/delegations",
				]) {
					assert.strictEqual(
						(yield* session(bobSession, path + suffix)).status,
						404,
					)
					assert.strictEqual(
						(yield* request(path + suffix, { headers: { cookie: bobSession } }))
							.status,
						404,
					)
				}
				for (const [suffix, method, payload] of [
					["", "PATCH", { expected: 0, mode: "plan" }],
					["", "DELETE", { commandKey: "denied-delete" }],
					["/interrupt", "POST", { commandKey: "denied-stop" }],
					["/messages", "POST", { input: "foreign", commandKey: "foreign" }],
					["/todos", "PUT", { revision: 0, items: [] }],
				] as const)
					assert.strictEqual(
						(yield* session(bobSession, path + suffix, method, payload)).status,
						404,
					)
				assert.deepStrictEqual(
					yield* body(session(bobSession, "/v1/chats")),
					[],
				)
				// Bob cannot talk to the Bot of Alice, so he cannot reach her Chat through it.
				assert.strictEqual(
					(yield* session(
						bobSession,
						`/v1/bots/${aliceBot.id}/messages`,
						"POST",
						{ input: "foreign", commandKey: "foreign" },
					)).status,
					404,
				)
				const completeView = yield* settled(
					(path, method, payload) =>
						session(alice.session, path, method, payload),
					receipt.chat,
				)
				assert.strictEqual(completeView.response?.id, receipt.turn)
				assert.strictEqual(completeView.response?.status, "completed")
				/** The Chat and its items, as JSON. */
				const snapshot = Effect.all({
					view: body(session(alice.session, path)),
					items: body(session(alice.session, path + "/items")),
				})
				const before = yield* snapshot
				assert.ok(
					(yield* Schema.decodeUnknownEffect(Items)(before.items)).items
						.length >= 2,
				)
				yield* restart
				assert.deepStrictEqual(yield* snapshot, before)
				const nextAlice = yield* complete("alice")
				const sessionInfo = (cookie: string) =>
					Effect.flatMap(
						request("/auth/session", { headers: { cookie } }),
						Caller.json(Schema.toEncoded(AuthApi.SessionInfo)),
					)
				const sessionA = yield* sessionInfo(alice.session)
				const sessionB = yield* sessionInfo(nextAlice.session)
				assert.strictEqual(sessionA.userId, sessionB.userId)
				assert.deepStrictEqual(sessionA.memberships, sessionB.memberships)
				yield* sql(
					(sql) =>
						sql`UPDATE openbot_auth_session SET expires_at = to_timestamp(0) WHERE token = ${Str.split(".")(nextAlice.token)[0]}`,
				)
				assert.strictEqual(
					(yield* request("/auth/session", {
						headers: { cookie: nextAlice.session },
					})).status,
					401,
				)
				assert.strictEqual(
					(yield* request("/auth/sign-out", {
						method: "POST",
						payload: {},
						headers: { cookie: alice.session, origin: publicOrigin },
					})).status,
					200,
				)
				assert.strictEqual(
					(yield* request("/auth/session", {
						headers: { cookie: alice.session },
					})).status,
					401,
				)
				assert.strictEqual(
					(yield* session(bobSession, "/v1/chats")).status,
					200,
				)
				assert.strictEqual((yield* request("/health")).status, 200)
				assert.strictEqual((yield* request("/docs")).status, 200)
				publicClient = true
				yield* restart
				const publicLogin = yield* complete("public-client-user")
				assert.ok(publicLogin.session)
				assert.strictEqual(
					(yield* request("/auth/session", {
						headers: { cookie: publicLogin.session },
					})).status,
					200,
				)
			}),
		{ timeout: 60000 },
	)
})

const importStream = () =>
	Stream.make(
		Response.makePart("text-start", { id: "text" }),
		Response.makePart("text-delta", { id: "text", delta: "answer" }),
		Response.makePart("text-end", { id: "text" }),
		Response.makePart("finish", {
			reason: "stop",
			usage: Response.Usage.make({
				inputTokens: { total: 3 },
				outputTokens: { total: 2 },
			}),
		}),
	)
