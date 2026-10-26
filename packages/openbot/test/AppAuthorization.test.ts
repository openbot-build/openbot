import { assert, layer } from "@effect/vitest"
import { AppAuthorizationApi, ConnectionsApi } from "@openbot-build/api"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { Authorization, Client } from "@openbot-build/protocol"
import {
	Array as Arr,
	Deferred,
	Effect,
	Layer,
	Option,
	type Redacted,
} from "effect"
import {
	FetchHttpClient,
	Headers,
	HttpBody,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
	type HttpMethod,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { AppHost, AppNetwork } from "../src/apps/AppHost.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import { SqlClient } from "effect/sql"
import { serveHttps } from "../../protocol/test/Fixture.ts"
import * as Caller from "./Caller.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"

/** Headers of one connection. A proxy does not pass them on. */
const connectionHeaders: ReadonlyArray<string> = [
	"host",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"upgrade",
]

const without = (headers: Headers.Headers, names: ReadonlyArray<string>) =>
	Arr.reduce(names, headers, (current, name) => Headers.remove(current, name))

/** The fetch client follows no redirects, so the test sees each redirect as it is. */
const manualRedirects = Effect.provideService(FetchHttpClient.RequestInit, {
	redirect: "manual",
})

/**
 * A reverse proxy to OpenBot, as on the public origin. It reads the address of
 * OpenBot for each request, because a restart changes it.
 */
const proxyTo = (address: Effect.Effect<string>) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const body = new Uint8Array(yield* request.arrayBuffer)
		const response = yield* HttpClient.execute(
			HttpClientRequest.make(request.method)(
				new URL(request.url, yield* address),
				{
					headers: without(request.headers, connectionHeaders),
					body:
						body.length === 0
							? HttpBody.empty
							: HttpBody.uint8Array(body, request.headers["content-type"]),
				},
			),
		).pipe(manualRedirects)
		return HttpServerResponse.stream(response.stream, {
			status: response.status,
			// fetch gives the body without its content encoding, and the cookies apart.
			headers: without(response.headers, [
				...connectionHeaders,
				"content-length",
				"content-encoding",
				"set-cookie",
			]),
			cookies: response.cookies,
		})
	}).pipe(
		Effect.catchTag("HttpClientError", (error) =>
			Effect.logWarning("The proxy cannot reach OpenBot", error).pipe(
				Effect.as(HttpServerResponse.empty({ status: 502 })),
			),
		),
	)

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"OpenBot completes real CIMD and PKCE flows once, resumes callbacks after login, and keeps accounts apart",
		() =>
			Effect.gen(function* () {
				const target = yield* Deferred.make<BrowserHost.Host>()
				const proxy = yield* Deferred.await(target).pipe(
					Effect.flatMap((host) => host.address),
					proxyTo,
					serveHttps,
				)
				const publisher = yield* Fixture.start()
				const host = yield* BrowserHost.start({
					publicOrigin: proxy.ipOrigin,
					discovery: publisher.discovery,
					appProbe: publisher.probe,
					appNetwork: Layer.succeed(AppNetwork, {
						layer: (owner, origins) =>
							NodeHttpServer.layerUserNetwork({
								owner,
								allowedOrigins: origins,
								allowAddress: (ip) => ip === "127.0.0.1",
								ca: [proxy.ca, publisher.ca],
							}),
					}),
				})
				yield* Deferred.succeed(target, host)
				const alice = yield* host.login("authorization-alice")
				assert.deepStrictEqual(
					alice.returnLocation,
					Option.some(proxy.ipOrigin + "/"),
				)
				const bob = yield* host.login("authorization-bob")
				/** Calls OpenBot as the browser of an account, on the public origin. */
				const browser =
					(session: Redacted.Redacted<string>) =>
					(path: string, method?: HttpMethod.HttpMethod, payload?: unknown) =>
						Effect.flatMap(host.address, (address) =>
							Caller.withCookie({ address, publicOrigin: proxy.ipOrigin })(
								session,
								path,
								method,
								payload,
							),
						).pipe(manualRedirects)
				const call = browser(alice.session)
				const post = (path: string, payload: unknown) =>
					call(path, "POST", payload)
				/** Calls OpenBot with no account and no origin. */
				const anonymous = (path: string) =>
					Effect.flatMap(host.address, (address) =>
						HttpClient.get(address + path),
					).pipe(manualRedirects)
				const prepared = yield* post("/v1/connection-drafts", {
					input: publisher.origin + "/card",
				})
				assert.strictEqual(prepared.status, 201)
				const draft = yield* HttpClientResponse.schemaBodyJson(
					ConnectionsApi.ConnectionDraft,
				)(prepared)
				const saved = yield* post("/v1/connections", {
					draftId: draft.id,
					revision: draft.revision,
					cardUrl: publisher.origin + "/card",
					remoteIndex: 1,
					name: "Documents",
					values: {},
					confirmed: true,
				})
				assert.strictEqual(saved.status, 201)
				const connection = yield* HttpClientResponse.schemaBodyJson(
					ConnectionsApi.Connection,
				)(saved)
				const connectionPath = "/v1/connections/" + connection.id
				const readConnection = Effect.flatMap(
					call(connectionPath),
					HttpClientResponse.schemaBodyJson(ConnectionsApi.Connection),
				)
				const readFlow = (flowId: string) =>
					Effect.flatMap(
						call("/v1/app-authorizations/" + flowId),
						HttpClientResponse.schemaBodyJson(AppAuthorizationApi.State),
					)
				const metadata = yield* anonymous("/v1/apps/client-metadata")
				assert.strictEqual(metadata.status, 200)
				assert.strictEqual(
					(yield* HttpClientResponse.schemaBodyJson(
						Authorization.ClientMetadata,
					)(metadata)).client_id,
					proxy.ipOrigin + "/v1/apps/client-metadata",
				)
				const begin = Effect.gen(function* () {
					const current = yield* readConnection
					const response = yield* post(connectionPath + "/authorization", {
						revision: current.revision,
						scopes: ["documents"],
						returnTo: "/apps?query=documents",
					})
					assert.strictEqual(response.status, 200, yield* response.text)
					const started = yield* HttpClientResponse.schemaBodyJson(
						AppAuthorizationApi.Started,
					)(response)
					assert.strictEqual(started._tag, "AuthorizationStarted")
					if (started._tag !== "AuthorizationStarted")
						return yield* Effect.die(
							new Error("Expected an authorization redirect"),
						)
					assert.strictEqual(
						new URL(started.authorizationUrl).searchParams.get(
							"code_challenge_method",
						),
						"S256",
					)
					return started
				})
				const first = yield* begin
				const callback = new URL(
					yield* publisher.issueCode(first.authorizationUrl),
				)
				const callbackPath = callback.pathname + callback.search
				assert.strictEqual(
					(yield* browser(bob.session)(callbackPath)).status,
					404,
				)
				assert.strictEqual(yield* publisher.exchanges, 0)
				const received = yield* anonymous(callbackPath)
				assert.strictEqual(received.status, 303)
				const pending = new URL(
					Option.getOrElse(Headers.get(received.headers, "location"), () => ""),
				)
				assert.strictEqual(pending.pathname, "/")
				assert.strictEqual(
					pending.searchParams.get("authorization"),
					first.flowId,
				)
				assert.strictEqual(yield* publisher.exchanges, 0)
				yield* host.restart
				const completed = yield* post(
					"/v1/app-authorizations/" + first.flowId + "/complete",
					{},
				)
				assert.strictEqual(completed.status, 200, yield* completed.text)
				assert.strictEqual(
					(yield* HttpClientResponse.schemaBodyJson(AppAuthorizationApi.State)(
						completed,
					)).status,
					"Succeeded",
				)
				assert.strictEqual(yield* publisher.exchanges, 1)
				yield* publisher.setTokenDelay(40)
				const refresh = host.run(
					Effect.flatMap(AppHost, (factory) =>
						factory
							.bind(
								ownerKey(alice.identity),
								Client.InvocationPolicy.of({ check: () => Effect.void }),
							)
							.refreshAuthorization({
								owner: ownerKey(alice.identity),
								connectionId: connection.id,
							}),
					),
				)
				yield* Effect.all([refresh, refresh], { concurrency: "unbounded" })
				assert.strictEqual(yield* publisher.maxTokenRequests, 1)
				assert.strictEqual(yield* publisher.exchanges, 3)
				yield* publisher.setTokenDelay(0)
				const beforeReview = yield* readConnection
				const reviewDraft = yield* Effect.flatMap(
					post("/v1/connection-drafts", { input: publisher.origin + "/card" }),
					HttpClientResponse.schemaBodyJson(ConnectionsApi.ConnectionDraft),
				)
				const sameConfiguration = yield* post(connectionPath + "/revalidate", {
					revision: beforeReview.revision,
					draftId: reviewDraft.id,
					remoteIndex: 1,
					values: {},
					confirmed: true,
				})
				assert.strictEqual(
					sameConfiguration.status,
					200,
					yield* sameConfiguration.text,
				)
				assert.strictEqual(
					(yield* post(
						"/v1/app-authorizations/" + first.flowId + "/complete",
						{},
					)).status,
					422,
				)
				assert.strictEqual((yield* call(callbackPath)).status, 422)
				assert.strictEqual(yield* publisher.exchanges, 3)
				yield* host.run(
					Effect.scoped(
						Effect.gen(function* () {
							const app = (yield* AppHost).bind(
								ownerKey(alice.identity),
								Client.InvocationPolicy.of({ check: () => Effect.void }),
							)
							const client = yield* app.open({
								key: {
									owner: ownerKey(alice.identity),
									connectionId: connection.id,
								},
								clientInfo: { name: "OAuth test", version: "1.0.0" },
							})
							assert.deepStrictEqual((yield* client.listTools()).tools, [])
						}),
					),
				)
				const second = yield* begin
				const cancelled = new URL(
					yield* publisher.issueCode(second.authorizationUrl),
				)
				cancelled.searchParams.delete("code")
				cancelled.searchParams.set("error", "access_denied")
				const cancellation = yield* call(cancelled.pathname + cancelled.search)
				assert.strictEqual(cancellation.status, 303)
				assert.strictEqual((yield* readFlow(second.flowId)).status, "Cancelled")
				assert.strictEqual(yield* publisher.exchanges, 3)
				yield* publisher.setCimd(false)
				const current = yield* readConnection
				const unsupported = yield* post(connectionPath + "/authorization", {
					revision: current.revision,
					scopes: ["documents"],
				})
				assert.strictEqual(unsupported.status, 422)
				assert.strictEqual(
					(yield* HttpClientResponse.schemaBodyJson(
						AppAuthorizationApi.AppAuthorizationFailed,
					)(unsupported)).reason,
					"CimdUnsupported",
				)
				yield* publisher.setCimd(true)
				const wrongIssuer = yield* begin
				const wrongCallback = new URL(
					yield* publisher.issueCode(wrongIssuer.authorizationUrl),
				)
				wrongCallback.searchParams.set("iss", "https://foreign.test")
				assert.strictEqual(
					(yield* call(wrongCallback.pathname + wrongCallback.search)).status,
					422,
				)
				assert.strictEqual(yield* publisher.exchanges, 3)
				const expiring = yield* begin
				yield* host.run(
					Effect.flatMap(
						SqlClient.SqlClient,
						(sql) =>
							sql`UPDATE openbot_app_authorizations SET expires_at=0 WHERE id=${expiring.flowId}`,
					),
				)
				const expired = new URL(
					yield* publisher.issueCode(expiring.authorizationUrl),
				)
				assert.strictEqual(
					(yield* call(expired.pathname + expired.search)).status,
					422,
				)
				assert.strictEqual(yield* publisher.exchanges, 3)
				const abandoned = yield* begin
				yield* host.run(
					Effect.flatMap(
						SqlClient.SqlClient,
						(sql) =>
							sql`UPDATE openbot_app_authorizations SET status='Processing' WHERE id=${abandoned.flowId}`,
					),
				)
				assert.strictEqual(
					(yield* readFlow(abandoned.flowId)).status,
					"Processing",
				)
				yield* host.run(
					Effect.flatMap(
						SqlClient.SqlClient,
						(sql) =>
							sql`UPDATE openbot_app_authorizations SET expires_at=0 WHERE id=${abandoned.flowId}`,
					),
				)
				const interrupted = yield* readFlow(abandoned.flowId)
				assert.strictEqual(interrupted.status, "Failed")
				assert.strictEqual(interrupted.reason, "Interrupted")
				const rejected = yield* begin
				const rejectedUrl = new URL(
					yield* publisher.issueCode(rejected.authorizationUrl),
				)
				yield* publisher.setRejectGrant(true)
				assert.strictEqual(
					(yield* call(rejectedUrl.pathname + rejectedUrl.search)).status,
					303,
				)
				assert.strictEqual((yield* readFlow(rejected.flowId)).status, "Failed")
				assert.strictEqual(
					(yield* post(
						"/v1/app-authorizations/" + rejected.flowId + "/complete",
						{},
					)).status,
					422,
				)
				assert.strictEqual(yield* publisher.exchanges, 4)
				for (const returnTo of [
					"/apps?query=documents",
					"/connections?input=publisher.test",
					"/chats/existing-chat",
				]) {
					assert.deepStrictEqual(
						(yield* host.login("return-user", returnTo)).returnLocation,
						Option.some(proxy.ipOrigin + returnTo),
					)
				}
				const signIn = (callbackURL: string) =>
					Effect.flatMap(host.address, (address) =>
						HttpClientRequest.post(address + "/auth/sign-in/social", {
							headers: { origin: proxy.ipOrigin },
						}).pipe(
							HttpClientRequest.bodyJson({
								provider: "oidc",
								callbackURL,
								disableRedirect: true,
							}),
							Effect.flatMap(HttpClient.execute),
						),
					)
				for (const callbackURL of [
					"https://foreign.test",
					"//foreign.test",
					"/\\foreign.test",
				])
					assert.strictEqual(
						(yield* signIn(callbackURL)).status,
						403,
						callbackURL,
					)
				yield* publisher.setRejectGrant(false)
				yield* publisher.setRevocationFails(true)
				const revoke = call(connectionPath + "/authorization", "DELETE")
				const failedCleanup = yield* revoke
				assert.strictEqual(failedCleanup.status, 409, yield* failedCleanup.text)
				assert.strictEqual(
					(yield* HttpClientResponse.schemaBodyJson(
						ConnectionsApi.ConnectionCleanupPending,
					)(failedCleanup)).stage,
					"Credentials",
				)
				const stopped = yield* readConnection
				assert.strictEqual(stopped.enabled, false)
				assert.strictEqual(stopped.availability._tag, "CleanupPending")
				yield* publisher.setRevocationFails(false)
				const revoked = yield* revoke
				assert.strictEqual(revoked.status, 200, yield* revoked.text)
				assert.strictEqual(
					(yield* HttpClientResponse.schemaBodyJson(
						AppAuthorizationApi.Revocation,
					)(revoked))._tag,
					"Revoked",
				)
				const cleared = yield* readConnection
				assert.strictEqual(
					(yield* call(connectionPath, "PUT", {
						revision: cleared.revision,
						name: cleared.name,
						enabled: true,
					})).status,
					200,
				)
				yield* publisher.setRevocationSupported(false)
				const localGrant = new URL(
					yield* publisher.issueCode((yield* begin).authorizationUrl),
				)
				assert.strictEqual(
					(yield* call(localGrant.pathname + localGrant.search)).status,
					303,
				)
				const localOnly = yield* revoke
				assert.strictEqual(localOnly.status, 200, yield* localOnly.text)
				assert.strictEqual(
					(yield* HttpClientResponse.schemaBodyJson(
						AppAuthorizationApi.Revocation,
					)(localOnly))._tag,
					"LocalOnly",
				)
				assert.strictEqual(
					Arr.contains(yield* publisher.operations, "tools/call"),
					false,
				)
			}),
	)
})
