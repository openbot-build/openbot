import {
	Array as Arr,
	Crypto,
	Option,
	HashMap,
	Effect,
	Layer,
	Redacted,
	Ref,
	Match,
	Schema,
	Scope,
	String as Str,
} from "effect"
import {
	App,
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
import { assert, it } from "@effect/vitest"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { Base64, Base64Url } from "effect/encoding"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

import { TestClock } from "effect/testing"
import { serveChecked } from "./Fixture.ts"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

// The HTTPS server is real, so the test runs with live services. The test
// program gets its own TestClock from the layer below.
it.live(
	"Real CIMD/PKCE exchange checks callbacks, isolated grants, explicit refresh and revocation",
	() =>
		Effect.gen(function* () {
			let origin = ""
			let oidc = false
			let cimd = true
			let registration = false
			let registrationRedirect = true
			let registrationHttps = true
			let registrations = 0
			let clientAuth: "none" | "client_secret_basic" | "client_secret_post" =
				"none"
			let expectedClientId = ""
			let wrongClient = false
			let expanded = false
			let exchanges = 0
			let refreshes = 0
			let revocations = 0
			let businessRequests = 0
			let requested: ReadonlyArray<string> = []
			let codes = HashMap.empty<string, URLSearchParams>()
			const crypto = yield* Crypto.Crypto
			const fixture = yield* serveChecked(
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					const url = new URL(request.url, origin)
					requested = Arr.append(requested, url.pathname)
					const issuer = origin + "/tenant"
					if (url.pathname === "/client.json")
						return yield* HttpServerResponse.json({
							client_id: wrongClient
								? origin + "/different.json"
								: origin + "/client.json",
							redirect_uris: [origin + "/callback?host=trusted"],
							token_endpoint_auth_method: "none",
							grant_types: ["authorization_code", "refresh_token"],
							response_types: ["code"],
						})
					if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
						return yield* HttpServerResponse.json({
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
						return yield* HttpServerResponse.json({
							issuer,
							authorization_endpoint: origin + "/authorize",
							token_endpoint: origin + "/token",
							revocation_endpoint: origin + "/revoke",
							client_id_metadata_document_supported: cimd,
							...(registration
								? {
										registration_endpoint: registrationHttps
											? origin + "/register"
											: "http://example.test/register",
									}
								: {}),
							authorization_response_iss_parameter_supported: true,
							code_challenge_methods_supported: ["S256"],
							response_types_supported: ["code"],
							token_endpoint_auth_methods_supported: [clientAuth],
							jwks_uri: origin + "/jwks",
							subject_types_supported: ["public"],
							id_token_signing_alg_values_supported: ["RS256"],
						})
					if (url.pathname === "/register") {
						registrations++
						const input = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
							yield* request.json,
						)
						assert.strictEqual(input["token_endpoint_auth_method"], clientAuth)
						assert.deepStrictEqual(input["redirect_uris"], [
							origin + "/callback?host=trusted",
						])
						assert.strictEqual(input["scope"], "notes")
						expectedClientId = "registered-client"
						return yield* HttpServerResponse.json(
							{
								...input,
								client_id: expectedClientId,
								redirect_uris: [
									origin +
										(registrationRedirect
											? "/callback?host=trusted"
											: "/changed"),
								],
								...(clientAuth === "none"
									? {}
									: { client_secret: "registered-client-secret" }),
							},
							{ status: 201 },
						)
					}
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
							expectedClientId,
						)
						const code = yield* crypto.randomUUIDv4()
						codes = HashMap.set(codes, code, url.searchParams)
						const callback = new URL(url.searchParams.get("redirect_uri") ?? "")
						callback.searchParams.set(
							"state",
							url.searchParams.get("state") ?? "",
						)
						callback.searchParams.set("code", code)
						callback.searchParams.set("iss", issuer)
						return HttpServerResponse.redirect(callback.href, { status: 303 })
					}
					if (url.pathname === "/callback")
						return yield* HttpServerResponse.json({ received: true })
					if (url.pathname === "/token" || url.pathname === "/revoke") {
						const form = new URLSearchParams(yield* request.text)
						if (clientAuth === "client_secret_basic") {
							assert.strictEqual(
								request.headers["authorization"],
								`Basic ${Base64.encode(new TextEncoder().encode(`${expectedClientId}:registered-client-secret`))}`,
							)
						} else {
							assert.strictEqual(form.get("client_id"), expectedClientId)
							assert.strictEqual(
								form.get("client_secret"),
								clientAuth === "client_secret_post"
									? "registered-client-secret"
									: null,
							)
						}
						if (url.pathname === "/revoke") {
							revocations++
							assert.strictEqual(form.get("token"), "refresh-secret")
							return HttpServerResponse.empty({ status: 200 })
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
							const digest = yield* crypto.digest(
								"SHA-256",
								new TextEncoder().encode(form.get("code_verifier") ?? ""),
							)
							assert.strictEqual(
								Base64Url.encode(digest),
								params.get("code_challenge"),
							)
						} else {
							refreshes++
							assert.strictEqual(form.get("grant_type"), "refresh_token")
							assert.strictEqual(form.get("refresh_token"), "refresh-secret")
						}
						return yield* HttpServerResponse.json({
							access_token: "access-secret",
							refresh_token: "refresh-secret",
							token_type: "Bearer",
							expires_in: 60,
							scope: expanded ? "notes admin" : "notes",
						})
					}
					if (url.pathname === "/mcp") businessRequests++
					return HttpServerResponse.empty({ status: 404 })
				}),
			)
			origin = fixture.origin
			expectedClientId = origin + "/client.json"
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
						app: Store.AppRecord.make({
							cardUrl: origin + "/card",
							card: Document.ServerCard.make({
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
							}),
							sources: [],
						}),
						connection: Store.UserConnection.make({
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
						}),
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
						Arr.contains(
							requested,
							"/.well-known/oauth-authorization-server/tenant",
						),
					)
					assert.ok(
						Arr.contains(requested, "/tenant/.well-known/openid-configuration"),
					)
					cimd = false
					const incompatible = yield* Effect.flip(
						OAuthAuthorization.begin(options),
					)
					assert.ok(incompatible._tag === "AuthorizationError")
					assert.strictEqual(incompatible.reason, "CimdUnsupported")
					cimd = true
					wrongClient = true
					const differentClient = yield* Effect.flip(
						OAuthAuthorization.readClientMetadata({
							clientId,
							redirectUri,
						}),
					)
					assert.ok(differentClient._tag === "AuthorizationError")
					assert.strictEqual(differentClient.reason, "ClientMetadata")
					wrongClient = false
					const wrongOrigin = yield* Effect.flip(
						OAuthAuthorization.readClientMetadata({
							clientId: origin + "/",
							redirectUri,
						}),
					)
					assert.ok(wrongOrigin._tag === "AuthorizationError")
					assert.strictEqual(wrongOrigin.reason, "ClientMetadata")
					const wrongRedirect = yield* Effect.flip(
						OAuthAuthorization.readClientMetadata({
							clientId,
							redirectUri: origin + "/other",
						}),
					)
					assert.ok(wrongRedirect._tag === "AuthorizationError")
					assert.strictEqual(wrongRedirect.reason, "ClientMetadata")
					const pending = yield* OAuthAuthorization.begin(options)
					const flows = yield* Authorization.FlowStore
					const flow = yield* flows.get({
						key,
						flowId: pending.flowId,
					})
					assert.deepStrictEqual(
						flow.binding,
						Store.CredentialBinding.make({
							...key,
							resource,
							issuer,
						}),
					)
					const duplicate = yield* Effect.flip(flows.save(flow))
					assert.strictEqual(duplicate.reason, "AlreadyExists")
					assert.ok(!Str.includes("verifier")(yield* encodeJson(pending)))
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
							callbackUrl: Str.replace(
								"host=trusted",
								"host=attacker",
							)(callback),
						},
						{
							...complete,
							callbackUrl: Str.replace(
								/iss=[^&]+/,
								"iss=https%3A%2F%2Fother.example",
							)(callback),
						},
						{
							...complete,
							callbackUrl: Str.replace(/state=[^&]+/, "state=other")(callback),
						},
					]) {
						const tampered = yield* Effect.flip(
							OAuthAuthorization.complete(input),
						)
						assert.ok(tampered._tag === "AuthorizationError")
						assert.strictEqual(tampered.reason, "CallbackMismatch")
					}
					assert.strictEqual(exchanges, 0)
					// A live client of the connection, as McpClient registers one.
					const liveClient = Effect.gen(function* () {
						const closed = yield* Ref.make(false)
						const scope = yield* Scope.fork(yield* Effect.scope)
						yield* Scope.addFinalizer(scope, Ref.set(closed, true))
						yield* (yield* App.ConnectionScopes).register({ key, scope })
						return closed
					})
					const beforeGrant = yield* liveClient
					const authorized = yield* OAuthAuthorization.complete(complete)
					// A new grant can be for another account, so live clients connect again.
					assert.strictEqual(yield* Ref.get(beforeGrant), true)
					assert.strictEqual(authorized.authorization._tag, "Authorized")
					const authorizedText = yield* encodeJson(authorized)
					assert.ok(!Str.includes("access-secret")(authorizedText))
					assert.ok(!Str.includes("refresh-secret")(authorizedText))
					assert.strictEqual(exchanges, 1)
					assert.strictEqual(businessRequests, 0)
					const replayed = yield* Effect.flip(
						OAuthAuthorization.complete(complete),
					)
					assert.ok(replayed._tag === "AuthorizationError")
					assert.strictEqual(replayed.reason, "AlreadyConsumed")
					assert.strictEqual(exchanges, 1)
					assert.strictEqual(authorized.authorization._tag, "Authorized")
					const auth = Match.value(authorized.authorization).pipe(
						Match.tag("Authorized", (auth) => auth),
						Match.orElse(() => assert.fail("Expected a bound grant")),
					)
					for (const changed of [
						{ owner: "bob" },
						{ connectionId: "other" },
						{ resource: origin + "/other" },
						{ issuer: origin + "/other" },
					]) {
						const missing = yield* Effect.flip(
							credentials.get({
								binding: {
									...auth.binding,
									...changed,
								},
								reference: auth.credentialRef,
							}),
						)
						assert.strictEqual(missing._tag, "StoreError")
						assert.strictEqual(missing.reason, "Missing")
					}
					expanded = true
					const rejected = yield* Effect.flip(OAuthAuthorization.refresh(key))
					assert.ok(rejected._tag === "AuthorizationError")
					assert.strictEqual(rejected.reason, "ScopeRequired")
					assert.deepStrictEqual(
						(yield* credentials.get({
							binding: auth.binding,
							reference: auth.credentialRef,
						})).scopes,
						["notes"],
					)
					expanded = false
					const beforeRefresh = yield* liveClient
					yield* OAuthAuthorization.refresh(key)
					assert.strictEqual(refreshes, 2)
					// A refresh of the same grant keeps live clients and their running calls.
					assert.strictEqual(yield* Ref.get(beforeRefresh), false)
					yield* TestClock.adjust("61 seconds")
					const expired = yield* Effect.flip(
						McpClient.open({
							key,
							clientInfo: {
								name: "test",
								version: "1.0.0",
							},
						}),
					)
					assert.ok(expired._tag === "AuthorizationRequired")
					assert.strictEqual(expired.reason, "Expired")
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
					const expiredFlow = yield* Effect.flip(
						OAuthAuthorization.complete({
							key,
							flowId: expiring.flowId,
							callbackUrl: expiredCallback,
						}),
					)
					assert.ok(expiredFlow._tag === "AuthorizationError")
					assert.strictEqual(expiredFlow.reason, "FlowExpired")
					assert.strictEqual(exchanges, 1)
					assert.strictEqual(
						(yield* OAuthAuthorization.revoke(key))._tag,
						"Revoked",
					)
					assert.strictEqual(revocations, 1)
					const revoked = yield* Effect.flip(
						credentials.get({
							binding: auth.binding,
							reference: auth.credentialRef,
						}),
					)
					assert.strictEqual(revoked._tag, "StoreError")
					assert.strictEqual(revoked.reason, "Missing")
					assert.strictEqual(
						(yield* apps.get(key)).authorization._tag,
						"PendingAuthorization",
					)
					registration = true
					cimd = false
					for (const method of [
						"none",
						"client_secret_post",
						"client_secret_basic",
					] as const) {
						clientAuth = method
						const before = registrations
						const pending = yield* OAuthAuthorization.begin(options)
						assert.strictEqual(registrations, before + 1)
						assert.strictEqual(
							new URL(pending.authorizationUrl).searchParams.get("client_id"),
							"registered-client",
						)
						assert.ok(
							!Str.includes("registered-client-secret")(
								yield* encodeJson(pending),
							),
						)
						const flow = yield* flows.get({ key, flowId: pending.flowId })
						assert.strictEqual(flow.clientAuthMethod, method)
						const received = (yield* network.readDocument({
							url: pending.authorizationUrl,
						})).url
						const completed = yield* OAuthAuthorization.complete({
							key,
							flowId: pending.flowId,
							callbackUrl: received,
						})
						const binding = Match.value(completed.authorization).pipe(
							Match.tag("Authorized", (value) => value),
							Match.orElse(() => assert.fail("Expected the registered grant")),
						)
						const saved = yield* credentials.get({
							binding: binding.binding,
							reference: binding.credentialRef,
						})
						assert.strictEqual(saved.clientId, "registered-client")
						assert.strictEqual(saved.clientAuthMethod, method)
						assert.strictEqual(
							saved.clientSecret === undefined
								? undefined
								: Redacted.value(saved.clientSecret),
							method === "none" ? undefined : "registered-client-secret",
						)
						yield* OAuthAuthorization.refresh(key)
						assert.strictEqual(registrations, before + 1)
						const scopedAway = yield* Effect.flip(
							credentials.get({
								binding: { ...binding.binding, owner: "bob" },
								reference: binding.credentialRef,
							}),
						)
						assert.strictEqual(scopedAway.reason, "Missing")
						yield* OAuthAuthorization.revoke(key)
					}
					clientAuth = "none"
					registrationRedirect = false
					const changedRedirect = yield* Effect.flip(
						OAuthAuthorization.begin(options),
					)
					assert.strictEqual(changedRedirect._tag, "AuthorizationError")
					if (changedRedirect._tag === "AuthorizationError")
						assert.strictEqual(changedRedirect.reason, "ClientMetadata")
					registrationRedirect = true
					registrationHttps = false
					const beforeUnsafe = registrations
					const unsafeRegistration = yield* Effect.flip(
						OAuthAuthorization.begin(options),
					)
					assert.strictEqual(unsafeRegistration._tag, "AuthorizationError")
					assert.strictEqual(registrations, beforeUnsafe)
					registrationHttps = true
					cimd = true
					expectedClientId = clientId
					const beforeCimd = registrations
					const preferred = yield* OAuthAuthorization.begin(options)
					assert.strictEqual(
						new URL(preferred.authorizationUrl).searchParams.get("client_id"),
						clientId,
					)
					assert.strictEqual(registrations, beforeCimd)
				}),
			).pipe(
				Effect.provide(
					layer.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
				),
			)
		}).pipe(Effect.provide(NodeServices.layer)),
)
