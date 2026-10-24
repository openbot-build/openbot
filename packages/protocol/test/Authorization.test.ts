// Tests are entry points, so they provide their own Layers.
// @effect-diagnostics strictEffectProvide:off
import {
	Array as EffectArray,
	Option,
	HashMap,
	Effect,
	Layer,
	Redacted,
	Match,
} from "effect"
import {
	CatalogDiscovery,
	MemoryStore,
	OAuthAuthorization,
	AppConnections,
	McpClient,
	Authorization,
	Document,
	Network,
	Store,
} from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { createHash, randomUUID } from "node:crypto"
import { assert, it } from "@effect/vitest"
import { NodeCrypto } from "@effect/platform-node"

import { TestClock } from "effect/testing"
import { startHttps } from "./Fixture.ts"

// The HTTPS server is real, so the test runs with live services. The test
// program gets its own TestClock from the layer below.
it.live(
	"Real CIMD/PKCE exchange checks callbacks, isolated grants, explicit refresh and revocation",
	() =>
		Effect.gen(function* () {
			let origin = ""
			let oidc = false
			let cimd = true
			let wrongClient = false
			let expanded = false
			let exchanges = 0
			let refreshes = 0
			let revocations = 0
			let businessRequests = 0
			let requested: ReadonlyArray<string> = []
			let codes = HashMap.empty<string, URLSearchParams>()
			const fixture = yield* Effect.acquireRelease(
				Effect.promise(() =>
					startHttps((req, res) => {
						void (async () => {
							const url = new URL(req.url ?? "/", origin)
							requested = EffectArray.append(requested, url.pathname)
							const json = (value: unknown) => {
								res.setHeader("content-type", "application/json")
								res.end(JSON.stringify(value))
							}
							const issuer = origin + "/tenant"
							if (url.pathname === "/client.json")
								return json({
									client_id: wrongClient
										? origin + "/different.json"
										: origin + "/client.json",
									redirect_uris: [origin + "/callback?host=trusted"],
									token_endpoint_auth_method: "none",
									grant_types: ["authorization_code", "refresh_token"],
									response_types: ["code"],
								})
							if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
								return json({
									resource: origin + "/mcp",
									authorization_servers: [issuer],
								})
							if (
								(url.pathname ===
									"/.well-known/oauth-authorization-server/tenant" &&
									!oidc) ||
								(url.pathname === "/tenant/.well-known/openid-configuration" &&
									oidc)
							)
								return json({
									issuer,
									authorization_endpoint: origin + "/authorize",
									token_endpoint: origin + "/token",
									revocation_endpoint: origin + "/revoke",
									client_id_metadata_document_supported: cimd,
									authorization_response_iss_parameter_supported: true,
									code_challenge_methods_supported: ["S256"],
									response_types_supported: ["code"],
									token_endpoint_auth_methods_supported: ["none"],
									jwks_uri: origin + "/jwks",
									subject_types_supported: ["public"],
									id_token_signing_alg_values_supported: ["RS256"],
								})
							if (url.pathname === "/authorize") {
								assert.strictEqual(
									url.searchParams.get("code_challenge_method"),
									"S256",
								)
								assert.strictEqual(
									url.searchParams.get("resource"),
									origin + "/mcp",
								)
								assert.strictEqual(
									url.searchParams.get("client_id"),
									origin + "/client.json",
								)
								const code = randomUUID()
								codes = HashMap.set(codes, code, url.searchParams)
								const callback = new URL(
									url.searchParams.get("redirect_uri") ?? "",
								)
								callback.searchParams.set(
									"state",
									url.searchParams.get("state") ?? "",
								)
								callback.searchParams.set("code", code)
								callback.searchParams.set("iss", issuer)
								res.writeHead(303, { location: callback.href })
								return res.end()
							}
							if (url.pathname === "/callback") return json({ received: true })
							if (url.pathname === "/token" || url.pathname === "/revoke") {
								let chunks: ReadonlyArray<Buffer> = []
								for await (const chunk of req)
									chunks = EffectArray.append(chunks, Buffer.from(chunk))
								const form = new URLSearchParams(
									Buffer.concat(chunks).toString(),
								)
								assert.strictEqual(
									form.get("client_id"),
									origin + "/client.json",
								)
								if (url.pathname === "/revoke") {
									revocations++
									assert.strictEqual(form.get("token"), "refresh-secret")
									return res.end()
								}
								assert.strictEqual(form.get("resource"), origin + "/mcp")
								if (form.get("grant_type") === "authorization_code") {
									exchanges++
									const code = form.get("code") ?? ""
									const params = Option.getOrUndefined(HashMap.get(codes, code))
									assert.ok(params)
									codes = HashMap.remove(codes, code)
									assert.strictEqual(
										form.get("redirect_uri"),
										params.get("redirect_uri"),
									)
									assert.strictEqual(
										createHash("sha256")
											.update(form.get("code_verifier") ?? "")
											.digest("base64url"),
										params.get("code_challenge"),
									)
								} else {
									refreshes++
									assert.strictEqual(form.get("grant_type"), "refresh_token")
									assert.strictEqual(
										form.get("refresh_token"),
										"refresh-secret",
									)
								}
								return json({
									access_token: "access-secret",
									refresh_token: "refresh-secret",
									token_type: "Bearer",
									expires_in: 60,
									scope: expanded ? "notes admin" : "notes",
								})
							}
							if (url.pathname === "/mcp") businessRequests++
							res.writeHead(404)
							res.end()
						})().catch((error) => {
							res.writeHead(500)
							res.end()
							throw error
						})
					}),
				),
				(fixture) => Effect.promise(() => fixture.close()),
			)
			origin = fixture.origin
			const key = { owner: "alice", connectionId: "notes" }
			const clientId = origin + "/client.json"
			const redirectUri = origin + "/callback?host=trusted"
			const resource = origin + "/mcp"
			const issuer = origin + "/tenant"
			const layer = Layer.mergeAll(
				MemoryStore.layer,
				MemoryStore.layerCredentials,
				OAuthAuthorization.layerMemoryFlows,
				AppConnections.layerConnectionScopes,
				NodeCrypto.layer,
				TestClock.layer(),
				McpClient.layerPolicy(() => Effect.void),
				NodeHttpServer.layerUserNetwork({
					owner: "alice",
					allowedOrigins: [origin],
					ca: fixture.ca,
					allowAddress: (address) =>
						address === "127.0.0.1" || address === "::1",
				}),
			)
			yield* Effect.scoped(
				Effect.gen(function* () {
					const apps = yield* Store.AppStore
					const credentials = yield* Store.CredentialStore
					yield* apps.save({
						app: {
							cardUrl: origin + "/card",
							card: {
								$schema: Document.cardSchemaUrl,
								name: "example.test/notes",
								description: "Notes",
								version: "1.0.0",
								remotes: [
									{
										type: "streamable-http",
										url: resource,
										supportedProtocolVersions: [Document.protocolVersion],
									},
								],
							},
							sources: [],
						},
						connection: {
							...key,
							cardUrl: origin + "/card",
							endpoint: resource,
							remoteIndex: 0,
							configuration: Redacted.make({}),
							headers: Redacted.make({}),
							state: "Enabled",
							authorization: {
								_tag: "PendingAuthorization",
								resource,
								scopes: [],
							},
						},
					})
					const options = {
						key,
						issuer,
						clientId,
						redirectUri,
						scopes: ["notes"],
					}
					const initial = yield* OAuthAuthorization.discover({
						resource,
						issuer,
					})
					assert.strictEqual(initial.metadata.issuer, issuer)
					oidc = true
					yield* OAuthAuthorization.discover({
						resource,
						issuer,
					})
					assert.ok(
						requested.includes(
							"/.well-known/oauth-authorization-server/tenant",
						),
					)
					assert.ok(
						requested.includes("/tenant/.well-known/openid-configuration"),
					)
					cimd = false
					const incompatible = yield* Effect.result(
						OAuthAuthorization.begin(options),
					)
					assert.strictEqual(incompatible._tag, "Failure")
					Match.value(incompatible).pipe(
						Match.tag("Failure", (incompatible) => {
							assert.strictEqual(
								incompatible.failure._tag,
								"AuthorizationError",
							)
						}),
						Match.orElse(() => undefined),
					)
					cimd = true
					wrongClient = true
					assert.strictEqual(
						(yield* Effect.result(
							OAuthAuthorization.readClientMetadata({
								clientId,
								redirectUri,
							}),
						))._tag,
						"Failure",
					)
					wrongClient = false
					assert.strictEqual(
						(yield* Effect.result(
							OAuthAuthorization.readClientMetadata({
								clientId: origin + "/",
								redirectUri,
							}),
						))._tag,
						"Failure",
					)
					assert.strictEqual(
						(yield* Effect.result(
							OAuthAuthorization.readClientMetadata({
								clientId,
								redirectUri: origin + "/other",
							}),
						))._tag,
						"Failure",
					)
					const pending = yield* OAuthAuthorization.begin(options)
					const flows = yield* Authorization.FlowStore
					const flow = yield* flows.get({
						key,
						flowId: pending.flowId,
					})
					assert.deepStrictEqual(flow.binding, {
						...key,
						resource,
						issuer,
					})
					assert.strictEqual(
						(yield* Effect.result(flows.save(flow)))._tag,
						"Failure",
					)
					assert.ok(!JSON.stringify(pending).includes("verifier"))
					const network = yield* Network.Network
					const callback = (yield* network.readDocument({
						url: pending.authorizationUrl,
					})).url
					const complete = {
						key,
						flowId: pending.flowId,
						callbackUrl: callback,
					}
					for (const input of [
						{
							...complete,
							key: {
								...key,
								owner: "bob",
							},
						},
						{
							...complete,
							key: {
								...key,
								connectionId: "other",
							},
						},
						{
							...complete,
							callbackUrl: callback.replace("host=trusted", "host=attacker"),
						},
						{
							...complete,
							callbackUrl: callback.replace(
								/iss=[^&]+/,
								"iss=https%3A%2F%2Fother.example",
							),
						},
						{
							...complete,
							callbackUrl: callback.replace(/state=[^&]+/, "state=other"),
						},
					])
						assert.strictEqual(
							(yield* Effect.result(OAuthAuthorization.complete(input)))._tag,
							"Failure",
						)
					assert.strictEqual(exchanges, 0)
					const authorized = yield* OAuthAuthorization.complete(complete)
					assert.strictEqual(authorized.authorization._tag, "Authorized")
					assert.ok(!JSON.stringify(authorized).includes("access-secret"))
					assert.ok(!JSON.stringify(authorized).includes("refresh-secret"))
					assert.strictEqual(exchanges, 1)
					assert.strictEqual(businessRequests, 0)
					assert.strictEqual(
						(yield* Effect.result(OAuthAuthorization.complete(complete)))._tag,
						"Failure",
					)
					assert.strictEqual(exchanges, 1)
					assert.strictEqual(authorized.authorization._tag, "Authorized")
					const auth = Match.value(authorized.authorization).pipe(
						Match.tag("Authorized", (auth) => auth),
						Match.orElse(() => {
							throw new Error("Expected a bound grant")
						}),
					)
					for (const changed of [
						{ owner: "bob" },
						{ connectionId: "other" },
						{ resource: origin + "/other" },
						{ issuer: origin + "/other" },
					])
						assert.strictEqual(
							(yield* Effect.result(
								credentials.get({
									binding: {
										...auth.binding,
										...changed,
									},
									reference: auth.credentialRef,
								}),
							))._tag,
							"Failure",
						)
					expanded = true
					const rejected = yield* Effect.result(OAuthAuthorization.refresh(key))
					assert.strictEqual(rejected._tag, "Failure")
					Match.value(rejected).pipe(
						Match.when(
							{ _tag: "Failure", failure: { _tag: "AuthorizationError" } },
							({ failure }) => {
								assert.strictEqual(failure.reason, "ScopeRequired")
							},
						),
						Match.orElse(() => undefined),
					)
					assert.deepStrictEqual(
						(yield* credentials.get({
							binding: auth.binding,
							reference: auth.credentialRef,
						})).scopes,
						["notes"],
					)
					expanded = false
					yield* OAuthAuthorization.refresh(key)
					assert.strictEqual(refreshes, 2)
					yield* TestClock.adjust("61 seconds")
					const expired = yield* Effect.result(
						McpClient.open({
							key,
							clientInfo: {
								name: "test",
								version: "1.0.0",
							},
						}),
					)
					assert.strictEqual(expired._tag, "Failure")
					Match.value(expired).pipe(
						Match.when(
							{ _tag: "Failure", failure: { _tag: "AuthorizationRequired" } },
							({ failure }) => {
								assert.strictEqual(failure.reason, "Expired")
							},
						),
						Match.orElse(() => undefined),
					)
					assert.strictEqual(businessRequests, 0)
					assert.strictEqual(refreshes, 2)
					const expiring = yield* OAuthAuthorization.begin({
						...options,
						expiresInMs: 1000,
					})
					const expiredCallback = (yield* network.readDocument({
						url: expiring.authorizationUrl,
					})).url
					yield* TestClock.adjust("1 second")
					const expiredFlow = yield* Effect.result(
						OAuthAuthorization.complete({
							key,
							flowId: expiring.flowId,
							callbackUrl: expiredCallback,
						}),
					)
					assert.strictEqual(expiredFlow._tag, "Failure")
					Match.value(expiredFlow).pipe(
						Match.when(
							{ _tag: "Failure", failure: { _tag: "AuthorizationError" } },
							({ failure }) => {
								assert.strictEqual(failure.reason, "FlowExpired")
							},
						),
						Match.orElse(() => undefined),
					)
					assert.strictEqual(exchanges, 1)
					assert.strictEqual(
						(yield* OAuthAuthorization.revoke(key))._tag,
						"Revoked",
					)
					assert.strictEqual(revocations, 1)
					assert.strictEqual(
						(yield* credentials
							.get({
								binding: auth.binding,
								reference: auth.credentialRef,
							})
							.pipe(Effect.result))._tag,
						"Failure",
					)
					assert.strictEqual(
						(yield* apps.get(key)).authorization._tag,
						"PendingAuthorization",
					)
				}),
			).pipe(
				Effect.provide(
					layer.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
				),
			)
		}),
)
