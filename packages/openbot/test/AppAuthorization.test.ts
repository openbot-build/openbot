// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest"
import { request as requestHttp } from "node:http"
import {
	AuthApi,
	AppAuthorizationApi,
	ConnectionsApi,
} from "@openbot-build/api"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { Client } from "@openbot-build/protocol"
import { Effect, Layer, Redacted, Schema } from "effect"
import { AppHost, AppNetwork } from "../src/apps/AppHost.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import { SqlClient } from "effect/sql"
import { startHttps } from "../../protocol/test/Fixture.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"

it("OpenBot completes real CIMD and PKCE flows once, resumes callbacks after login, and keeps accounts apart", async () => {
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
	const publisher = await Fixture.start()
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
		const alice = await host.login("authorization-alice")
		assert.strictEqual(alice.returnLocation, proxy.ipOrigin + "/")
		const bob = await host.login("authorization-bob")
		const headers = (session = alice.session) => ({
			cookie:
				AuthApi.SessionCookie +
				"=" +
				encodeURIComponent(Redacted.value(session)),
			origin: proxy.ipOrigin,
			"content-type": "application/json",
		})
		const post = (path: string, body: unknown, session = alice.session) =>
			fetch(host.address + path, {
				method: "POST",
				headers: headers(session),
				body: JSON.stringify(body),
				redirect: "manual",
			})
		const prepared = await post("/v1/connection-drafts", {
			input: publisher.origin + "/card",
		})
		assert.strictEqual(prepared.status, 201)
		const draft = Schema.decodeUnknownSync(
			Schema.toCodecJson(ConnectionsApi.ConnectionDraft),
		)(await prepared.json())
		const saved = await post("/v1/connections", {
			draftId: draft.id,
			revision: draft.revision,
			cardUrl: publisher.origin + "/card",
			remoteIndex: 1,
			name: "Documents",
			values: {},
			confirmed: true,
		})
		assert.strictEqual(saved.status, 201)
		const connection = Schema.decodeUnknownSync(
			Schema.toCodecJson(ConnectionsApi.Connection),
		)(await saved.json())
		const metadata = await fetch(host.address + "/v1/apps/client-metadata")
		assert.strictEqual(metadata.status, 200)
		assert.strictEqual(
			(await metadata.json()).client_id,
			proxy.ipOrigin + "/v1/apps/client-metadata",
		)
		const begin = async () => {
			const current = Schema.decodeUnknownSync(
				Schema.toCodecJson(ConnectionsApi.Connection),
			)(
				await (
					await fetch(host.address + "/v1/connections/" + connection.id, {
						headers: headers(),
					})
				).json(),
			)
			const response = await post(
				"/v1/connections/" + connection.id + "/authorization",
				{
					revision: current.revision,
					scopes: ["documents"],
					returnTo: "/apps?query=documents",
				},
			)
			assert.strictEqual(response.status, 200, await response.clone().text())
			const started = Schema.decodeUnknownSync(
				Schema.toCodecJson(AppAuthorizationApi.Started),
			)(await response.json())
			assert.strictEqual(started._tag, "AuthorizationStarted")
			if (started._tag !== "AuthorizationStarted")
				throw new Error("Expected an authorization redirect")
			assert.strictEqual(
				new URL(started.authorizationUrl).searchParams.get(
					"code_challenge_method",
				),
				"S256",
			)
			return started
		}
		const first = await begin()
		const callback = publisher.issueCode(first.authorizationUrl)
		const callbackPath = new URL(callback).pathname + new URL(callback).search
		assert.strictEqual(
			(
				await fetch(host.address + callbackPath, {
					headers: headers(bob.session),
					redirect: "manual",
				})
			).status,
			404,
		)
		assert.strictEqual(publisher.exchanges(), 0)
		const received = await fetch(host.address + callbackPath, {
			redirect: "manual",
		})
		assert.strictEqual(received.status, 303)
		const pending = new URL(received.headers.get("location") ?? "")
		assert.strictEqual(pending.pathname, "/")
		assert.strictEqual(pending.searchParams.get("authorization"), first.flowId)
		assert.strictEqual(publisher.exchanges(), 0)
		await host.restart()
		address = host.address
		const completed = await post(
			"/v1/app-authorizations/" + first.flowId + "/complete",
			{},
		)
		assert.strictEqual(completed.status, 200, await completed.clone().text())
		assert.strictEqual((await completed.json()).status, "Succeeded")
		assert.strictEqual(publisher.exchanges(), 1)
		publisher.setTokenDelay(40)
		await Promise.all(
			[0, 1].map(() =>
				host.runtime.runPromise(
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
				),
			),
		)
		assert.strictEqual(publisher.maxTokenRequests(), 1)
		assert.strictEqual(publisher.exchanges(), 3)
		publisher.setTokenDelay(0)
		const beforeReview = await (
			await fetch(host.address + "/v1/connections/" + connection.id, {
				headers: headers(),
			})
		).json()
		const reviewDraft = await (
			await post("/v1/connection-drafts", { input: publisher.origin + "/card" })
		).json()
		const sameConfiguration = await post(
			"/v1/connections/" + connection.id + "/revalidate",
			{
				revision: beforeReview.revision,
				draftId: reviewDraft.id,
				remoteIndex: 1,
				values: {},
				confirmed: true,
			},
		)
		assert.strictEqual(
			sameConfiguration.status,
			200,
			await sameConfiguration.clone().text(),
		)
		assert.strictEqual(
			(await post("/v1/app-authorizations/" + first.flowId + "/complete", {}))
				.status,
			422,
		)
		assert.strictEqual(
			(
				await fetch(host.address + callbackPath, {
					headers: headers(),
					redirect: "manual",
				})
			).status,
			422,
		)
		assert.strictEqual(publisher.exchanges(), 3)
		await host.runtime.runPromise(
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
		const second = await begin()
		const cancelled = new URL(publisher.issueCode(second.authorizationUrl))
		cancelled.searchParams.delete("code")
		cancelled.searchParams.set("error", "access_denied")
		const cancellation = await fetch(
			host.address + cancelled.pathname + cancelled.search,
			{ headers: headers(), redirect: "manual" },
		)
		assert.strictEqual(cancellation.status, 303)
		assert.strictEqual(
			(
				await (
					await fetch(
						host.address + "/v1/app-authorizations/" + second.flowId,
						{ headers: headers() },
					)
				).json()
			).status,
			"Cancelled",
		)
		assert.strictEqual(publisher.exchanges(), 3)
		publisher.setCimd(false)
		const current = await (
			await fetch(host.address + "/v1/connections/" + connection.id, {
				headers: headers(),
			})
		).json()
		const unsupported = await post(
			"/v1/connections/" + connection.id + "/authorization",
			{ revision: current.revision, scopes: ["documents"] },
		)
		assert.strictEqual(unsupported.status, 422)
		assert.strictEqual((await unsupported.json()).reason, "CimdUnsupported")
		publisher.setCimd(true)
		const wrongIssuer = await begin()
		const wrongCallback = new URL(
			publisher.issueCode(wrongIssuer.authorizationUrl),
		)
		wrongCallback.searchParams.set("iss", "https://foreign.test")
		assert.strictEqual(
			(
				await fetch(
					host.address + wrongCallback.pathname + wrongCallback.search,
					{ headers: headers(), redirect: "manual" },
				)
			).status,
			422,
		)
		assert.strictEqual(publisher.exchanges(), 3)
		const expiring = await begin()
		await host.runtime.runPromise(
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql`UPDATE openbot_app_authorizations SET expires_at=0 WHERE id=${expiring.flowId}`,
			),
		)
		const expired = new URL(publisher.issueCode(expiring.authorizationUrl))
		assert.strictEqual(
			(
				await fetch(host.address + expired.pathname + expired.search, {
					headers: headers(),
					redirect: "manual",
				})
			).status,
			422,
		)
		assert.strictEqual(publisher.exchanges(), 3)
		const rejected = await begin()
		const rejectedUrl = new URL(publisher.issueCode(rejected.authorizationUrl))
		publisher.setRejectGrant(true)
		assert.strictEqual(
			(
				await fetch(host.address + rejectedUrl.pathname + rejectedUrl.search, {
					headers: headers(),
					redirect: "manual",
				})
			).status,
			303,
		)
		assert.strictEqual(
			(
				await (
					await fetch(
						host.address + "/v1/app-authorizations/" + rejected.flowId,
						{ headers: headers() },
					)
				).json()
			).status,
			"Failed",
		)
		assert.strictEqual(
			(
				await post(
					"/v1/app-authorizations/" + rejected.flowId + "/complete",
					{},
				)
			).status,
			422,
		)
		assert.strictEqual(publisher.exchanges(), 4)
		for (const returnTo of [
			"/apps?query=documents",
			"/connections?input=publisher.test",
			"/chats/existing-chat",
		]) {
			assert.strictEqual(
				(await host.login("return-user", returnTo)).returnLocation,
				proxy.ipOrigin + returnTo,
			)
		}
		const signIn = (callbackURL: string) =>
			fetch(host.address + "/auth/sign-in/social", {
				method: "POST",
				headers: {
					origin: proxy.ipOrigin,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					provider: "oidc",
					callbackURL,
					disableRedirect: true,
				}),
			})
		for (const callbackURL of [
			"https://foreign.test",
			"//foreign.test",
			"/\\foreign.test",
		])
			assert.strictEqual((await signIn(callbackURL)).status, 403, callbackURL)
		publisher.setRejectGrant(false)
		publisher.setRevocationFails(true)
		const revoke = () =>
			fetch(
				host.address + "/v1/connections/" + connection.id + "/authorization",
				{ method: "DELETE", headers: headers() },
			)
		const failedCleanup = await revoke()
		assert.strictEqual(
			failedCleanup.status,
			409,
			await failedCleanup.clone().text(),
		)
		assert.strictEqual((await failedCleanup.json()).stage, "Credentials")
		const stopped = await (
			await fetch(host.address + "/v1/connections/" + connection.id, {
				headers: headers(),
			})
		).json()
		assert.strictEqual(stopped.enabled, false)
		assert.strictEqual(stopped.availability._tag, "CleanupPending")
		publisher.setRevocationFails(false)
		const revoked = await revoke()
		assert.strictEqual(revoked.status, 200, await revoked.clone().text())
		assert.strictEqual((await revoked.json())._tag, "Revoked")
		const cleared = await (
			await fetch(host.address + "/v1/connections/" + connection.id, {
				headers: headers(),
			})
		).json()
		assert.strictEqual(
			(
				await fetch(host.address + "/v1/connections/" + connection.id, {
					method: "PUT",
					headers: headers(),
					body: JSON.stringify({
						revision: cleared.revision,
						name: cleared.name,
						enabled: true,
					}),
				})
			).status,
			200,
		)
		publisher.setRevocationSupported(false)
		const localGrant = new URL(
			publisher.issueCode((await begin()).authorizationUrl),
		)
		assert.strictEqual(
			(
				await fetch(host.address + localGrant.pathname + localGrant.search, {
					headers: headers(),
					redirect: "manual",
				})
			).status,
			303,
		)
		const localOnly = await revoke()
		assert.strictEqual(localOnly.status, 200, await localOnly.clone().text())
		assert.strictEqual((await localOnly.json())._tag, "LocalOnly")
		assert.strictEqual(publisher.operations().includes("tools/call"), false)
	} finally {
		await host.close()
		await publisher.close()
		await proxy.close()
	}
})
