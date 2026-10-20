import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import {
	Auth,
	DatabasePostgres,
	EnvironmentConfiguration,
	Server,
} from "@openbot-build/platform"
import {
	AuthApi,
	Caller,
	Identity,
	PlatformApi,
} from "@openbot-build/platform-api"
import {
	ConfigProvider,
	Effect,
	Layer,
	ManagedRuntime,
	Redacted,
	Result,
	Schema,
} from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	OpenApi,
} from "effect/http-api"
import * as PostgresTest from "./PostgresTest.ts"

const environment = {
	OPENBOT_DATABASE_URL: "postgres://localhost/development",
	OPENBOT_APP_ENCRYPTION_KEY:
		"1111111111111111111111111111111111111111111111111111111111111111",
	OPENBOT_PUBLIC_ORIGIN: "https://localhost:8443",
	BETTER_AUTH_SECRET: "DevelopmentIntegrationSecretMustStayStable123456",
}
const load = (values: Record<string, string>) =>
	Effect.runPromise(
		EnvironmentConfiguration.load.pipe(
			Effect.provideService(
				ConfigProvider.ConfigProvider,
				ConfigProvider.fromUnknown(values),
			),
			Effect.result,
		),
	)

test("development authentication must be turned on explicitly and needs no OIDC credentials", async () => {
	assert.equal((await load(environment))._tag, "Failure")
	assert.equal(
		(await load({ ...environment, OPENBOT_DEV_MODE: "0" }))._tag,
		"Failure",
	)
	assert.equal(
		(await load({ ...environment, OPENBOT_DEV_MODE: "invalid" }))._tag,
		"Failure",
	)
	assert.equal(
		(await load({ ...environment, OPENBOT_DEV_MODE: "" }))._tag,
		"Failure",
	)
	const development = await load({
		...environment,
		OPENBOT_DEV_MODE: "1",
		OPENBOT_OIDC_ISSUER: "https://id.example.com",
		OPENBOT_OIDC_CLIENT_ID: "",
		OPENBOT_OIDC_CLIENT_SECRET: "",
	})
	assert.ok(Result.isSuccess(development))
	assert.equal(development.success.auth.mode, "development")
	assert.equal("clientId" in development.success.auth, false)
	const oidc = await load({
		...environment,
		OPENBOT_DEV_MODE: "0",
		OPENBOT_OIDC_ISSUER: "https://id.example.com",
		OPENBOT_OIDC_CLIENT_ID: "client",
		OPENBOT_OIDC_CLIENT_SECRET: "secret",
	})
	assert.ok(Result.isSuccess(oidc))
	assert.equal(oidc.success.auth.mode, "oidc")
	const { BETTER_AUTH_SECRET: _, ...withoutSecret } = environment
	assert.equal(
		(await load({ ...withoutSecret, OPENBOT_DEV_MODE: "1" }))._tag,
		"Failure",
	)
})

test("development authentication accepts only loopback HTTPS origins in standard form", async () => {
	const decode = (publicOrigin: string) =>
		Effect.runPromise(
			Schema.decodeEffect(Auth.Model.Configuration)({
				mode: "development",
				publicOrigin,
				secret: Redacted.make(environment.BETTER_AUTH_SECRET),
			}).pipe(Effect.result),
		)
	assert.equal((await decode("https://localhost:8443"))._tag, "Success")
	assert.equal((await decode("https://127.0.0.1:8443"))._tag, "Success")
	assert.equal((await decode("https://[::1]:8443"))._tag, "Success")
	assert.equal((await decode("https://e.example.com"))._tag, "Failure")
	assert.equal((await decode("http://localhost:8443"))._tag, "Failure")
	assert.equal((await decode("https://localhost:8443/path"))._tag, "Failure")
	assert.equal((await decode("invalid"))._tag, "Failure")
})

test(
	"local login keeps normal sign-in sessions and work Sessions across a restart",
	{ timeout: 60000 },
	async (t) => {
		const database = await PostgresTest.start()
		const publicOrigin = environment.OPENBOT_PUBLIC_ORIGIN
		const actualFetch = globalThis.fetch
		const network = mock.method(
			globalThis,
			"fetch",
			(input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const url = new URL(
					input instanceof Request ? input.url : String(input),
				)
				assert.notEqual(
					url.origin,
					"https://id.example.com",
					"Development login must not contact the identity provider",
				)
				return actualFetch(input, init)
			},
		)
		t.after(() => network.mock.restore())
		const options = {
			host: "127.0.0.1",
			port: 0,
			databaseUrl: Redacted.make(database.url),
			appEncryptionKey: Redacted.make(
				"1111111111111111111111111111111111111111111111111111111111111111",
			),
			auth: {
				mode: "development" as const,
				publicOrigin,
				secret: Redacted.make(environment.BETTER_AUTH_SECRET),
			},
		}
		const server = () => ManagedRuntime.make(Server.layer(options))
		let runtime: ReturnType<typeof server> | undefined
		try {
			await using migration = ManagedRuntime.make(
				DatabasePostgres.layer(options).pipe(Layer.provide(NodeServices.layer)),
			)
			await migration.runPromise(DatabasePostgres.migrate)
			runtime = server()
			let address = await runtime.runPromise(
				Effect.map(HttpServer.HttpServer, (server) =>
					HttpServer.formatAddress(server.address),
				),
			)
			const request = async (path: string, init: RequestInit = {}) => {
				const response = await fetch(address + path, {
					...init,
					redirect: "manual",
				})
				if (path.startsWith("/auth/"))
					assert.equal(response.headers.get("cache-control"), "no-store")
				return response
			}
			const login = async () => {
				const response = await request("/auth/login")
				assert.equal(response.status, 303)
				assert.equal(response.headers.get("location"), publicOrigin + "/")
				const cookie =
					response.headers
						.getSetCookie()
						.find((value) => value.startsWith(AuthApi.SessionCookie + "=")) ??
					""
				assert.match(cookie, /Secure/)
				assert.match(cookie, /HttpOnly/)
				assert.match(cookie, /SameSite=Lax/i)
				assert.equal(Number(cookie.match(/Max-Age=(\d+)/i)?.[1]), 30 * 86400)
				return cookie.split(";")[0]!
			}
			const session = await login()
			const accountHeaders = { cookie: session, origin: publicOrigin }
			assert.equal((await request("/auth/session")).status, 401)
			const infoResponse = await request("/auth/session", {
				headers: accountHeaders,
			})
			assert.equal(infoResponse.status, 200)
			const info: typeof AuthApi.SessionInfo.Type = await infoResponse.json()
			assert.equal(info.profile.name, "Local Developer")
			assert.equal(info.profile.email, "developer@localhost.test")
			assert.equal(
				(await request("/v1/sessions", { headers: accountHeaders })).status,
				200,
			)
			assert.equal((await request("/auth/callback?code=anything")).status, 400)
			const secondSession = await login()
			const same: typeof AuthApi.SessionInfo.Type = await (
				await request("/auth/session", { headers: { cookie: secondSession } })
			).json()
			assert.deepEqual(same.identity, info.identity)
			assert.notEqual(secondSession, session)
			for (const origin of [undefined, "https://foreign.example"]) {
				const blocked = await request("/v1/sessions", {
					method: "POST",
					headers: {
						cookie: session,
						...(origin === undefined ? {} : { origin }),
						"content-type": "application/json",
					},
					body: JSON.stringify({ title: "Blocked" }),
				})
				assert.equal(blocked.status, 403)
			}
			assert.deepEqual(
				await (
					await request("/v1/sessions", { headers: accountHeaders })
				).json(),
				[],
			)
			for (const authorization of [
				"Bearer invalid",
				"Basic invalid",
				"Bearer",
				"",
			]) {
				const denied = await request("/v1/sessions", {
					headers: { authorization },
				})
				assert.equal(denied.status, 401)
				assert.deepEqual(await denied.json(), {
					_tag: "AuthenticationRequired",
				})
			}
			const created = await request("/v1/sessions", {
				method: "POST",
				headers: { ...accountHeaders, "content-type": "application/json" },
				body: JSON.stringify({
					title: "Saved development Session",
				}),
			})
			assert.equal(created.status, 201)
			const saved: { session: { id: string } } = await created.json()
			const path = "/v1/sessions/" + saved.session.id
			assert.equal(
				(await request(path, { headers: accountHeaders })).status,
				200,
			)
			const renewalCookie = (response: Response) => {
				const cookie = response.headers
					.getSetCookie()
					.find((value) => value.startsWith(AuthApi.SessionCookie + "="))
				assert.ok(cookie, "Renewal must reach the browser through Set-Cookie")
				assert.equal(Number(cookie.match(/Max-Age=(\d+)/i)?.[1]), 30 * 86400)
				assert.equal(/Secure/.test(cookie), true)
				assert.equal(/HttpOnly/.test(cookie), true)
				assert.equal(/SameSite=Lax/i.test(cookie), true)
				assert.equal(/Path=\//i.test(cookie), true)
				assert.equal(/Domain=/i.test(cookie), false)
				return cookie.split(";")[0]!
			}
			const originalExpiration = Date.parse(info.expiresAt)
			const startedAt = Date.now()
			t.mock.timers.enable({ apis: ["Date"], now: startedAt })
			t.mock.timers.tick(61 * 60 * 1000)
			assert.equal(
				(await request("/auth/session", { headers: accountHeaders })).status,
				200,
			)
			t.mock.timers.setTime(startedAt + 2 * 86400000)
			for (const origin of [undefined, "https://foreign.example"]) {
				const denied = await request("/v1/sessions", {
					method: "POST",
					headers: {
						cookie: session,
						...(origin === undefined ? {} : { origin }),
						"content-type": "application/json",
					},
					body: JSON.stringify({ title: "Blocked renewal" }),
				})
				assert.equal(denied.status, 403)
				assert.equal(denied.headers.getSetCookie().length, 0)
			}
			const renewed = await request("/auth/session", {
				headers: accountHeaders,
			})
			assert.equal(renewed.status, 200)
			accountHeaders.cookie = renewalCookie(renewed)
			const renewedInfo: typeof AuthApi.SessionInfo.Type = await renewed.json()
			assert.deepEqual(renewedInfo.identity, info.identity)
			assert.ok(Date.parse(renewedInfo.expiresAt) > originalExpiration)
			const unchanged = await request("/auth/session", {
				headers: accountHeaders,
			})
			assert.equal(unchanged.status, 200)
			assert.equal(unchanged.headers.getSetCookie().length, 0)
			assert.equal((await unchanged.json()).expiresAt, renewedInfo.expiresAt)
			t.mock.timers.tick(2 * 86400000)
			const businessRenewal = await request(path, { headers: accountHeaders })
			assert.equal(businessRenewal.status, 200)
			accountHeaders.cookie = renewalCookie(businessRenewal)
			t.mock.timers.tick(2 * 86400000)
			const missing = await request("/v1/sessions/" + crypto.randomUUID(), {
				headers: accountHeaders,
			})
			assert.equal(missing.status, 404)
			accountHeaders.cookie = renewalCookie(missing)
			t.mock.timers.setTime(originalExpiration + 1)
			assert.equal(
				(await request(path, { headers: accountHeaders })).status,
				200,
			)
			const openapi = await (await request("/openapi.json")).json()
			assert.deepEqual(openapi.paths["/v1/sessions"].post.security, [
				{ apiKey: [] },
				{ session: [] },
			])
			assert.deepEqual(openapi.components.securitySchemes.apiKey, {
				type: "http",
				scheme: "Bearer",
			})
			assert.deepEqual(openapi.components.securitySchemes.session, {
				type: "apiKey",
				in: "cookie",
				name: AuthApi.SessionCookie,
			})
			assert.ok(openapi.paths["/v1/sessions"].post.responses[403])
			assert.ok(openapi.paths["/v1/sessions"].post.responses[503])
			await runtime.dispose()
			runtime = server()
			address = await runtime.runPromise(
				Effect.map(HttpServer.HttpServer, (server) =>
					HttpServer.formatAddress(server.address),
				),
			)
			assert.equal(
				(await request(path, { headers: accountHeaders })).status,
				200,
			)
			assert.equal(
				(await request(path, { headers: accountHeaders })).status,
				200,
			)
			assert.equal(
				(await request("/auth/session", { headers: accountHeaders })).status,
				200,
			)
			const restartedSession = await login()
			const restarted: typeof AuthApi.SessionInfo.Type = await (
				await request("/auth/session", {
					headers: { cookie: restartedSession },
				})
			).json()
			assert.deepEqual(restarted.identity, info.identity)
			assert.equal(
				(
					await request("/auth/logout", {
						method: "POST",
						headers: { ...accountHeaders, origin: "https://foreign.example" },
					})
				).status,
				403,
			)
			assert.equal(
				(
					await request("/auth/logout", {
						method: "POST",
						headers: accountHeaders,
					})
				).status,
				204,
			)
			assert.equal(
				(await request("/auth/session", { headers: accountHeaders })).status,
				401,
			)
			assert.equal(
				(await request(path, { headers: accountHeaders })).status,
				401,
			)
			assert.equal((await request(path)).status, 401)
			const signedInAgain = await login()
			assert.equal(
				(await request(path, { headers: { cookie: signedInAgain } })).status,
				200,
			)
			t.mock.timers.tick(31 * 86400000)
			const expired = await request("/auth/session", {
				headers: { cookie: signedInAgain },
			})
			assert.equal(expired.status, 401)
			assert.equal(
				(await request(path, { headers: { cookie: signedInAgain } })).status,
				401,
			)
		} finally {
			await runtime?.dispose()
			await database.close()
		}
	},
)

test("business authentication keeps session Origin checks and typed failures", async () => {
	const publicOrigin = environment.OPENBOT_PUBLIC_ORIGIN
	let unavailable = true
	const failure = Effect.fail(
		Auth.Model.AuthUnavailable.make({ dependency: "storage" }),
	)
	const auth = Layer.succeed(Auth.Auth, {
		startLogin: () => failure,
		completeLogin: () => failure,
		logout: () => failure,
		resolveSession: (credential) =>
			Redacted.value(credential) !== "signed-session"
				? Effect.fail(Auth.Model.CredentialRejected.make({ kind: "session" }))
				: unavailable
					? failure
					: Effect.succeed({
							identity: { userId: "session-user", tenantId: "session-user" },
							profile: {},
							expiresAt: "2099-01-01T00:00:00.000Z",
							setCookies: [],
						}),
	})
	const apiKeys = Layer.succeed(Auth.ApiKeys, {
		create: () => Effect.die("unused"),
		list: () => Effect.die("unused"),
		revoke: () => Effect.die("unused"),
		authenticate: (credential) =>
			Redacted.value(credential) === "obk_valid"
				? Effect.succeed({ userId: "key-user", tenantId: "key-user" })
				: Effect.fail(Auth.Model.CredentialRejected.make({ kind: "apiKey" })),
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
			.middleware(AuthApi.AgentAuth),
	)
	const handlers = HttpApiBuilder.group(api, "probe", (handlers) =>
		handlers.handle("identity", () => Identity).handle("write", () => Identity),
	)
	const app = HttpRouter.toWebHandler(
		HttpApiBuilder.layer(api).pipe(
			Layer.provide(handlers),
			Layer.provide(Auth.HttpHandlers.layer({ publicOrigin })),
			Layer.provide(auth),
			Layer.provide(apiKeys),
			Layer.provide(HttpServer.layerServices),
		),
		{ disableLogger: true },
	)
	const cookie = { cookie: AuthApi.SessionCookie + "=signed-session" }
	try {
		const failed = await app.handler(
			new Request(publicOrigin + "/identity", { headers: cookie }),
		)
		assert.equal(failed.status, 503)
		assert.deepEqual(await failed.json(), { _tag: "AuthenticationUnavailable" })
		unavailable = false
		const session = await app.handler(
			new Request(publicOrigin + "/identity", { headers: cookie }),
		)
		assert.deepEqual(await session.json(), {
			userId: "session-user",
			tenantId: "session-user",
		})
		for (const headers of [
			{},
			{ authorization: "Bearer retired" },
			{ cookie: AuthApi.SessionCookie + "=invalid" },
		]) {
			assert.equal(
				(
					await app.handler(
						new Request(publicOrigin + "/identity", { headers }),
					)
				).status,
				401,
			)
		}
		const write = (headers: Record<string, string>) =>
			app.handler(
				new Request(publicOrigin + "/identity", {
					method: "POST",
					headers: { ...headers, "content-type": "application/json" },
					body: "{}",
				}),
			)
		assert.equal((await write(cookie)).status, 403)
		assert.equal(
			(await write({ ...cookie, origin: "https://other.example" })).status,
			403,
		)
		assert.equal((await write({ ...cookie, origin: publicOrigin })).status, 200)
		assert.equal((await write({ authorization: "Bearer retired" })).status, 401)
		const keyed = await write({ authorization: "Bearer obk_valid" })
		assert.equal(keyed.status, 200)
		assert.deepEqual(await keyed.json(), {
			userId: "key-user",
			tenantId: "key-user",
		})
		const spec = OpenApi.fromApi(PlatformApi)
		assert.deepEqual(spec.paths["/v1/sessions"]?.post?.security, [
			{ apiKey: [] },
			{ session: [] },
		])
		assert.equal(spec.components.securitySchemes["bearer"], undefined)
		assert.deepEqual(spec.components.securitySchemes["session"], {
			type: "apiKey",
			in: "cookie",
			name: AuthApi.SessionCookie,
		})
	} finally {
		await app.dispose()
	}
})

test("return destinations accept same-origin client paths and reject open redirects", () => {
	const accepts = Schema.is(AuthApi.ReturnTo)
	for (const target of [
		"/",
		"/docs",
		"/developer/tests/test-1",
		"/apps?query=documents",
		"/sessions/session-1",
	])
		assert.equal(accepts(target), true, target)
	for (const target of [
		"https://external.example/developer",
		"//external.example/developer",
		"/\\external.example",
		"/developer/../auth/callback",
		"/auth/login",
		"/v1/sessions",
		"/development/sign-in",
	])
		assert.equal(accepts(target), false, target)
})
