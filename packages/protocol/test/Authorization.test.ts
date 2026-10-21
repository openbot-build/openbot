import {
	Array as EffectArray,
	Option,
	HashMap,
	ManagedRuntime,
	Effect,
	Layer,
	Redacted,
	Match,
} from "effect"
import assert from "node:assert/strict"
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
import { test } from "node:test"
import { NodeCrypto } from "@effect/platform-node"

import { TestClock } from "effect/testing"
import { startHttps } from "./Fixture.ts"

for (const registration of [
	"cimd",
	"none",
	"client_secret_basic",
	"client_secret_post",
] as const)
	test(`Real ${registration} PKCE exchange checks callbacks, isolated grants, refresh and revocation`, async () => {
		let origin = ""
		let oidc = false
		let cimd = true
		let dcr = false
		let invalidRegistration = ""
		let registrations = 0
		const clientSecret = "client:secret with+encoding"
		const issuedClient = "dynamic:client+id"
		let wrongClient = false
		let expanded = false
		let exchanges = 0
		let refreshes = 0
		let revocations = 0
		let businessRequests = 0
		let requested: ReadonlyArray<string> = []
		let codes = HashMap.empty<string, URLSearchParams>()
		const fixture = await startHttps((req, res) => {
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
					(url.pathname === "/.well-known/oauth-authorization-server/tenant" &&
						!oidc) ||
					(url.pathname === "/tenant/.well-known/openid-configuration" && oidc)
				)
					return json({
						issuer,
						authorization_endpoint: origin + "/authorize",
						token_endpoint: origin + "/token",
						revocation_endpoint: origin + "/revoke",
						...(dcr && registration === "client_secret_post"
							? {}
							: {
									revocation_endpoint_auth_methods_supported: [
										dcr ? registration : "none",
									],
								}),
						client_id_metadata_document_supported: cimd,
						...(dcr ? { registration_endpoint: origin + "/register" } : {}),
						authorization_response_iss_parameter_supported: true,
						code_challenge_methods_supported: ["S256"],
						response_types_supported: ["code"],
						token_endpoint_auth_methods_supported: [
							dcr ? registration : "none",
						],
						jwks_uri: origin + "/jwks",
						subject_types_supported: ["public"],
						id_token_signing_alg_values_supported: ["RS256"],
					})
				if (url.pathname === "/register") {
					registrations++
					let chunks: ReadonlyArray<Buffer> = []
					for await (const chunk of req)
						chunks = EffectArray.append(chunks, Buffer.from(chunk))
					const registered = JSON.parse(Buffer.concat(chunks).toString())
					assert.deepEqual(registered.redirect_uris, [
						origin + "/callback?host=trusted",
					])
					assert.equal(registered.token_endpoint_auth_method, registration)
					assert.equal(registered.client_id, undefined)
					if (invalidRegistration === "rejected") {
						res.statusCode = 400
						return json({ error: "invalid_client_metadata" })
					}
					return json({
						...registered,
						...(registered.scope === undefined ? { scope: "notes" } : {}),
						client_id: issuedClient,
						...(registration === "none" ||
						invalidRegistration === "missing-secret"
							? {}
							: {
									client_secret: clientSecret,
									client_secret_expires_at:
										invalidRegistration === "expired" ? 1 : 0,
								}),
						...(invalidRegistration === "redirect"
							? { redirect_uris: [origin + "/attacker"] }
							: {}),
						...(invalidRegistration === "scope"
							? { scope: "notes admin" }
							: {}),
					})
				}
				if (url.pathname === "/authorize") {
					assert.equal(url.searchParams.get("code_challenge_method"), "S256")
					assert.equal(url.searchParams.get("resource"), origin + "/mcp")
					assert.equal(
						url.searchParams.get("client_id"),
						dcr ? issuedClient : origin + "/client.json",
					)
					const code = randomUUID()
					codes = HashMap.set(codes, code, url.searchParams)
					const callback = new URL(url.searchParams.get("redirect_uri") ?? "")
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
					const form = new URLSearchParams(Buffer.concat(chunks).toString())
					if (
						dcr &&
						(registration === "client_secret_basic" ||
							(url.pathname === "/revoke" &&
								registration === "client_secret_post"))
					) {
						assert.equal(
							req.headers.authorization,
							`Basic ${Buffer.from(new URLSearchParams({ v: issuedClient }).toString().slice(2) + ":" + new URLSearchParams({ v: clientSecret }).toString().slice(2)).toString("base64")}`,
						)
						assert.equal(form.has("client_secret"), false)
					} else {
						assert.equal(
							form.get("client_id"),
							dcr ? issuedClient : origin + "/client.json",
						)
						assert.equal(
							form.get("client_secret"),
							dcr && registration === "client_secret_post"
								? clientSecret
								: null,
						)
					}
					if (url.pathname === "/revoke") {
						revocations++
						assert.equal(form.get("token"), "refresh-secret")
						return res.end()
					}
					assert.equal(form.get("resource"), origin + "/mcp")
					if (form.get("grant_type") === "authorization_code") {
						exchanges++
						const code = form.get("code") ?? ""
						const params = Option.getOrUndefined(HashMap.get(codes, code))
						assert.ok(params)
						codes = HashMap.remove(codes, code)
						assert.equal(form.get("redirect_uri"), params.get("redirect_uri"))
						assert.equal(
							createHash("sha256")
								.update(form.get("code_verifier") ?? "")
								.digest("base64url"),
							params.get("code_challenge"),
						)
					} else {
						refreshes++
						assert.equal(form.get("grant_type"), "refresh_token")
						assert.equal(form.get("refresh_token"), "refresh-secret")
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
		})
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
				allowAddress: (address) => address === "127.0.0.1" || address === "::1",
			}),
		)
		try {
			await using runtime1 = ManagedRuntime.make(
				layer.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
			)
			await runtime1.runPromise(
				Effect.scoped(
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
							clientRegistration: "dynamic" as const,
						}
						const initial = yield* OAuthAuthorization.discover({
							resource,
							issuer,
						})
						assert.equal(initial.metadata.issuer, issuer)
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
						assert.equal(incompatible._tag, "Failure")
						Match.value(incompatible).pipe(
							Match.tag("Failure", (incompatible) => {
								assert.equal(incompatible.failure._tag, "AuthorizationError")
							}),
							Match.orElse(() => undefined),
						)
						cimd = true
						wrongClient = true
						assert.equal(
							(yield* Effect.result(
								OAuthAuthorization.readClientMetadata({
									clientId,
									redirectUri,
								}),
							))._tag,
							"Failure",
						)
						wrongClient = false
						assert.equal(
							(yield* Effect.result(
								OAuthAuthorization.readClientMetadata({
									clientId: origin + "/",
									redirectUri,
								}),
							))._tag,
							"Failure",
						)
						assert.equal(
							(yield* Effect.result(
								OAuthAuthorization.readClientMetadata({
									clientId,
									redirectUri: origin + "/other",
								}),
							))._tag,
							"Failure",
						)
						if (registration !== "cimd") {
							cimd = false
							dcr = true
							const strict = yield* Effect.flip(
								OAuthAuthorization.begin({
									...options,
									clientRegistration: "cimd",
								}),
							)
							assert.equal(strict._tag, "AuthorizationError")
							assert.equal(registrations, 0)
							for (const invalid of [
								"rejected",
								"redirect",
								"scope",
								...(registration === "none"
									? []
									: ["missing-secret", "expired"]),
							]) {
								invalidRegistration = invalid
								if (invalid === "expired") yield* TestClock.adjust("2 seconds")
								const failed = yield* Effect.flip(
									OAuthAuthorization.begin(options),
								)
								assert.equal(failed._tag, "AuthorizationError")
							}
							invalidRegistration = ""
						}
						const pending = yield* OAuthAuthorization.begin(options)
						const flows = yield* Authorization.FlowStore
						const flow = yield* flows.get({
							key,
							flowId: pending.flowId,
						})
						assert.deepEqual(flow.binding, {
							...key,
							resource,
							issuer,
						})
						assert.equal(
							(yield* Effect.result(flows.save(flow)))._tag,
							"Failure",
						)
						assert.ok(!JSON.stringify(pending).includes("verifier"))
						assert.ok(!JSON.stringify(pending).includes(clientSecret))
						assert.equal(flow.clientId, dcr ? issuedClient : clientId)
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
							assert.equal(
								(yield* Effect.result(OAuthAuthorization.complete(input)))._tag,
								"Failure",
							)
						assert.equal(exchanges, 0)
						const authorized = yield* OAuthAuthorization.complete(complete)
						assert.equal(authorized.authorization._tag, "Authorized")
						assert.ok(!JSON.stringify(authorized).includes("access-secret"))
						assert.ok(!JSON.stringify(authorized).includes("refresh-secret"))
						assert.ok(!JSON.stringify(authorized).includes(clientSecret))
						assert.equal(exchanges, 1)
						assert.equal(businessRequests, 0)
						assert.equal(
							(yield* Effect.result(OAuthAuthorization.complete(complete)))
								._tag,
							"Failure",
						)
						assert.equal(exchanges, 1)
						assert.equal(authorized.authorization._tag, "Authorized")
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
							assert.equal(
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
						const rejected = yield* Effect.result(
							OAuthAuthorization.refresh(key),
						)
						assert.equal(rejected._tag, "Failure")
						Match.value(rejected).pipe(
							Match.when(
								{ _tag: "Failure", failure: { _tag: "AuthorizationError" } },
								({ failure }) => {
									assert.equal(failure.reason, "ScopeRequired")
								},
							),
							Match.orElse(() => undefined),
						)
						assert.deepEqual(
							(yield* credentials.get({
								binding: auth.binding,
								reference: auth.credentialRef,
							})).scopes,
							["notes"],
						)
						expanded = false
						yield* OAuthAuthorization.refresh(key)
						assert.equal(refreshes, 2)
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
						assert.equal(expired._tag, "Failure")
						Match.value(expired).pipe(
							Match.when(
								{ _tag: "Failure", failure: { _tag: "AuthorizationRequired" } },
								({ failure }) => {
									assert.equal(failure.reason, "Expired")
								},
							),
							Match.orElse(() => undefined),
						)
						assert.equal(businessRequests, 0)
						assert.equal(refreshes, 2)
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
						assert.equal(expiredFlow._tag, "Failure")
						Match.value(expiredFlow).pipe(
							Match.when(
								{ _tag: "Failure", failure: { _tag: "AuthorizationError" } },
								({ failure }) => {
									assert.equal(failure.reason, "FlowExpired")
								},
							),
							Match.orElse(() => undefined),
						)
						assert.equal(exchanges, 1)
						assert.equal(
							(yield* OAuthAuthorization.revoke(key))._tag,
							"Revoked",
						)
						assert.equal(revocations, 1)
						assert.equal(
							(yield* credentials
								.get({
									binding: auth.binding,
									reference: auth.credentialRef,
								})
								.pipe(Effect.result))._tag,
							"Failure",
						)
						assert.equal(
							(yield* apps.get(key)).authorization._tag,
							"PendingAuthorization",
						)
						const defaultFlow = yield* OAuthAuthorization.begin({
							...options,
							scopes: [],
						})
						assert.equal(
							new URL(defaultFlow.authorizationUrl).searchParams.has("scope"),
							false,
						)
						const savedDefault = yield* flows.get({
							key,
							flowId: defaultFlow.flowId,
						})
						assert.equal(savedDefault.scopeSelection, "ProviderDefault")
						assert.deepEqual(savedDefault.scopes, [])
						// Old flows with no scope-selection marker retain their original strict interpretation.
						const { scopeSelection: _selection, ...legacy } = savedDefault
						const legacyId = "legacy-" + savedDefault.flowId
						yield* flows.save({ ...legacy, flowId: legacyId })
						const legacyUrl = new URL(defaultFlow.authorizationUrl)
						legacyUrl.searchParams.set("state", legacyId)
						const legacyCallback = (yield* network.readDocument({
							url: legacyUrl.href,
						})).url
						const legacyResult = yield* Effect.flip(
							OAuthAuthorization.complete({
								key,
								flowId: legacyId,
								callbackUrl: legacyCallback,
							}),
						)
						assert.equal(legacyResult._tag, "AuthorizationError")
						assert.ok(
							"reason" in legacyResult &&
								legacyResult.reason === "ScopeRequired",
						)
						const defaultCallback = (yield* network.readDocument({
							url: defaultFlow.authorizationUrl,
						})).url
						const defaultGrant = yield* OAuthAuthorization.complete({
							key,
							flowId: defaultFlow.flowId,
							callbackUrl: defaultCallback,
						})
						assert.equal(defaultGrant.authorization._tag, "Authorized")
						assert.ok("scopes" in defaultGrant.authorization)
						assert.deepEqual(defaultGrant.authorization.scopes, ["notes"])
						expanded = true
						const expandedDefault = yield* Effect.flip(
							OAuthAuthorization.refresh(key),
						)
						assert.equal(expandedDefault._tag, "AuthorizationError")
						assert.ok(
							"reason" in expandedDefault &&
								expandedDefault.reason === "ScopeRequired",
						)
						expanded = false
						yield* OAuthAuthorization.refresh(key)
						assert.equal(
							(yield* OAuthAuthorization.revoke(key))._tag,
							"Revoked",
						)
					}),
				),
			)
		} finally {
			await fixture.close()
		}
	})
