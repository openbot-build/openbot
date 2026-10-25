import { assert, it, onTestFinished, vi } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Auth, DatabasePostgres, Server } from "@openbot-build/openbot"
import { AuthApi, Caller, Identity, OpenBotApi } from "@openbot-build/api"
import { Config, Model, Provider } from "@openbot-build/core"
import {
	Effect,
	Layer,
	ManagedRuntime,
	Option,
	Redacted,
	Schema,
	Stream,
} from "effect"
import { LanguageModel, Response as ModelResponse } from "effect/ai"
import { HttpRouter, HttpServer } from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	OpenApi,
} from "effect/http-api"
import * as PostgresTest from "./PostgresTest.ts"
import * as Development from "../dist/Development.js"
import * as OrganizationFixture from "./OrganizationFixture.ts"
import * as DefaultBot from "./DefaultBot.ts"
import * as Organizations from "./Organizations.ts"
import { bot, message, type Send } from "./Messages.ts"

const publicOrigin = "https://localhost:8443"
const authSecret = "DevelopmentIntegrationSecretMustStayStable123456"

it("the development sign-in secret comes from the first secret key and stays the same", () => {
	const keys = Redacted.make(
		"dev:" + "11".repeat(32) + ",old:" + "22".repeat(32),
	)
	const first = Redacted.value(Development.developmentSecret(keys))
	assert.strictEqual(first, Redacted.value(Development.developmentSecret(keys)))
	assert.ok(first.length >= 32)
	assert.notStrictEqual(
		first,
		Redacted.value(
			Development.developmentSecret(Redacted.make("dev:" + "33".repeat(32))),
		),
	)
})

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

it(
	"local login keeps normal sign-in sessions and Chats across a restart",
	{ timeout: 60000 },
	async () => {
		const database = await PostgresTest.start()
		const actualFetch = globalThis.fetch
		const network = vi
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
					return actualFetch(input, init)
				},
			)
		onTestFinished(() => network.mockRestore())
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
		const server = () => ManagedRuntime.make(Server.layerFixed(options))
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
					assert.strictEqual(response.headers.get("cache-control"), "no-store")
				return response
			}
			const login = async () => {
				const response = await request("/auth/development/sign-in", {
					method: "POST",
					headers: { origin: publicOrigin, "content-type": "application/json" },
					body: "{}",
				})
				assert.strictEqual(response.status, 200)
				const cookie =
					response.headers
						.getSetCookie()
						.find((value) => value.startsWith(AuthApi.SessionCookie + "=")) ??
					""
				assert.match(cookie, /Secure/)
				assert.match(cookie, /HttpOnly/)
				assert.match(cookie, /SameSite=Lax/i)
				assert.strictEqual(
					Number(cookie.match(/Max-Age=(\d+)/i)?.[1]),
					30 * 86400,
				)
				return cookie.split(";")[0]!
			}
			const session = await login()
			const accountHeaders = { cookie: session, origin: publicOrigin }
			await Organizations.ensure((path, method, payload) =>
				request(path, {
					method,
					headers: { ...accountHeaders, "content-type": "application/json" },
					...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
				}),
			)
			assert.strictEqual((await request("/auth/session")).status, 401)
			const infoResponse = await request("/auth/session", {
				headers: accountHeaders,
			})
			assert.strictEqual(infoResponse.status, 200)
			const info: typeof AuthApi.SessionInfo.Type = await infoResponse.json()
			assert.strictEqual(info.profile.name, "Local Developer")
			assert.strictEqual(info.profile.email, "developer@localhost.test")
			assert.strictEqual(
				(await request("/v1/chats", { headers: accountHeaders })).status,
				200,
			)
			assert.strictEqual(
				(await request("/auth/callback/oidc?code=anything")).headers.has(
					"set-cookie",
				),
				false,
			)
			const secondSession = await login()
			const same: typeof AuthApi.SessionInfo.Type = await (
				await request("/auth/session", { headers: { cookie: secondSession } })
			).json()
			assert.strictEqual(same.userId, info.userId)
			assert.deepStrictEqual(same.memberships, info.memberships)
			assert.notStrictEqual(secondSession, session)
			const newBot = {
				name: "Blocked",
				role: "Helps in tests",
				instructions: "Help the person.",
			}
			for (const origin of [undefined, "https://foreign.example"]) {
				const blocked = await request("/v1/bots", {
					method: "POST",
					headers: {
						cookie: session,
						...(origin === undefined ? {} : { origin }),
						"content-type": "application/json",
					},
					body: JSON.stringify(newBot),
				})
				assert.strictEqual(blocked.status, 403)
			}
			assert.deepStrictEqual(
				await (await request("/v1/bots", { headers: accountHeaders })).json(),
				[],
			)
			assert.deepStrictEqual(
				await (await request("/v1/chats", { headers: accountHeaders })).json(),
				[],
			)
			for (const authorization of [
				"Bearer invalid",
				"Basic invalid",
				"Bearer",
				"",
			]) {
				const denied = await request("/v1/chats", {
					headers: { authorization },
				})
				assert.strictEqual(denied.status, 401)
				assert.deepStrictEqual(await denied.json(), {
					_tag: "AuthenticationRequired",
				})
			}
			await DefaultBot.ensure((path, method, payload) =>
				request(path, {
					method,
					headers: { ...accountHeaders, "content-type": "application/json" },
					...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
				}),
			)
			const send: Send = (path, method, payload) =>
				request(path, {
					method,
					headers: { ...accountHeaders, "content-type": "application/json" },
					...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
				})
			const saved = await bot(send, { name: "Saved", model })
			const receipt = await message(send, saved, "Keep this Chat")
			const path = "/v1/chats/" + receipt.chat
			assert.strictEqual(
				(await request(path, { headers: accountHeaders })).status,
				200,
			)
			const renewalCookie = (response: Response) => {
				const cookie = response.headers
					.getSetCookie()
					.find((value) => value.startsWith(AuthApi.SessionCookie + "="))
				assert.ok(cookie, "Renewal must reach the browser through Set-Cookie")
				assert.strictEqual(
					Number(cookie.match(/Max-Age=(\d+)/i)?.[1]),
					30 * 86400,
				)
				assert.strictEqual(/Secure/.test(cookie), true)
				assert.strictEqual(/HttpOnly/.test(cookie), true)
				assert.strictEqual(/SameSite=Lax/i.test(cookie), true)
				assert.strictEqual(/Path=\//i.test(cookie), true)
				assert.strictEqual(/Domain=/i.test(cookie), false)
				return cookie.split(";")[0]!
			}
			const originalExpiration = Date.parse(info.expiresAt)
			const startedAt = Date.now()
			// Only Date is fake. Real timers keep the server going.
			vi.useFakeTimers({ toFake: ["Date"], now: startedAt })
			onTestFinished(() => {
				vi.useRealTimers()
			})
			vi.advanceTimersByTime(61 * 60 * 1000)
			assert.strictEqual(
				(await request("/auth/session", { headers: accountHeaders })).status,
				200,
			)
			vi.setSystemTime(startedAt + 2 * 86400000)
			for (const origin of [undefined, "https://foreign.example"]) {
				const denied = await request(`/v1/bots/${saved}/messages`, {
					method: "POST",
					headers: {
						cookie: session,
						...(origin === undefined ? {} : { origin }),
						"content-type": "application/json",
					},
					body: JSON.stringify({ input: "Blocked renewal" }),
				})
				assert.strictEqual(denied.status, 403)
				assert.strictEqual(denied.headers.getSetCookie().length, 0)
			}
			const renewed = await request("/auth/session", {
				headers: accountHeaders,
			})
			assert.strictEqual(renewed.status, 200)
			accountHeaders.cookie = renewalCookie(renewed)
			const renewedInfo: typeof AuthApi.SessionInfo.Type = await renewed.json()
			assert.strictEqual(renewedInfo.userId, info.userId)
			assert.deepStrictEqual(renewedInfo.memberships, info.memberships)
			assert.ok(Date.parse(renewedInfo.expiresAt) > originalExpiration)
			const unchanged = await request("/auth/session", {
				headers: accountHeaders,
			})
			assert.strictEqual(unchanged.status, 200)
			assert.strictEqual(unchanged.headers.getSetCookie().length, 0)
			assert.strictEqual(
				(await unchanged.json()).expiresAt,
				renewedInfo.expiresAt,
			)
			vi.advanceTimersByTime(2 * 86400000)
			const businessRenewal = await request(path, { headers: accountHeaders })
			assert.strictEqual(businessRenewal.status, 200)
			accountHeaders.cookie = renewalCookie(businessRenewal)
			vi.advanceTimersByTime(2 * 86400000)
			const missing = await request("/v1/chats/" + crypto.randomUUID(), {
				headers: accountHeaders,
			})
			assert.strictEqual(missing.status, 404)
			accountHeaders.cookie = renewalCookie(missing)
			vi.setSystemTime(originalExpiration + 1)
			assert.strictEqual(
				(await request(path, { headers: accountHeaders })).status,
				200,
			)
			const openapi = await (await request("/openapi.json")).json()
			const sendPath = openapi.paths["/v1/bots/{botId}/messages"]
			assert.deepStrictEqual(sendPath.post.security, [
				{ token: [] },
				{ session: [] },
			])
			assert.deepStrictEqual(openapi.components.securitySchemes.token, {
				type: "http",
				scheme: "Bearer",
			})
			assert.deepStrictEqual(openapi.components.securitySchemes.session, {
				type: "apiKey",
				in: "cookie",
				name: AuthApi.SessionCookie,
			})
			assert.ok(sendPath.post.responses[403])
			assert.ok(sendPath.post.responses[503])
			await runtime.dispose()
			runtime = server()
			address = await runtime.runPromise(
				Effect.map(HttpServer.HttpServer, (server) =>
					HttpServer.formatAddress(server.address),
				),
			)
			assert.strictEqual(
				(await request(path, { headers: accountHeaders })).status,
				200,
			)
			assert.strictEqual(
				(await request(path, { headers: accountHeaders })).status,
				200,
			)
			assert.strictEqual(
				(await request("/auth/session", { headers: accountHeaders })).status,
				200,
			)
			const restartedSession = await login()
			const restarted: typeof AuthApi.SessionInfo.Type = await (
				await request("/auth/session", {
					headers: { cookie: restartedSession },
				})
			).json()
			assert.strictEqual(restarted.userId, info.userId)
			assert.deepStrictEqual(restarted.memberships, info.memberships)
			assert.strictEqual(
				(
					await request("/auth/sign-out", {
						method: "POST",
						body: "{}",
						headers: {
							"content-type": "application/json",
							...accountHeaders,
							origin: "https://foreign.example",
						},
					})
				).status,
				403,
			)
			assert.strictEqual(
				(
					await request("/auth/sign-out", {
						method: "POST",
						body: "{}",
						headers: { ...accountHeaders, "content-type": "application/json" },
					})
				).status,
				200,
			)
			assert.strictEqual(
				(await request("/auth/session", { headers: accountHeaders })).status,
				401,
			)
			assert.strictEqual(
				(await request(path, { headers: accountHeaders })).status,
				401,
			)
			assert.strictEqual((await request(path)).status, 401)
			const signedInAgain = await login()
			assert.strictEqual(
				(await request(path, { headers: { cookie: signedInAgain } })).status,
				200,
			)
			vi.advanceTimersByTime(31 * 86400000)
			const expired = await request("/auth/session", {
				headers: { cookie: signedInAgain },
			})
			assert.strictEqual(expired.status, 401)
			assert.strictEqual(
				(await request(path, { headers: { cookie: signedInAgain } })).status,
				401,
			)
		} finally {
			await runtime?.dispose()
			await database.close()
		}
	},
)

it("business authentication keeps session Origin checks and typed failures", async () => {
	let unavailable = true
	const failure = Effect.fail(
		Auth.Model.AuthUnavailable.make({ dependency: "storage" }),
	)
	const auth = Layer.succeed(Auth.Auth, {
		handler: () => Promise.resolve(new Response(null, { status: 503 })),
		signInProvider: () => Option.none(),
		startSignIn: () => Effect.die("unused"),
		resolveSession: (credential) =>
			Redacted.value(credential) !== "signed-session"
				? Effect.fail(Auth.Model.CredentialRejected.make({ kind: "session" }))
				: unavailable
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
	})
	const tokens = Layer.succeed(Auth.Tokens, {
		create: () => Effect.die("unused"),
		list: () => Effect.die("unused"),
		revoke: () => Effect.die("unused"),
		find: () => Effect.die("unused"),
		authenticate: (credential) =>
			Redacted.value(credential) === "obut_valid"
				? Effect.succeed({
						kind: "user_token" as const,
						userId: "key-user",
						organizationId: "key-user",
						tokenId: "key-1",
					})
				: Effect.fail(Auth.Model.CredentialRejected.make({ kind: "token" })),
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
		handlers.handle("identity", () => Identity).handle("write", () => Identity),
	)
	const app = HttpRouter.toWebHandler(
		HttpApiBuilder.layer(api).pipe(
			Layer.provide(handlers),
			Layer.provide(Auth.HttpHandlers.layer({ publicOrigin })),
			Layer.provide(auth),
			Layer.provide(tokens),
			Layer.provide(OrganizationFixture.layerEveryoneAdministrator),
			Layer.provide(OrganizationFixture.layerUnusedPlatform),
			Layer.provide(OrganizationFixture.layerNoAudit),
			Layer.provide(HttpServer.layerServices),
		),
		{ disableLogger: true },
	)
	const cookie = { cookie: AuthApi.SessionCookie + "=signed-session" }
	try {
		const failed = await app.handler(
			new Request(publicOrigin + "/identity", { headers: cookie }),
		)
		assert.strictEqual(failed.status, 503)
		assert.deepStrictEqual(await failed.json(), {
			_tag: "AuthenticationUnavailable",
		})
		unavailable = false
		const session = await app.handler(
			new Request(publicOrigin + "/identity", { headers: cookie }),
		)
		assert.deepStrictEqual(await session.json(), {
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
		assert.strictEqual((await write(cookie)).status, 403)
		assert.strictEqual(
			(await write({ ...cookie, origin: "https://other.example" })).status,
			403,
		)
		assert.strictEqual(
			(await write({ ...cookie, origin: publicOrigin })).status,
			200,
		)
		assert.strictEqual(
			(await write({ authorization: "Bearer retired" })).status,
			401,
		)
		const keyed = await write({ authorization: "Bearer obut_valid" })
		assert.strictEqual(keyed.status, 200)
		assert.deepStrictEqual(await keyed.json(), {
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
	} finally {
		await app.dispose()
	}
})

it("return destinations accept same-origin client paths and reject open redirects", () => {
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
})
