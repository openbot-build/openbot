import { Execution } from "@openbot-build/domain"
import { assert, layer } from "@effect/vitest"
import {
	AppAuthorizationApi,
	ConnectionsApi,
	ExecutionsApi,
} from "@openbot-build/api"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { Authorization } from "@openbot-build/protocol"
import {
	Array as Arr,
	Deferred,
	Effect,
	Layer,
	Option,
	Schedule,
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
import { AppHost } from "@openbot-build/openbot"
import { SqlClient } from "effect/sql"
import { Fixture as ProtocolFixture } from "@openbot-build/protocol/testing"
import {
	AppConnections,
	AppFixture as Fixture,
	BrowserHost,
	Caller,
} from "@openbot-build/openbot/testing"

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
					ProtocolFixture.serveHttps,
				)
				const publisher = yield* Fixture.start()
				const host = yield* BrowserHost.start({
					publicOrigin: proxy.ipOrigin,
					discovery: publisher.discovery,
					appProbe: publisher.probe,
					appNetwork: Layer.succeed(AppHost.AppNetwork, {
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

				const action = (id: Execution.Id) =>
					Effect.flatMap(
						call(`/v1/app-authorization-actions/${id}`),
						HttpClientResponse.schemaBodyJson(AppAuthorizationApi.Action),
					)
				const wait = (
					id: Execution.Id,
					ready: (value: AppAuthorizationApi.Action) => boolean = (value) =>
						Execution.isTerminal(value.execution.status),
				) =>
					action(id).pipe(
						Effect.repeat({
							until: ready,
							schedule: Schedule.spaced("20 millis"),
						}),
						Effect.timeout("30 seconds"),
					)
				const accepted = (response: HttpClientResponse.HttpClientResponse) =>
					Effect.gen(function* () {
						assert.equal(response.status, 202, yield* response.text)
						return yield* HttpClientResponse.schemaBodyJson(Execution.Receipt)(
							response,
						)
					})
				const waitForConnection = (id: Execution.Id) =>
					call(`${connectionPath}/executions/${id}`).pipe(
						Effect.flatMap(
							HttpClientResponse.schemaBodyJson(
								ConnectionsApi.ConnectionExecution,
							),
						),
						Effect.repeat({
							until: (value) => Execution.isTerminal(value.execution.status),
							schedule: Schedule.spaced("20 millis"),
						}),
						Effect.timeout("30 seconds"),
					)
				const stop = (id: Execution.Id) =>
					Effect.gen(function* () {
						yield* wait(
							id,
							(value) => value.execution.status === "outcome_unknown",
						)
						const events = yield* Effect.flatMap(
							call(`/v1/executions/${id}/events?afterSequence=0`),
							HttpClientResponse.schemaBodyJson(ExecutionsApi.EventPage),
						)
						const decision = Option.getOrThrow(
							Arr.findLast(
								events.events,
								(event) => event.body._tag === "DecisionNeeded",
							),
						)
						assert.equal(decision.body._tag, "DecisionNeeded")
						if (decision.body._tag !== "DecisionNeeded")
							return yield* Effect.die("No decision found.")
						const response = yield* post(`/v1/executions/${id}/decisions`, {
							commandKey: `stop:${id}`,
							decisionId: decision.body.decisionId,
							answer: "stop",
						})
						assert.equal(response.status, 200, yield* response.text)
						return yield* wait(id)
					})
				const metadata = yield* anonymous("/v1/apps/client-metadata")
				assert.strictEqual(metadata.status, 200)
				assert.strictEqual(
					(yield* HttpClientResponse.schemaBodyJson(
						Authorization.ClientMetadata,
					)(metadata)).client_id,
					proxy.ipOrigin + "/v1/apps/client-metadata",
				)
				let beginCount = 0
				const begin = Effect.gen(function* () {
					const current = yield* readConnection
					const commandKey = `begin:${beginCount++}`
					const response = yield* post(connectionPath + "/authorization", {
						commandKey,
						revision: current.revision,
						scopes: ["documents"],
						returnTo: "/apps?query=documents",
					})
					const receipt = yield* accepted(response)
					const replay = yield* post(connectionPath + "/authorization", {
						commandKey,
						revision: current.revision,
						scopes: ["documents"],
						returnTo: "/apps?query=documents",
					}).pipe(Effect.flatMap(accepted))
					assert.equal(replay.executionId, receipt.executionId)
					const completed = yield* wait(receipt.executionId)
					assert.equal(
						completed.execution.status,
						"completed",
						completed.execution.failure?.errorId,
					)
					const started = Option.getOrThrow(
						Option.fromNullishOr(completed.result),
					)
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

				const completeBody = { commandKey: "complete-first" }
				const completed = yield* post(
					`/v1/app-authorizations/${first.flowId}/complete`,
					completeBody,
				).pipe(Effect.flatMap(accepted))
				assert.equal(
					(yield* wait(completed.executionId)).result?._tag,
					"Authorized",
				)
				const replay = yield* post(
					`/v1/app-authorizations/${first.flowId}/complete`,
					completeBody,
				).pipe(Effect.flatMap(accepted))
				assert.equal(replay.executionId, completed.executionId)
				assert.equal((yield* readFlow(first.flowId)).status, "Succeeded")

				assert.strictEqual(yield* publisher.exchanges, 1)
				yield* publisher.setTokenDelay(40)
				const refresh = post(connectionPath + "/refresh", {
					commandKey: "refresh-one",
				}).pipe(Effect.flatMap(accepted))
				const refreshed = yield* Effect.all([refresh, refresh], {
					concurrency: "unbounded",
				})
				assert.equal(refreshed[0].executionId, refreshed[1].executionId)
				assert.equal(
					(yield* wait(refreshed[0].executionId)).result?._tag,
					"Refreshed",
				)
				const nextRefresh = yield* post(connectionPath + "/refresh", {
					commandKey: "refresh-two",
				}).pipe(Effect.flatMap(accepted))
				yield* wait(nextRefresh.executionId)

				assert.strictEqual(yield* publisher.maxTokenRequests, 1)
				assert.strictEqual(yield* publisher.exchanges, 3)
				yield* publisher.setTokenDelay(0)
				const beforeReview = yield* readConnection
				const reviewDraft = yield* Effect.flatMap(
					post("/v1/connection-drafts", { input: publisher.origin + "/card" }),
					HttpClientResponse.schemaBodyJson(ConnectionsApi.ConnectionDraft),
				)
				const sameConfiguration = yield* post(connectionPath + "/revalidate", {
					commandKey: "review-same-configuration",
					revision: beforeReview.revision,
					draftId: reviewDraft.id,
					remoteIndex: 1,
					values: {},
					confirmed: true,
				}).pipe(Effect.flatMap(accepted))
				const reviewed = yield* waitForConnection(
					sameConfiguration.executionId,
				)
				assert.equal(reviewed.execution.status, "completed")
				assert.strictEqual(
					(yield* post("/v1/app-authorizations/" + first.flowId + "/complete", {
						commandKey: "complete-first-again",
					})).status,
					422,
				)
				assert.strictEqual((yield* call(callbackPath)).status, 422)
				assert.strictEqual(yield* publisher.exchanges, 3)
				yield* Effect.scoped(
					Effect.gen(function* () {
						const client = yield* AppConnections.openClient(
							host,
							alice.identity,
							connection.id,
							"OAuth test",
						)
						assert.deepStrictEqual((yield* client.listTools()).tools, [])
					}),
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
					commandKey: "unsupported",
					revision: current.revision,
					scopes: ["documents"],
				})
				const unsupportedResult = yield* wait(
					(yield* accepted(unsupported)).executionId,
				)
				assert.equal(unsupportedResult.execution.status, "failed")
				assert.ok(unsupportedResult.execution.failure?.errorId)
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
							sql`UPDATE openbot_app_authorizations SET status='Processing', execution_id=NULL WHERE id=${abandoned.flowId}`,
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
				// Reading an old row cannot invent a completed recovery.
				assert.strictEqual(interrupted.status, "Processing")
				assert.strictEqual(interrupted.executionId, null)
				const rejected = yield* begin
				const rejectedUrl = new URL(
					yield* publisher.issueCode(rejected.authorizationUrl),
				)
				yield* publisher.setRejectGrant(true)
				assert.strictEqual(
					(yield* call(rejectedUrl.pathname + rejectedUrl.search)).status,
					303,
				)

				const rejectedState = yield* readFlow(rejected.flowId)
				assert.isNotNull(rejectedState.executionId)
				const rejectedId = Option.getOrThrow(
					Option.fromNullishOr(rejectedState.executionId),
				)
				assert.equal((yield* stop(rejectedId)).execution.status, "interrupted")
				assert.equal((yield* readFlow(rejected.flowId)).status, "Failed")

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

				const revoke = (key: string) =>
					call(connectionPath + "/authorization", "DELETE", {
						commandKey: key,
					}).pipe(Effect.flatMap(accepted))
				const cleanup = yield* revoke("revoke-first")
				const pendingCleanup = yield* wait(
					cleanup.executionId,
					(value) =>
						value.result?._tag === "RevocationPending" &&
						Arr.some(
							value.cleanupExecutions,
							(child) => child.status === "waiting",
						),
				)
				assert.equal(pendingCleanup.execution.status, "completed")
				assert.equal((yield* readConnection).enabled, false)
				yield* host.restart
				yield* publisher.setRevocationFails(false)
				const revoked = yield* wait(
					cleanup.executionId,
					(value) => value.result?._tag === "Revoked",
				)
				assert.ok(
					Arr.every(
						revoked.cleanupExecutions,
						(child) => child.status === "completed",
					),
				)

				const cleared = yield* readConnection
				const enabled = yield* call(connectionPath, "PUT", {
					commandKey: "enable-after-revoke",
					revision: cleared.revision,
					name: cleared.name,
					enabled: true,
				}).pipe(Effect.flatMap(accepted))
				assert.equal(
					(yield* waitForConnection(enabled.executionId)).execution.status,
					"completed",
				)
				yield* publisher.setRevocationSupported(false)
				const localGrant = new URL(
					yield* publisher.issueCode((yield* begin).authorizationUrl),
				)
				assert.strictEqual(
					(yield* call(localGrant.pathname + localGrant.search)).status,
					303,
				)

				const localFlow = yield* readFlow(
					localGrant.searchParams.get("state") ?? "",
				)
				const localExecution = Option.getOrThrow(
					Option.fromNullishOr(localFlow.executionId),
				)
				yield* wait(localExecution)
				const localOnly = yield* revoke("revoke-local")
				const localResult = yield* wait(
					localOnly.executionId,
					(value) => value.result?._tag === "LocalOnly",
				)
				assert.equal(localResult.execution.status, "completed")

				assert.strictEqual(
					Arr.contains(yield* publisher.operations, "tools/call"),
					false,
				)
			}),
	)
})
