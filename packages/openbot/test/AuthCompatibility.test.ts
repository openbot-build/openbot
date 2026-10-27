import { assert, layer } from "@effect/vitest"
import { Array as Arr, Effect, Option, Order, Schema, String as Str } from "effect"
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Settings } from "../src/settings/Settings.ts"
import * as BrowserHost from "./BrowserHost.ts"

const publicOrigin = "https://client.example.com"
const Code = Schema.fromJsonString(Schema.Struct({ subject: Schema.String, nonce: Schema.String }))

layer(BrowserHost.layerPlatform, {excludeTestServices: true})((it) => {
	it.effect("browser aliases keep configured scopes, callback, cookies and revocation", () => Effect.gen(function* () {
		const host = yield* BrowserHost.start({publicOrigin})
		yield* host.run(Effect.gen(function* () {
			const settings = yield* Settings
			const current = Option.getOrThrow(yield* settings.platform)
			yield* settings.updatePlatform(current.version, (document) => Effect.succeed({
				...document,
				browserAuth: {sessionCookie: "__Host-e-session", loginCookie: "__Host-e-login", sessionTtlMs: 86400000},
				identityProvider: document.identityProvider === null ? null : {
					...document.identityProvider,
					providerId: "kai", callbackPath: "/auth/callback",
					scopes: ["openid", "profile", "email", "offline_access"],
				},
			}))
		}))
		const address = yield* host.address
		const client = yield* HttpClient.HttpClient
		const get = (path: string, cookie?: string) => client.execute(HttpClientRequest.get(address + path, {
			headers: cookie === undefined ? {} : {cookie},
		})).pipe(Effect.provideService(FetchHttpClient.RequestInit, {redirect: "manual"}))
		const login = yield* get("/auth/login?returnTo=%2Fsessions%2Fexisting")
		assert.strictEqual(login.status, 303)
		const authorization = new URL(login.headers["location"]!)
		assert.deepStrictEqual(Arr.sort(Str.split(authorization.searchParams.get("scope")!, " "), Order.String), ["email", "offline_access", "openid", "profile"])
		assert.strictEqual(authorization.searchParams.get("redirect_uri"), publicOrigin + "/auth/callback")
		assert.strictEqual(authorization.searchParams.get("code_challenge_method"), "S256")
		assert.ok(authorization.searchParams.get("state"))
		assert.ok(authorization.searchParams.get("nonce"))
		assert.ok(Option.isSome(Cookies.getValue(login.cookies, "__Host-e-login")))
		const code = yield* Schema.encodeEffect(Code)({subject: "alice", nonce: authorization.searchParams.get("nonce")!})
		const query = new URLSearchParams({state: authorization.searchParams.get("state")!, iss: "https://id.example.com", code})
		const callback = yield* get("/auth/callback?" + query, Cookies.toCookieHeader(login.cookies))
		assert.strictEqual(callback.status, 303)
		assert.strictEqual(callback.headers["location"], publicOrigin + "/sessions/existing")
		assert.ok(Option.isSome(Cookies.getValue(callback.cookies, "__Host-e-session")))
		const cookie = Cookies.toCookieHeader(callback.cookies)
		assert.strictEqual((yield* get("/auth/session", cookie)).status, 200)
		assert.strictEqual((yield* get("/v1/chats", cookie)).status, 403)
		assert.strictEqual((yield* get("/auth/callback?" + query, Cookies.toCookieHeader(login.cookies))).status, 401)
		const logout = yield* client.execute(HttpClientRequest.post(address + "/auth/logout", {headers: {cookie, origin: publicOrigin}}))
		assert.strictEqual(logout.status, 204)
		assert.strictEqual((yield* get("/auth/session", cookie)).status, 401)
		assert.strictEqual((yield* get("/auth/login?returnTo=%2F%2Fevil.example")).status, 400)
		assert.strictEqual((yield* get("/auth/callback?state=a&state=b")).status, 400)
		assert.strictEqual((yield* client.execute(HttpClientRequest.post(address + "/auth/logout", {headers: {origin: "https://evil.example"}}))).status, 403)
	}))
	it.effect("the default provider scopes still work without compatibility settings", () => Effect.gen(function* () {
		const host = yield* BrowserHost.start({publicOrigin})
		const client = yield* HttpClient.HttpClient
		const login = yield* client.get((yield* host.address) + "/auth/login").pipe(Effect.provideService(FetchHttpClient.RequestInit, {redirect: "manual"}))
		assert.strictEqual(login.status, 303)
		const authorization = new URL(login.headers["location"]!)
		assert.deepStrictEqual(Str.split(authorization.searchParams.get("scope")!, " "), ["openid", "profile", "email"])
		const user = yield* host.login("alice")
		assert.ok(user.identity.userId)
	}))
})
