// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { request as requestHttp } from "node:http"
import { AuthApi } from "@openbot-build/api"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { Client } from "@openbot-build/protocol"
import { Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { AppHost, AppNetwork } from "../src/apps/AppHost.ts"
import { ownerKey } from "../src/apps/Repository.ts"
import { startHttps } from "../../protocol/test/Fixture.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"

for (const method of ["none", "client_secret_basic"] as const)
	for (const defaultScopes of [false, true])
		test(`Hosted MCP ${method} ${defaultScopes ? "provider-default" : "explicit"} scopes registration survives restart, consent denial and isolated refresh/revocation`, async () => {
			let address = ""
			const proxy = await startHttps((req, res) => {
				const upstream = requestHttp(
					new URL(req.url ?? "/", address),
					{ method: req.method, headers: req.headers },
					(response) => {
						res.writeHead(response.statusCode ?? 500, response.headers)
						response.pipe(res)
					},
				)
				upstream.on("error", () => {
					res.writeHead(502)
					res.end()
				})
				req.pipe(upstream)
			})
			const publisher = await Fixture.start({
				dcr: method,
				standardMcp: true,
				defaultScopes,
			})
			const host = await BrowserHost.start({
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
			address = host.address
			try {
				const alice = await host.login("hosted-alice")
				const bob = await host.login("hosted-bob")
				const headers = (session = alice.session) => ({
					cookie:
						AuthApi.SessionCookie +
						"=" +
						encodeURIComponent(Redacted.value(session)),
					origin: proxy.ipOrigin,
					"content-type": "application/json",
				})
				const send = (
					path: string,
					method: string,
					body?: unknown,
					session = alice.session,
				) =>
					fetch(host.address + path, {
						method,
						headers: headers(session),
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
						redirect: "manual",
					})
				const created = await send("/v1/connections/manual", "POST", {
					id: crypto.randomUUID(),
					name: "Hosted documents",
					transport: "streamable-http",
					url: publisher.origin + "/protected",
					headers: {},
				})
				assert.equal(created.status, 201, await created.clone().text())
				const connection = await created.json()
				const path = "/v1/connections/" + connection.id
				assert.equal(connection.sources[0].role, "manual")
				const begin = async () => {
					const current = await (await send(path, "GET")).json()
					const response = await send(path + "/authorization", "POST", {
						revision: current.revision,
						scopes: defaultScopes ? [] : ["documents"],
						returnTo: "/apps",
					})
					assert.equal(response.status, 200, await response.clone().text())
					const started = await response.json()
					assert.equal(started._tag, "AuthorizationStarted")
					assert.equal(
						new URL(started.authorizationUrl).searchParams.has("scope"),
						!defaultScopes,
					)
					assert.equal(
						new URL(started.authorizationUrl).searchParams.get("client_id"),
						"fixture-registered-client",
					)
					assert.equal(
						JSON.stringify(started).includes("fixture-private-client-secret"),
						false,
					)
					return started
				}
				const cancelled = await begin()
				const denied = new URL(publisher.issueCode(cancelled.authorizationUrl))
				denied.searchParams.delete("code")
				denied.searchParams.set("error", "access_denied")
				assert.equal(
					(await send(denied.pathname + denied.search, "GET")).status,
					303,
				)
				assert.equal(
					(
						await (
							await send("/v1/app-authorizations/" + cancelled.flowId, "GET")
						).json()
					).status,
					"Cancelled",
				)
				assert.equal(publisher.exchanges(), 0)
				const started = await begin()
				assert.equal(publisher.registrations(), 2)
				const callback = new URL(publisher.issueCode(started.authorizationUrl))
				assert.equal(
					(
						await send(
							callback.pathname + callback.search,
							"GET",
							undefined,
							bob.session,
						)
					).status,
					404,
				)
				const received = await fetch(
					host.address + callback.pathname + callback.search,
					{ redirect: "manual" },
				)
				assert.equal(received.status, 303)
				assert.equal(publisher.exchanges(), 0)
				await host.restart()
				address = host.address
				const completed = await send(
					"/v1/app-authorizations/" + started.flowId + "/complete",
					"POST",
					{},
				)
				assert.equal(completed.status, 200, await completed.clone().text())
				assert.equal((await completed.json()).status, "Succeeded")
				assert.equal(publisher.exchanges(), 1)
				assert.equal(
					(
						await send(
							"/v1/app-authorizations/" + started.flowId + "/complete",
							"POST",
							{},
						)
					).status,
					422,
				)
				await host.restart()
				address = host.address
				await host.runtime.runPromise(
					Effect.gen(function* () {
						const factory = yield* AppHost
						const owner = ownerKey(alice.identity)
						yield* factory
							.bind(
								owner,
								Client.InvocationPolicy.of({ check: () => Effect.void }),
							)
							.refreshAuthorization({ owner, connectionId: connection.id })
						const bound = factory.bind(
							owner,
							Client.InvocationPolicy.of({ check: () => Effect.void }),
						)
						const restored = yield* bound.getConnection({
							owner,
							connectionId: connection.id,
						})
						assert.ok("scopes" in restored.authorization)
						assert.deepEqual(restored.authorization.scopes, ["documents"])
						publisher.setGrantedScope("documents admin")
						const expanded = yield* Effect.flip(
							bound.refreshAuthorization({
								owner,
								connectionId: connection.id,
							}),
						)
						assert.equal(expanded._tag, "AuthorizationError")
						assert.ok(
							"reason" in expanded && expanded.reason === "ScopeRequired",
						)
						publisher.setGrantedScope("documents")
						const sql = yield* SqlClient.SqlClient
						const secrets = yield* sql<{
							readonly body: string
						}>`SELECT body FROM openbot_app_secrets`
						assert.ok(secrets.length > 0)
						assert.equal(
							secrets.some(({ body }) =>
								body.includes("fixture-private-client-secret"),
							),
							false,
						)
					}),
				)
				assert.equal(publisher.exchanges(), 3)
				assert.equal(publisher.registrations(), 2)
				assert.equal(
					(
						await send(
							path + "/authorization",
							"DELETE",
							undefined,
							bob.session,
						)
					).status,
					404,
				)
				const revoked = await send(path + "/authorization", "DELETE")
				assert.equal(revoked.status, 200, await revoked.clone().text())
				assert.equal((await revoked.json())._tag, "Revoked")
				assert.equal(publisher.businessCalls(), 0)
			} finally {
				await host.close()
				await publisher.close()
				await proxy.close()
			}
		})
