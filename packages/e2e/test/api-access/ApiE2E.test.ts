import { BrowserHost, Caller, Policies } from "@openbot-build/openbot/testing"
import { assert, layer } from "@effect/vitest"
import {
	Authorization,
	BillingApi,
	OpenBotApi,
	UserTokensApi,
	VaultsApi,
} from "@openbot-build/api"
import { Array as Arr, Effect, Record, Schema, String as Str } from "effect"
import { HttpClient, HttpClientRequest, type HttpMethod } from "effect/http"
import { OpenApi } from "effect/http-api"

const publicOrigin = "https://api-matrix.example.com"
const methods = [
	["get", "GET"],
	["post", "POST"],
	["put", "PUT"],
	["patch", "PATCH"],
	["delete", "DELETE"],
] as const

// These routes use a public read, a sign-in flow, or their own hook credential.
const publicRoutes = [
	"GET /auth/developer/apps/callback",
	"POST /v1/developer/inspect",
	"GET /v1/app-index/sources",
	"GET /v1/app-index/apps",
	"GET /v1/app-index/app",
	"GET /v1/apps/client-metadata",
	"GET /auth/apps/callback",
	"POST /v1/hooks/triggers/{triggerId}",
	"POST /v1/hooks/channels/{channelId}",
	"POST /v1/hooks/computers/pairings",
	"POST /v1/hooks/computers/pairings/{pairingId}/poll",
	"GET /v1/hooks/computers/connect",
	"POST /auth/sign-in",
	"GET /auth/options",
	"POST /auth/email/send",
	"POST /auth/email/verify",
	"GET /",
	"GET /health",
]

/** The live contract gives the routes that must check a caller. */
const protectedRoutes = () =>
	Arr.flatMap(
		Record.toEntries(OpenApi.fromApi(OpenBotApi).paths),
		([path, item]) =>
			Arr.flatMap(methods, ([name, method]) => {
				const operation = item[name]
				if (operation === undefined) return []
				const needsCaller = !Arr.contains(publicRoutes, `${method} ${path}`)
				assert.strictEqual(
					operation.security.length > 0,
					needsCaller,
					`${method} ${path}`,
				)
				return needsCaller
					? [
							{
								path,
								method,
								url: Str.replace(
									/\{[^}]+\}/g,
									"00000000-0000-4000-8000-000000000001",
								)(path),
							},
						]
					: []
			}),
	)

type Send = (
	path: string,
	method?: HttpMethod.HttpMethod,
	payload?: unknown,
) => Caller.Call

const status = (call: Caller.Call, expected: number) =>
	Effect.gen(function* () {
		const response = yield* call
		assert.strictEqual(response.status, expected, yield* response.text)
	})

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"every protected API route rejects a missing caller and every cookie write checks its Origin",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const alice = yield* host.login("api-matrix")
				const address = yield* host.address
				const routes = protectedRoutes()
				assert.isAbove(routes.length, 250)
				for (const route of routes) {
					const request = HttpClientRequest.make(route.method)(
						address + route.url,
					)
					const response = yield* HttpClient.execute(request)
					assert.strictEqual(
						response.status,
						401,
						`${route.method} ${route.path}: ${yield* response.text}`,
					)
					if (route.method === "GET") continue
					for (const origin of [undefined, "https://other.example.com"]) {
						const headers =
							origin === undefined
								? { cookie: Caller.sessionCookie(alice.session) }
								: { cookie: Caller.sessionCookie(alice.session), origin }
						const denied = yield* HttpClient.execute(
							request.pipe(HttpClientRequest.setHeaders(headers)),
						)
						assert.strictEqual(
							denied.status,
							403,
							`${route.method} ${route.path}: ${yield* denied.text}`,
						)
						assert.deepStrictEqual(yield* denied.json, {
							_tag: "ForbiddenOrigin",
						})
					}
				}
			}),
		{ timeout: 60000 },
	)

	it.effect(
		"cookie writes reject opaque and near-match origins without changing saved tokens",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const alice = yield* host.login("origin-boundary")
				const address = yield* host.address
				const account = Caller.withCookie({ address, publicOrigin })
				const tokens = Schema.Struct({
					items: Schema.Array(UserTokensApi.Token),
				})
				const before = yield* Caller.read(
					tokens,
					account(alice.session, "/v1/user/tokens"),
				)
				for (const origin of [
					"null",
					publicOrigin + "/",
					publicOrigin + ".attacker.example",
				]) {
					const denied = yield* Caller.withCookie({
						address,
						publicOrigin: origin,
					})(alice.session, "/v1/user/tokens", "POST", { name: "Denied write" })
					assert.strictEqual(denied.status, 403, origin)
					assert.deepStrictEqual(yield* denied.json, {
						_tag: "ForbiddenOrigin",
					})
				}
				assert.deepStrictEqual(
					yield* Caller.read(tokens, account(alice.session, "/v1/user/tokens")),
					before,
				)
				const created = yield* Caller.read(
					UserTokensApi.CreatedToken,
					account(alice.session, "/v1/user/tokens", "POST", {
						name: "Same origin",
					}),
					201,
				)
				const after = yield* Caller.read(
					tokens,
					account(alice.session, "/v1/user/tokens"),
				)
				assert.strictEqual(after.items.length, before.items.length + 1)
				assert.ok(
					Arr.some(after.items, (token) => token.id === created.token.id),
				)
			}),
		{ timeout: 60000 },
	)

	it.effect(
		"tokens and cookies keep Vault and budget writes, conflicts, owner checks and saved state the same",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin,
					sharedDomain: false,
				})
				const alice = yield* host.login("parity-alice")
				const bob = yield* host.login("parity-bob")
				const cookie =
					(session: typeof alice.session): Send =>
					(path, method, payload) =>
						Effect.flatMap(host.address, (address) =>
							Caller.withCookie({ address, publicOrigin })(
								session,
								path,
								method,
								payload,
							),
						)
				const token =
					(secret: UserTokensApi.CreatedToken["secret"]): Send =>
					(path, method, payload) =>
						Effect.flatMap(host.address, (address) =>
							Caller.withToken(address)(secret, path, method, payload),
						)
				const account = cookie(alice.session)
				const stranger = cookie(bob.session)
				const key = yield* Caller.read(
					UserTokensApi.CreatedToken,
					account("/v1/user/tokens", "POST", { name: "API test" }),
					201,
				)
				const otherKey = yield* Caller.read(
					UserTokensApi.CreatedToken,
					stranger("/v1/user/tokens", "POST", { name: "API test" }),
					201,
				)
				const readOnly = yield* Caller.read(
					UserTokensApi.CreatedToken,
					account("/v1/user/tokens", "POST", {
						name: "Read only",
						policy: yield* Policies.json(function* (_) {
							yield* _.allow("read", Authorization.Vault)
							yield* _.allow("read", Authorization.Budget)
						}),
					}),
					201,
				)
				for (const [name, send] of [
					["cookie", account],
					["token", token(key.secret)],
				] as const) {
					const vault = yield* Caller.read(
						VaultsApi.Vault,
						send("/v1/vaults", "POST", { name: "Secrets " + name }),
						201,
					)
					const path = `/v1/vaults/${vault.id}`
					const item = yield* Caller.read(
						VaultsApi.VaultItem,
						send(path + "/items", "POST", {
							name: "work",
							source: { _tag: "Builtin" },
							values: { token: "test-secret-that-must-stay-hidden" },
							exits: [],
						}),
						201,
					)
					const itemPath = `${path}/items/${item.id}`
					const changed = yield* Caller.read(
						VaultsApi.Vault,
						send(path, "PATCH", {
							expectedVersion: vault.version,
							name: "Changed " + name,
						}),
						200,
					)
					yield* status(
						send(path, "PATCH", {
							expectedVersion: vault.version,
							name: "Old write",
						}),
						409,
					)
					const changedItem = yield* Caller.read(
						VaultsApi.VaultItem,
						send(itemPath, "PATCH", {
							expectedVersion: item.version,
							description: "Work token",
						}),
						200,
					)
					yield* status(
						send(itemPath, "PATCH", {
							expectedVersion: item.version,
							description: "Old write",
						}),
						409,
					)
					for (const outsider of [stranger, token(otherKey.secret)]) {
						yield* status(outsider(path), 404)
						yield* status(outsider(itemPath), 404)
						yield* status(
							outsider(path, "PATCH", {
								expectedVersion: changed.version,
								name: "Other owner",
							}),
							404,
						)
						assert.deepStrictEqual(
							yield* Caller.read(
								Schema.Array(VaultsApi.Vault),
								outsider("/v1/vaults"),
							),
							[],
						)
					}
					yield* status(token(readOnly.secret)(path), 200)
					yield* status(
						token(readOnly.secret)(path, "PATCH", {
							expectedVersion: changed.version,
							name: "Read only write",
						}),
						403,
					)
					const budget = yield* Caller.read(
						BillingApi.Budget,
						send("/v1/organization/budgets", "POST", {
							scope: "organization",
							period: "day",
							limitMicros: 1000000,
							mode: "hard",
						}),
						201,
					)
					const budgetPath = `/v1/organization/budgets/${budget.id}`
					const changedBudget = yield* Caller.read(
						BillingApi.Budget,
						send(budgetPath, "PATCH", {
							expectedVersion: budget.version,
							limitMicros: 2000000,
						}),
						200,
					)
					yield* status(
						send(budgetPath, "PATCH", {
							expectedVersion: budget.version,
							limitMicros: 3000000,
						}),
						409,
					)
					for (const outsider of [stranger, token(otherKey.secret)])
						yield* status(outsider(budgetPath), 404)
					yield* status(token(readOnly.secret)(budgetPath), 200)
					yield* status(
						token(readOnly.secret)(budgetPath, "PATCH", {
							expectedVersion: changedBudget.version,
							limitMicros: 3000000,
						}),
						403,
					)
					for (const path of [
						"/v1/organization/usage",
						"/v1/organization/usage/events",
						"/v1/organization/credits",
						"/v1/organization/budgets",
					])
						yield* status(send(path), 200)
					yield* host.restart
					for (const reader of [account, token(key.secret)]) {
						assert.deepStrictEqual(
							yield* Caller.read(VaultsApi.Vault, reader(path)),
							changed,
						)
						assert.deepStrictEqual(
							yield* Caller.read(VaultsApi.VaultItem, reader(itemPath)),
							changedItem,
						)
						assert.deepStrictEqual(
							yield* Caller.read(BillingApi.Budget, reader(budgetPath)),
							changedBudget,
						)
						const response = yield* reader(path + "/items")
						assert.strictEqual(response.status, 200)
						assert.notInclude(
							yield* response.text,
							"test-secret-that-must-stay-hidden",
						)
					}
					yield* status(send(itemPath, "DELETE"), 204)
					yield* status(send(path, "DELETE"), 204)
					yield* status(send(path), 404)
					yield* status(send(budgetPath, "DELETE"), 204)
					yield* status(send(budgetPath), 404)
				}
				const kept = yield* Caller.read(
					VaultsApi.Vault,
					token(key.secret)("/v1/vaults", "POST", { name: "Kept" }),
					201,
				)
				const path = `/v1/vaults/${kept.id}`
				yield* status(account(`/v1/user/tokens/${key.token.id}`, "DELETE"), 204)
				yield* status(token(key.secret)(path), 401)
				yield* status(token(key.secret)(path, "DELETE"), 401)
				assert.deepStrictEqual(
					yield* Caller.read(VaultsApi.Vault, account(path)),
					kept,
				)
				yield* status(account(path, "DELETE"), 204)
			}),
		{ timeout: 60000 },
	)
})
