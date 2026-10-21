// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { AuthApi } from "@openbot-build/api"
import { Client } from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { Effect, Exit, Layer, Redacted, Scope } from "effect"
import { SqlClient } from "effect/sql"
import * as Probe from "../src/apps/Probe.ts"
import { AppHost, AppNetwork } from "../src/apps/AppHost.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"

test("live connection management closes old clients, asks for review of changed targets, and resumes cleanup without calling business tools", async () => {
	const publisher = await Fixture.start()
	const publicOrigin = "https://openbot.fixture.test"
	const host = await BrowserHost.start({
		publicOrigin,
		discovery: publisher.discovery,
		appProbe: publisher.probe,
		appNetwork: Layer.succeed(AppNetwork, {
			layer: (owner, origins) =>
				NodeHttpServer.layerUserNetwork({
					owner,
					allowedOrigins: origins,
					ca: publisher.ca,
					allowAddress: (ip) => ip === "127.0.0.1",
				}),
		}),
	})
	const scope = Scope.makeUnsafe()
	try {
		const alice = await host.login("lifecycle-alice")
		const bob = await host.login("lifecycle-bob")
		const headers = (session = alice.session) => ({
			cookie:
				AuthApi.SessionCookie +
				"=" +
				encodeURIComponent(Redacted.value(session)),
			origin: publicOrigin,
			"content-type": "application/json",
		})
		const send = (path: string, method: string, body?: unknown) =>
			fetch(host.address + path, {
				method,
				headers: headers(),
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			})
		const prepare = async () => {
			const response = await send("/v1/connection-drafts", "POST", {
				input: publisher.origin + "/card",
			})
			assert.equal(response.status, 201)
			return response.json()
		}
		const draft = await prepare()
		const values = {
			"header:X-Account": "Work",
			"header:X-Secret": "lifecycle-private-configuration",
		}
		const added = await send("/v1/connections", "POST", {
			draftId: draft.id,
			revision: draft.revision,
			cardUrl: publisher.origin + "/card",
			remoteIndex: 0,
			name: "Work documents",
			values,
			confirmed: true,
		})
		assert.equal(added.status, 201)
		const connection = await added.json()
		const path = "/v1/connections/" + connection.id
		const verify = await send(path + "/verify", "POST")
		assert.equal(verify.status, 200, await verify.clone().text())
		const verified = await verify.json()
		assert.equal(verified._tag, "Verified")
		assert.equal(
			verified.capabilities.connection.availability._tag,
			"Available",
		)
		assert.deepEqual(verified.capabilities.tools, [])
		assert.equal(
			JSON.stringify(verified).includes(values["header:X-Secret"]),
			false,
		)
		const client = await host.runtime.runPromise(
			Effect.gen(function* () {
				const app = (yield* AppHost).bind(
					ownerKey(alice.identity),
					Client.InvocationPolicy.of({ check: () => Effect.void }),
				)
				return yield* app.open({
					key: { owner: ownerKey(alice.identity), connectionId: connection.id },
					clientInfo: { name: "Scope test", version: "1.0.0" },
				})
			}).pipe(Effect.provideService(Scope.Scope, scope)),
		)
		const disabled = await send(path, "PUT", {
			revision: verified.capabilities.connection.revision,
			name: connection.name,
			enabled: false,
		})
		assert.equal(disabled.status, 200)
		const stopped = await disabled.json()
		const before = publisher.requests().length
		const oldClient = await host.runtime.runPromise(
			Effect.result(client.listTools()),
		)
		assert.equal(oldClient._tag, "Failure")
		assert.equal(publisher.requests().length, before)
		assert.equal(
			(
				await send(path, "PUT", {
					revision: connection.revision,
					name: connection.name,
					enabled: true,
				})
			).status,
			409,
		)
		const enabled = await (
			await send(path, "PUT", {
				revision: stopped.revision,
				name: connection.name,
				enabled: true,
			})
		).json()
		assert.equal(enabled.availability._tag, "Unverified")
		publisher.changeCard()
		const changed = await (await send(path + "/verify", "POST")).json()
		assert.equal(changed._tag, "Unavailable")
		assert.equal(changed.connection.availability._tag, "NeedsRevalidation")
		assert.equal(changed.connection.enabled, false)
		const reviewed = await prepare()
		const revalidation = await send(path + "/revalidate", "POST", {
			revision: changed.connection.revision,
			draftId: reviewed.id,
			remoteIndex: 0,
			values,
			confirmed: true,
		})
		assert.equal(revalidation.status, 200, await revalidation.clone().text())
		const current = await revalidation.json()
		assert.equal(current.enabled, true)
		assert.equal(current.endpoint, publisher.origin + "/mcp-updated")
		assert.equal(
			(await (await send(path + "/verify", "POST")).json())._tag,
			"Verified",
		)
		assert.equal(
			(
				await fetch(host.address + path + "/verify", {
					method: "POST",
					headers: headers(bob.session),
				})
			).status,
			404,
		)
		assert.equal(
			(
				await fetch(host.address + path, {
					method: "DELETE",
					headers: headers(bob.session),
				})
			).status,
			404,
		)
		await host.runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				yield* sql.unsafe(
					"CREATE FUNCTION reject_app_removal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'App removal storage unavailable'; END $$",
				)
				yield* sql.unsafe(
					"CREATE TRIGGER reject_app_removal BEFORE DELETE ON openbot_app_connections FOR EACH ROW EXECUTE FUNCTION reject_app_removal()",
				)
			}),
		)
		const pending = await send(path, "DELETE")
		assert.equal(pending.status, 409, await pending.clone().text())
		assert.equal((await pending.json()).stage, "Connection")
		const cleanup = await (await send(path, "GET")).json()
		assert.equal(cleanup.enabled, false)
		assert.equal(cleanup.availability._tag, "CleanupPending")
		assert.equal(
			(
				await send(path, "PUT", {
					revision: cleanup.revision,
					name: cleanup.name,
					enabled: true,
				})
			).status,
			409,
		)
		await host.runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				yield* sql.unsafe(
					"DROP TRIGGER reject_app_removal ON openbot_app_connections",
				)
				yield* sql.unsafe("DROP FUNCTION reject_app_removal()")
			}),
		)
		assert.equal((await send(path, "DELETE")).status, 204)
		assert.equal((await send(path, "GET")).status, 404)
		assert.equal(
			publisher
				.requests()
				.filter((request) => request.path.includes("tools/call")).length,
			0,
		)
	} finally {
		await Effect.runPromise(Scope.close(scope, Exit.void))
		await host.close()
		await publisher.close()
	}
})

test("manual MCP connections stay private, keep secret headers and use the live lifecycle without Card discovery", async () => {
	const publisher = await Fixture.start({ capabilities: true })
	const publicOrigin = "https://openbot.fixture.test"
	const network = (owner: string, origins: ReadonlyArray<string>) =>
		NodeHttpServer.layerUserNetwork({
			owner,
			allowedOrigins: origins,
			ca: publisher.ca,
			allowAddress: (ip) => ip === "127.0.0.1",
		})
	const host = await BrowserHost.start({
		publicOrigin,
		appProbe: Probe.layerWithNetwork((connection) =>
			network(connection.owner, [new URL(connection.endpoint).origin]),
		),
		appNetwork: Layer.succeed(AppNetwork, { layer: network }),
	})
	const scope = Scope.makeUnsafe()
	try {
		const alice = await host.login("manual-alice")
		const bob = await host.login("manual-bob")
		const headers = (session = alice.session) => ({
			cookie:
				AuthApi.SessionCookie +
				"=" +
				encodeURIComponent(Redacted.value(session)),
			origin: publicOrigin,
			"content-type": "application/json",
		})
		const send = (path: string, method: string, body?: unknown) =>
			fetch(host.address + path, {
				method,
				headers: headers(),
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			})
		const input = {
			id: crypto.randomUUID(),
			name: "Manual documents",
			transport: "streamable-http",
			url: publisher.origin + "/mcp",
			headers: { "X-Account": "Work", "X-Secret": "manual-private-secret" },
		}
		assert.equal(
			(
				await send("/v1/connections/manual", "POST", {
					...input,
					url: "http://example.test/mcp",
				})
			).status,
			400,
		)
		const created = await send("/v1/connections/manual", "POST", input)
		assert.equal(created.status, 201, await created.clone().text())
		const connection = await created.json()
		const path = "/v1/connections/" + connection.id
		assert.equal(connection.sources[0].role, "manual")
		assert.equal(
			JSON.stringify(connection).includes(input.headers["X-Secret"]),
			false,
		)
		assert.equal(
			(await send("/v1/connections/manual", "POST", input)).status,
			201,
		)
		const verified = await (await send(path + "/verify", "POST")).json()
		assert.equal(verified._tag, "Verified")
		assert.ok(verified.capabilities.tools.length > 0)
		await host.runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				assert.equal(
					(yield* sql`SELECT * FROM openbot_app_index_jobs`).length,
					0,
				)
				const records = yield* sql<{
					readonly body: string
				}>`SELECT body FROM openbot_app_records UNION ALL SELECT body FROM openbot_app_connections`
				assert.equal(
					records.some((record) =>
						record.body.includes(input.headers["X-Secret"]),
					),
					false,
				)
			}),
		)
		const client = await host.runtime.runPromise(
			Effect.gen(function* () {
				const app = (yield* AppHost).bind(
					ownerKey(alice.identity),
					Client.InvocationPolicy.of({ check: () => Effect.void }),
				)
				return yield* app.open({
					key: { owner: ownerKey(alice.identity), connectionId: connection.id },
					clientInfo: { name: "Manual lifecycle", version: "1.0.0" },
				})
			}).pipe(Effect.provideService(Scope.Scope, scope)),
		)
		const updated = await send(path + "/manual", "PUT", {
			name: "Updated manual documents",
			transport: "streamable-http",
			url: publisher.origin + "/mcp-updated",
			headers: { "X-Account": null, "X-Secret": null },
			revision: verified.capabilities.connection.revision,
		})
		assert.equal(updated.status, 200, await updated.clone().text())
		const changed = await updated.json()
		assert.equal(changed.endpoint, publisher.origin + "/mcp-updated")
		assert.equal(
			JSON.stringify(changed).includes(input.headers["X-Secret"]),
			false,
		)
		const before = publisher.requests().length
		assert.equal(
			(await host.runtime.runPromise(Effect.result(client.listTools())))._tag,
			"Failure",
		)
		assert.equal(publisher.requests().length, before)
		assert.equal(
			(await send(path + "/manual", "PUT", { ...input, revision: 0 })).status,
			409,
		)
		assert.equal(
			(await fetch(host.address + path, { headers: headers(bob.session) }))
				.status,
			404,
		)
		await host.restart()
		assert.equal(
			(await (await send(path + "/verify", "POST")).json())._tag,
			"Verified",
		)
		assert.equal(
			publisher.requests().some((request) => request.path.startsWith("/card")),
			false,
		)
		assert.equal(
			publisher
				.requests()
				.some((request) => request.path.includes("tools/call")),
			false,
		)
		assert.equal((await send(path, "DELETE")).status, 204)
		assert.equal((await send(path, "GET")).status, 404)
	} finally {
		await Effect.runPromise(Scope.close(scope, Exit.void))
		await host.close()
		await publisher.close()
	}
})
