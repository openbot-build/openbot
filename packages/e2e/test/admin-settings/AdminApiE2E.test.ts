import { NodeServices, NodeCrypto } from "@effect/platform-node"
import { CreatedToken } from "@openbot-build/domain/Tokens"
import { Domain, SsoConnection } from "@openbot-build/domain/Sso"
import {
	Model,
	ModelProvider,
	ModelCatalog,
} from "@openbot-build/domain/Models"
import { SecretProvider } from "@openbot-build/domain/Vaults"
import { BrowserHost, Caller, Outside } from "@openbot-build/server-testing"
import { assert, layer } from "@effect/vitest"
import { Array as Arr, Effect, Ref, Schema, String as Str, Layer } from "effect"
import { type HttpMethod, FetchHttpClient } from "effect/http"

const publicOrigin = "https://admin-api.example.com"
const Failure = Schema.Struct({ _tag: Schema.String })
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

const failure = (call: Caller.Call, expected: number, tag: string) =>
	Effect.gen(function* () {
		const value = yield* Caller.read(Failure, call, expected)
		assert.strictEqual(value._tag, tag)
	})

/** Each account has its own organization and uses both kinds of credential. */
const callers = Effect.fn("AdminApiE2E.callers")(function* (
	host: BrowserHost.Host,
) {
	const alice = yield* host.login("admin-alice")
	const bob = yield* host.login("admin-bob")
	const address = yield* host.address
	const cookie = Caller.withCookie({ address, publicOrigin })
	const token = Caller.withToken(address)
	const aliceToken = yield* Caller.read(
		CreatedToken,
		cookie(alice.session, "/v1/user/tokens", "POST", { name: "Admin test" }),
		201,
	)
	const bobToken = yield* Caller.read(
		CreatedToken,
		cookie(bob.session, "/v1/user/tokens", "POST", { name: "Other test" }),
		201,
	)
	const cookieSend: Send = (path, method, payload) =>
		cookie(alice.session, path, method, payload)
	const tokenSend: Send = (path, method, payload) =>
		token(aliceToken.secret, path, method, payload)
	const foreignCookie: Send = (path, method, payload) =>
		cookie(bob.session, path, method, payload)
	const foreignToken: Send = (path, method, payload) =>
		token(bobToken.secret, path, method, payload)
	return [
		{
			name: "cookie",
			send: cookieSend,
			other: tokenSend,
			foreign: foreignCookie,
		},
		{
			name: "token",
			send: tokenSend,
			other: cookieSend,
			foreign: foreignToken,
		},
	] as const
})

// The tests send real HTTP requests to a server with a new PostgreSQL database.
layer(
	Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer),
	{
		excludeTestServices: true,
	},
)((it) => {
	it.effect(
		"cookies and tokens manage SSO while secrets and other organizations stay private",
		() =>
			Effect.gen(function* () {
				const records = yield* Ref.make<ReadonlyArray<string>>([])
				const host = yield* BrowserHost.start({
					publicOrigin,
					sharedDomain: false,
					domainControl: Outside.domainControl({
						tokens: () => Ref.get(records),
					}),
				})
				for (const { name, send, other, foreign } of yield* callers(host)) {
					const domainName = name + ".example.com"
					const domainPath = "/v1/organization/domains/" + domainName
					const connections = "/v1/organization/sso_connections"
					const secret = "test-sso-private-1234"
					const input = {
						name: "Company " + name,
						issuer: "https://sso.example.com",
						clientId: "openbot",
						clientSecret: secret,
						domains: [domainName],
						enforce: false,
					}
					yield* failure(
						send(connections, "POST", input),
						400,
						"SsoConnectionInvalid",
					)
					const domain = yield* Caller.read(
						Domain,
						send("/v1/organization/domains", "POST", { domain: domainName }),
					)
					yield* Ref.set(records, [domain.recordValue])
					yield* status(send(domainPath + "/verify", "POST"), 200)
					const created = yield* send(connections, "POST", input)
					const value = yield* Caller.json(SsoConnection, 200)(created)
					assert.isFalse(Str.includes(secret)(yield* created.text))
					assert.deepStrictEqual(value.clientSecret, {
						set: true,
						hint: "…1234",
					})
					assert.strictEqual(
						value.redirectUri,
						publicOrigin + "/auth/callback/" + value.id,
					)
					const path = connections + "/" + value.id
					const read = yield* Caller.read(SsoConnection, other(path), 200)
					assert.strictEqual(read.name, input.name)
					const listed = yield* Caller.read(
						Schema.Struct({ items: Schema.Array(SsoConnection) }),
						send(connections),
					)
					assert.deepStrictEqual(
						Arr.map(listed.items, (entry) => entry.id),
						[value.id],
					)
					yield* status(foreign(path), 404)
					yield* status(
						foreign(path, "PATCH", {
							expectedVersion: value.version,
							name: "Other",
						}),
						404,
					)
					yield* status(foreign(path, "DELETE"), 404)
					yield* failure(send(domainPath, "DELETE"), 409, "DomainInUse")
					const updated = yield* Caller.read(
						SsoConnection,
						send(path, "PATCH", {
							expectedVersion: value.version,
							name: "Changed company",
						}),
					)
					assert.strictEqual(updated.name, "Changed company")
					assert.deepStrictEqual(updated.clientSecret, value.clientSecret)
					yield* failure(
						other(path, "PATCH", {
							expectedVersion: value.version,
							name: "Old change",
						}),
						409,
						"SsoConnectionConflict",
					)
					assert.strictEqual(
						(yield* Caller.read(SsoConnection, other(path))).name,
						"Changed company",
					)
					yield* status(send(path, "DELETE"), 204)
					yield* status(other(path), 404)
					yield* status(send(domainPath, "DELETE"), 204)
				}
			}),
		120000,
	)
	it.effect(
		"cookies and tokens manage model providers without giving out keys or crossing organizations",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin,
					sharedDomain: false,
					registryModels: true,
				})
				for (const { name, send, other, foreign } of yield* callers(host)) {
					const models = "/v1/organization/models"
					const providers = "/v1/organization/model_providers"
					const catalogPath = "/v1/organization/model_catalog"
					const model = yield* Caller.read(
						Model,
						send(models, "POST", {
							id: "admin-" + name,
							name: "Small model",
							reasoningEfforts: [],
							serviceTiers: [],
							contextWindow: 8000,
						}),
						200,
					)
					const modelPath = models + "/" + model.id
					const secret = "test-model-private-1234"
					const created = yield* send(providers, "POST", {
						kind: "openai-compat",
						name: "Model provider " + name,
						endpoint: "https://models.example.com/v1",
						apiKey: secret,
						models: [{ model: model.id, modelOwner: "organization" }],
					})
					const provider = yield* Caller.json(ModelProvider, 200)(created)
					assert.isFalse(Str.includes(secret)(yield* created.text))
					assert.deepStrictEqual(provider.apiKey, { set: true, hint: "…1234" })
					const path = providers + "/" + provider.id
					const read = yield* Caller.read(ModelProvider, other(path))
					assert.strictEqual(read.name, provider.name)
					assert.deepStrictEqual(read.apiKey, provider.apiKey)
					const listResponse = yield* send(providers)
					const listed = yield* Caller.json(
						Schema.Struct({
							items: Schema.Array(ModelProvider),
						}),
					)(listResponse)
					assert.isFalse(Str.includes(secret)(yield* listResponse.text))
					assert.deepStrictEqual(
						Arr.map(listed.items, (entry) => entry.id),
						[provider.id],
					)
					const catalog = yield* Caller.read(ModelCatalog, other(catalogPath))
					assert.deepStrictEqual(
						Arr.map(catalog.models, (entry) => [
							entry.provider,
							entry.id,
							entry.contextWindow,
						]),
						[[provider.id, model.id, 8000]],
					)
					for (const resource of [path, modelPath]) {
						yield* status(foreign(resource), 404)
						yield* status(
							foreign(resource, "PATCH", { expectedVersion: 0, name: "Other" }),
							404,
						)
						yield* status(foreign(resource, "DELETE"), 404)
					}
					assert.deepStrictEqual(
						(yield* Caller.read(ModelCatalog, foreign(catalogPath))).models,
						[],
					)
					const changedModel = yield* Caller.read(
						Model,
						send(modelPath, "PATCH", {
							expectedVersion: model.version,
							name: "Changed model",
						}),
					)
					assert.strictEqual(changedModel.name, "Changed model")
					yield* failure(
						other(modelPath, "PATCH", {
							expectedVersion: model.version,
							name: "Old model",
						}),
						409,
						"ModelConflict",
					)
					const changed = yield* Caller.read(
						ModelProvider,
						send(path, "PATCH", {
							expectedVersion: provider.version,
							name: "Changed provider",
						}),
					)
					assert.strictEqual(changed.name, "Changed provider")
					assert.deepStrictEqual(changed.apiKey, provider.apiKey)
					yield* failure(
						other(path, "PATCH", {
							expectedVersion: provider.version,
							name: "Old provider",
						}),
						409,
						"ModelProviderConflict",
					)
					yield* failure(send(modelPath, "DELETE"), 409, "ModelInUse")
					yield* status(send(path, "DELETE"), 204)
					yield* status(other(path), 404)
					yield* status(send(modelPath, "DELETE"), 204)
					yield* status(other(modelPath), 404)
					assert.deepStrictEqual(
						(yield* Caller.read(ModelCatalog, other(catalogPath))).models,
						[],
					)
				}
			}),
		120000,
	)
	it.effect(
		"cookies and tokens manage each secret provider while its token stays private",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin,
					sharedDomain: false,
					// Only the outside password manager is replaced. Storage and HTTP stay real.
					vaultReaders: Outside.vaultReaders({
						make: () => ({
							verify: Effect.void,
							read: () => Effect.die("The test reads no remote secret."),
						}),
					}),
				})
				for (const { name, send, other, foreign } of yield* callers(host)) {
					for (const kind of [
						"onepassword",
						"bitwarden",
						"hashicorp",
					] as const) {
						const providers = "/v1/secret-providers"
						const secret = "test-provider-private-1234"
						const nextSecret = "test-provider-private-5678"
						const credentials = {
							kind,
							url: "https://secrets.example.com",
							token: secret,
						}
						const created = yield* send(providers, "POST", {
							name: kind + " " + name,
							credentials,
						})
						const value = yield* Caller.json(SecretProvider, 201)(created)
						assert.isFalse(Str.includes(secret)(yield* created.text))
						assert.strictEqual(value.kind, kind)
						assert.deepStrictEqual(value.credentials.token, {
							set: true,
							hint: "…1234",
						})
						const path = providers + "/" + value.id
						const read = yield* Caller.read(SecretProvider, other(path))
						assert.strictEqual(read.name, value.name)
						const listResponse = yield* send(providers)
						const list = yield* Caller.json(Schema.Array(SecretProvider))(
							listResponse,
						)
						assert.isFalse(Str.includes(secret)(yield* listResponse.text))
						assert.deepStrictEqual(
							Arr.map(list, (entry) => entry.id),
							[value.id],
						)
						assert.deepStrictEqual(
							yield* Caller.read(
								Schema.Array(SecretProvider),
								foreign(providers),
							),
							[],
						)
						yield* status(foreign(path), 404)
						yield* status(
							foreign(path, "PATCH", {
								expectedVersion: value.version,
								name: "Other",
							}),
							404,
						)
						yield* status(foreign(path, "DELETE"), 404)
						const changedResponse = yield* send(path, "PATCH", {
							expectedVersion: value.version,
							name: "Changed provider",
							credentials: { ...credentials, token: nextSecret },
						})
						const changed = yield* Caller.json(
							SecretProvider,
							200,
						)(changedResponse)
						assert.isFalse(
							Str.includes(nextSecret)(yield* changedResponse.text),
						)
						assert.strictEqual(changed.name, "Changed provider")
						assert.deepStrictEqual(changed.credentials.token, {
							set: true,
							hint: "…5678",
						})
						yield* failure(
							other(path, "PATCH", {
								expectedVersion: value.version,
								name: "Old provider",
							}),
							409,
							"VaultConflict",
						)
						assert.deepStrictEqual(
							(yield* Caller.read(SecretProvider, other(path))).credentials
								.token,
							{ set: true, hint: "…5678" },
						)
						yield* status(send(path, "DELETE"), 204)
						yield* status(other(path), 404)
					}
				}
			}),
		120000,
	)
})
