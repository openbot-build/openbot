import {
	Option,
	HashMap,
	ConfigProvider,
	Effect,
	Exit,
	Layer,
	ManagedRuntime,
	Redacted,
	Result,
	Stream,
} from "effect"
import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { createHash } from "node:crypto"
import { NodeServices } from "@effect/platform-node"
import {
	Auth,
	EnvironmentConfiguration,
	Server,
	DatabasePostgres,
} from "@openbot-build/platform"
import * as Backend from "../dist/app/Backend.js"
import { Session } from "@openbot-build/core"
import { AuthApi } from "@openbot-build/platform-api"

import { LanguageModel, Response } from "effect/ai"
import { FetchHttpClient, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import * as PostgresTest from "./PostgresTest.ts"

test(
	"signed OIDC login, session lifecycle, tenant isolation and PostgreSQL restart",
	{ timeout: 60000 },
	async (t) => {
		const database = await PostgresTest.start()
		const issuer = "https://id.example.com"
		const publicOrigin = "https://e.example.com"
		const pair = await generateKeyPair("EdDSA", { extractable: true })
		const publicKey = await exportJWK(pair.publicKey)
		let pending = HashMap.empty<string, { nonce: string; challenge: string }>()
		let accessSubject = ""
		let tokenCalls = 0
		let forged = false
		let wrongIdentity = false
		let providerUnavailable = false
		let publicClient = false
		const providerFetch: typeof globalThis.fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input))
			assert.equal(url.origin, issuer)
			const json = (body: unknown, status = 200) =>
				new globalThis.Response(JSON.stringify(body), {
					status,
					headers: { "content-type": "application/json" },
				})
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
			assert.equal(url.pathname, "/token")
			tokenCalls++
			const form = new URLSearchParams(
				await new globalThis.Response(init?.body).text(),
			)
			assert.equal(
				new Headers(init?.headers).get("authorization"),
				publicClient
					? null
					: "Basic " + Buffer.from("client:secret").toString("base64"),
			)
			assert.equal(form.get("client_secret"), null)
			if (publicClient) assert.equal(form.get("client_id"), "client")
			assert.equal(
				form.get("redirect_uri"),
				publicOrigin + "/auth/callback/oidc",
			)
			const [subject, state] = (form.get("code") ?? "").split(":")
			const transaction = Option.getOrUndefined(
				HashMap.get(pending, state ?? ""),
			)
			assert.ok(transaction)
			assert.equal(
				createHash("sha256")
					.update(form.get("code_verifier") ?? "")
					.digest("base64url"),
				transaction.challenge,
			)
			accessSubject = subject ?? ""
			const idToken = await new SignJWT({
				nonce: forged ? "wrong-nonce" : transaction.nonce,
			})
				.setProtectedHeader({ alg: "EdDSA", kid: "test" })
				.setIssuer(issuer)
				.setAudience("client")
				.setSubject(accessSubject)
				.setExpirationTime("1 hour")
				.sign(pair.privateKey)
			return json({
				access_token: "access",
				id_token: idToken,
				token_type: "Bearer",
				scope: "openid profile email",
			})
		}
		const actualFetch = globalThis.fetch
		const providerNetwork = mock.method(
			globalThis,
			"fetch",
			(input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const url = new URL(
					input instanceof Request ? input.url : String(input),
				)
				return url.origin === issuer
					? providerFetch(input, init)
					: actualFetch(input, init)
			},
		)
		t.after(() => providerNetwork.mock.restore())
		const model = Layer.effect(
			LanguageModel.LanguageModel,
			LanguageModel.make({
				generateText: () =>
					Effect.succeed([Response.makePart("text", { text: "answer" })]),
				streamText: () => importStream(),
			}),
		)
		const options = {
			host: "127.0.0.1",
			port: 0,
			databaseUrl: Redacted.make(database.url),
			appEncryptionKey: Redacted.make(
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
			ManagedRuntime.make(
				Server.layer({
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
					Layer.provide(
						Layer.merge(
							model,
							Layer.succeed(FetchHttpClient.Fetch, providerFetch),
						),
					),
				),
			)
		let runtime: ReturnType<typeof server> | undefined
		try {
			await using migration = ManagedRuntime.make(
				DatabasePostgres.layer(options).pipe(Layer.provide(NodeServices.layer)),
			)
			await using unmigrated = server()
			assert.ok(Exit.isFailure(await unmigrated.runPromiseExit(Effect.void)))
			await migration.runPromise(DatabasePostgres.migrate)
			runtime = server()
			let address = await runtime.runPromise(
				Effect.map(HttpServer.HttpServer, (value) =>
					HttpServer.formatAddress(value.address),
				),
			)
			const request = async (path: string, init: RequestInit = {}) => {
				const response = await fetch(address + path, {
					...init,
					redirect: "manual",
				})
				if (path.startsWith("/auth/") && !path.startsWith("/auth/api-keys"))
					assert.equal(response.headers.get("cache-control"), "no-store")
				return response
			}
			const login = async (subject: string) => {
				const response = await request("/auth/sign-in/social", {
					method: "POST",
					headers: { origin: publicOrigin, "content-type": "application/json" },
					body: JSON.stringify({
						provider: "oidc",
						callbackURL: publicOrigin + "/",
					}),
				})
				assert.equal(response.status, 200)
				const cookie = response.headers.get("set-cookie") ?? ""
				assert.match(cookie, /Secure/)
				assert.match(cookie, /HttpOnly/)
				assert.match(cookie, /SameSite=Lax/i)
				const authorization = new URL(
					((await response.json()) as { readonly url: string }).url,
				)
				assert.equal(authorization.origin, issuer)
				assert.ok(
					authorization.searchParams
						.get("scope")
						?.split(" ")
						.includes("openid"),
				)
				const state = authorization.searchParams.get("state") ?? ""
				pending = HashMap.set(pending, state, {
					nonce: authorization.searchParams.get("nonce") ?? "",
					challenge: authorization.searchParams.get("code_challenge") ?? "",
				})
				const callback = `/auth/callback/oidc?state=${state}&iss=${encodeURIComponent(issuer)}&code=${subject}:${state}`
				return { callback, cookie: cookie.split(";")[0]!, state }
			}
			const sessionCookie = (response: globalThis.Response) =>
				response.headers
					.getSetCookie()
					.find((value) => value.startsWith(AuthApi.SessionCookie + "="))
					?.split(";")[0] ?? ""
			/** Better Auth sends a failed callback to its error page and sets no session. */
			const rejected = (response: globalThis.Response) => {
				assert.equal(response.status, 302)
				assert.equal(sessionCookie(response), "")
				assert.ok(
					new URL(
						response.headers.get("location") ?? "",
						publicOrigin,
					).searchParams.has("error"),
				)
			}
			const complete = async (subject: string) => {
				const transaction = await login(subject)
				const response = await request(transaction.callback, {
					headers: { cookie: transaction.cookie },
				})
				assert.equal(response.status, 302)
				assert.equal(response.headers.get("location"), publicOrigin + "/")
				return { ...transaction, session: sessionCookie(response) }
			}
			const alice = await complete("alice")
			assert.ok(alice.session)
			const count = tokenCalls
			rejected(
				await request(alice.callback, { headers: { cookie: alice.cookie } }),
			)
			assert.equal(tokenCalls, count)
			const wrongBrowser = await login("bob")
			rejected(
				await request(wrongBrowser.callback, {
					headers: { cookie: AuthApi.LoginCookie + "=incorrect" },
				}),
			)
			const bobResponse = await request(wrongBrowser.callback, {
				headers: { cookie: wrongBrowser.cookie },
			})
			assert.equal(bobResponse.status, 302)
			const bobSession = sessionCookie(bobResponse)
			forged = true
			const bad = await login("alice")
			rejected(await request(bad.callback, { headers: { cookie: bad.cookie } }))
			forged = false
			wrongIdentity = true
			const wrong = await login("alice")
			rejected(
				await request(wrong.callback, { headers: { cookie: wrong.cookie } }),
			)
			wrongIdentity = false
			const expiredLogin = await login("alice")
			await migration.runPromise(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`UPDATE openbot_auth_verification SET expires_at = to_timestamp(0), value = jsonb_set(value::jsonb, '{expiresAt}', '0')::text WHERE identifier = ${"auth-state:" + expiredLogin.state}`,
				),
			)
			const beforeExpiredLogin = tokenCalls
			rejected(
				await request(expiredLogin.callback, {
					headers: { cookie: expiredLogin.cookie },
				}),
			)
			assert.equal(tokenCalls, beforeExpiredLogin)
			const repeated = await request(
				"/auth/callback/oidc?state=one&state=two&iss=bad&code=bad",
				{ headers: { cookie: alice.cookie } },
			)
			assert.equal(repeated.status, 400)
			assert.equal(sessionCookie(repeated), "")
			providerUnavailable = true
			await using unavailableRuntime = server()
			const unavailableAddress = await unavailableRuntime.runPromise(
				Effect.map(HttpServer.HttpServer, (server) =>
					HttpServer.formatAddress(server.address),
				),
			)
			assert.notEqual(
				(
					await fetch(unavailableAddress + "/auth/sign-in/social", {
						method: "POST",
						headers: {
							origin: publicOrigin,
							"content-type": "application/json",
						},
						body: JSON.stringify({ provider: "oidc" }),
					})
				).status,
				200,
			)
			providerUnavailable = false
			forged = false
			rejected(await request(bad.callback, { headers: { cookie: bad.cookie } }))
			for (const origin of [undefined, "https://foreign.example"]) {
				assert.equal(
					(
						await request("/auth/sign-out", {
							method: "POST",
							body: "{}",
							headers: {
								"content-type": "application/json",
								cookie: alice.session,
								...(origin === undefined ? {} : { origin }),
							},
						})
					).status,
					403,
				)
			}
			for (const [method, status] of [
				["GET", 200],
				["POST", 400],
				["DELETE", 404],
			] as const) {
				assert.equal(
					(
						await request(
							"/auth/api-keys" + (method === "DELETE" ? "/unknown" : ""),
							{
								method,
								headers: { cookie: alice.session, origin: publicOrigin },
							},
						)
					).status,
					status,
				)
			}
			assert.equal(
				(
					await request("/v1/sessions", {
						headers: { authorization: "Bearer retired" },
					})
				).status,
				401,
			)
			const session = async (
				cookie: string,
				path: string,
				method = "GET",
				payload?: unknown,
			) =>
				request(path, {
					method,
					headers: {
						cookie,
						origin: publicOrigin,
						...(payload === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
				})
			assert.equal((await request("/v1/sessions")).status, 401)
			const cookieSessions = await request("/v1/sessions", {
				headers: { cookie: alice.session },
			})
			assert.equal(cookieSessions.status, 200)
			assert.deepEqual(await cookieSessions.json(), [])
			const createdSession = await session(
				alice.session,
				"/v1/sessions",
				"POST",
				{ title: "Saved" },
			)
			assert.equal(createdSession.status, 201)
			const first: { session: { id: string; head: string; revision: number } } =
				await createdSession.json()
			const path = "/v1/sessions/" + first.session.id
			const cookieSession = await request(path, {
				headers: { cookie: alice.session },
			})
			assert.equal(cookieSession.status, 200)
			assert.deepEqual(await cookieSession.json(), first)
			for (const suffix of [
				"",
				"/history",
				"/record",
				"/memory",
				"/wait?after=" + first.session.revision + "&timeoutMs=0",
			]) {
				assert.equal((await session(bobSession, path + suffix)).status, 404)
				assert.equal(
					(await request(path + suffix, { headers: { cookie: bobSession } }))
						.status,
					404,
				)
			}
			for (const [suffix, method, payload] of [
				["", "PATCH", { title: "foreign", expected: first.session.revision }],
				["", "DELETE", undefined],
				["/fork", "POST", {}],
				["/turns/foreign/interrupt", "POST", {}],
				[
					"/turns",
					"POST",
					{ input: "foreign", expected: first.session.revision },
				],
				[
					"/memory",
					"POST",
					{
						expected: first.session.head,
						revision: first.session.revision,
						command: {
							_tag: "Remember",
							key: "foreign",
							content: "Foreign memory",
							kind: "fact",
						},
					},
				],
			] as const)
				assert.equal(
					(await session(bobSession, path + suffix, method, payload)).status,
					404,
				)
			assert.deepEqual(
				await (await session(bobSession, "/v1/sessions")).json(),
				[],
			)
			const bobConversation: { session: { id: string; head: string } } = await (
				await session(bobSession, "/v1/sessions", "POST", {})
			).json()
			assert.equal(
				(
					await session(
						bobSession,
						"/v1/sessions/" + bobConversation.session.id + "/merge",
						"POST",
						{
							source: {
								session: first.session.id,
								version: first.session.head,
							},
							targetVersion: bobConversation.session.head,
						},
					)
				).status,
				404,
			)
			const foreignRecord = await (
				await session(alice.session, path + "/record")
			).json()
			assert.equal(
				(
					await session(bobSession, path + "/record", "PUT", {
						record: foreignRecord,
						expected: first.session,
					})
				).status,
				404,
			)
			const message = await session(alice.session, path + "/turns", "POST", {
				input: "hello",
				expected: first.session.revision,
			})
			assert.equal(message.status, 202)
			const receipt: { id: string } = await message.json()
			const completeView = await runtime.runPromise(
				Effect.gen(function* () {
					const identity = yield* (yield* Auth.Auth).resolveSession(
						Redacted.make(decodeURIComponent(alice.session.split("=")[1]!)),
					)
					const backend = yield* Backend.Backend
					const service = yield* backend.get(identity.identity.tenantId)
					const wait = (
						view: Effect.Success<ReturnType<typeof service.get>>,
					): ReturnType<typeof service.get> =>
						view.activity === "active"
							? service
									.wait(view.session.id, view.session.revision, 20)
									.pipe(Effect.flatMap(wait))
							: Effect.succeed(view)
					return yield* wait(
						yield* service.get(Session.Id.make(first.session.id)),
					)
				}),
			)
			assert.equal(completeView.response?.id, receipt.id)
			assert.equal(completeView.response?.status, "completed")
			const record = await (
				await session(alice.session, path + "/record")
			).json()
			await runtime.dispose()
			runtime = server()
			address = await runtime.runPromise(
				Effect.map(HttpServer.HttpServer, (value) =>
					HttpServer.formatAddress(value.address),
				),
			)
			assert.deepEqual(
				await (await session(alice.session, path + "/record")).json(),
				record,
			)
			const nextAlice = await complete("alice")
			const sessionA = await (
				await request("/auth/session", { headers: { cookie: alice.session } })
			).json()
			const sessionB = await (
				await request("/auth/session", {
					headers: { cookie: nextAlice.session },
				})
			).json()
			assert.deepEqual(sessionA.identity, sessionB.identity)
			await migration.runPromise(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`UPDATE openbot_auth_session SET expires_at = to_timestamp(0) WHERE token = ${decodeURIComponent(nextAlice.session.split("=")[1]!).split(".")[0]}`,
				),
			)
			assert.equal(
				(
					await request("/auth/session", {
						headers: { cookie: nextAlice.session },
					})
				).status,
				401,
			)
			assert.equal(
				(
					await request("/auth/sign-out", {
						method: "POST",
						body: "{}",
						headers: {
							"content-type": "application/json",
							cookie: alice.session,
							origin: publicOrigin,
						},
					})
				).status,
				200,
			)
			assert.equal(
				(await request("/auth/session", { headers: { cookie: alice.session } }))
					.status,
				401,
			)
			assert.equal((await session(bobSession, "/v1/sessions")).status, 200)
			assert.equal((await request("/health")).status, 200)
			assert.equal((await request("/docs")).status, 200)
			await runtime.dispose()
			publicClient = true
			runtime = server()
			address = await runtime.runPromise(
				Effect.map(HttpServer.HttpServer, (value) =>
					HttpServer.formatAddress(value.address),
				),
			)
			const publicLogin = await complete("public-client-user")
			assert.ok(publicLogin.session)
			assert.equal(
				(
					await request("/auth/session", {
						headers: { cookie: publicLogin.session },
					})
				).status,
				200,
			)
		} finally {
			await runtime?.dispose()
			await database.close()
		}
	},
)

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

test("cloud startup rejects missing credentials and invalid ports", async () => {
	const missing = await Effect.runPromise(
		EnvironmentConfiguration.load.pipe(
			Effect.provideService(
				ConfigProvider.ConfigProvider,
				ConfigProvider.fromUnknown({}),
			),
			Effect.result,
		),
	)
	assert.equal(missing._tag, "Failure")
	const invalid = await Effect.runPromise(
		EnvironmentConfiguration.load.pipe(
			Effect.provideService(
				ConfigProvider.ConfigProvider,
				ConfigProvider.fromUnknown({
					OPENBOT_DATABASE_URL: "postgres://localhost/db",
					OPENBOT_APP_ENCRYPTION_KEY:
						"1111111111111111111111111111111111111111111111111111111111111111",
					OPENBOT_PUBLIC_ORIGIN: "https://e.example.com",
					OPENBOT_OIDC_ISSUER: "https://id.example.com",
					OPENBOT_OIDC_CLIENT_ID: "client",
					OPENBOT_OIDC_CLIENT_SECRET: "secret",
					BETTER_AUTH_SECRET:
						"IntegrationSecretForBetterAuthMustStayStable123456",
					OPENBOT_PORT: "invalid",
				}),
			),
			Effect.result,
		),
	)
	assert.equal(invalid._tag, "Failure")
	const tls = (files: Record<string, string>) =>
		Effect.runPromise(
			EnvironmentConfiguration.load.pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromUnknown({
						OPENBOT_DATABASE_URL: "postgres://localhost/db",
						OPENBOT_APP_ENCRYPTION_KEY:
							"1111111111111111111111111111111111111111111111111111111111111111",
						OPENBOT_PUBLIC_ORIGIN: "https://e.example.com",
						OPENBOT_OIDC_ISSUER: "https://id.example.com",
						OPENBOT_OIDC_CLIENT_ID: "client",
						BETTER_AUTH_SECRET:
							"IntegrationSecretForBetterAuthMustStayStable123456",
						...files,
					}),
				),
				Effect.result,
			),
		)
	const plain = await tls({})
	assert.ok(Result.isSuccess(plain))
	assert.equal(plain.success.tls, undefined)
	const secure = await tls({
		OPENBOT_TLS_CERT: "/certs/cert.pem",
		OPENBOT_TLS_KEY: "/certs/key.pem",
	})
	assert.ok(Result.isSuccess(secure))
	assert.deepEqual(secure.success.tls, {
		certFile: "/certs/cert.pem",
		keyFile: "/certs/key.pem",
	})
	assert.equal(
		(await tls({ OPENBOT_TLS_CERT: "/certs/cert.pem" }))._tag,
		"Failure",
	)
})

test("cloud startup accepts public PKCE clients with a missing or empty secret", async () => {
	const load = (clientSecret: string | undefined) =>
		Effect.runPromise(
			EnvironmentConfiguration.load.pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromUnknown({
						OPENBOT_DATABASE_URL: "postgres://localhost/db",
						OPENBOT_APP_ENCRYPTION_KEY:
							"1111111111111111111111111111111111111111111111111111111111111111",
						OPENBOT_PUBLIC_ORIGIN: "https://e.example.com",
						OPENBOT_OIDC_ISSUER: "https://id.example.com",
						OPENBOT_OIDC_CLIENT_ID: "client",
						...(clientSecret === undefined
							? {}
							: { OPENBOT_OIDC_CLIENT_SECRET: clientSecret }),
						BETTER_AUTH_SECRET:
							"IntegrationSecretForBetterAuthMustStayStable123456",
					}),
				),
			),
		)
	const absent = (await load(undefined)).auth
	const empty = (await load("")).auth
	const configured = (await load("secret")).auth
	assert.ok(absent.mode !== "development")
	assert.ok(empty.mode !== "development")
	assert.ok(configured.mode !== "development")
	assert.equal(absent.clientSecret, undefined)
	assert.equal(empty.clientSecret, undefined)
	assert.equal(Redacted.value(configured.clientSecret!), "secret")
})
