import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { AuthApi, SessionView } from "@openbot-build/platform-api"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { HttpServer } from "effect/http"
import * as Development from "../dist/Development.js"
import * as Database from "../dist/database/DatabasePostgres.js"
import { Scenarios } from "../src/app/DevelopmentScenarios.ts"
import { Business } from "../src/app/DevelopmentBusiness.ts"
import { ownerKey } from "../src/apps/Repository.ts"
import * as Postgres from "./PostgresTest.ts"

test("development Apps show protocol, requirement, expiry and cleanup failures through the standard APIs", async () => {
	const database = await Postgres.start()
	const options = {
		host: "127.0.0.1",
		port: 0,
		databaseUrl: Redacted.make(database.url),
		appEncryptionKey: Redacted.make("11".repeat(32)),
		auth: {
			mode: "development" as const,
			publicOrigin: "https://localhost:8443",
			secret: Redacted.make(
				"DevelopmentAppsSecretStableAcrossRestart123456789",
			),
		},
	}
	const migration = ManagedRuntime.make(
		Database.layer(options).pipe(Layer.provide(NodeServices.layer)),
	)
	await migration.runPromise(Database.migrate)
	const runtime = ManagedRuntime.make(Development.layer(options))
	try {
		const address = await runtime.runPromise(
			Effect.map(HttpServer.HttpServer, (server) =>
				HttpServer.formatAddress(server.address),
			),
		)
		const login = await fetch(address + "/auth/login", { redirect: "manual" })
		const cookie =
			login.headers
				.getSetCookie()
				.find((value) => value.startsWith(AuthApi.SessionCookie + "="))
				?.split(";")[0] ?? ""
		const headers = {
			cookie,
			origin: options.auth.publicOrigin,
			"content-type": "application/json",
		}
		const post = (path: string, body?: unknown) =>
			fetch(address + path, {
				method: "POST",
				headers,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				redirect: "manual",
			})
		const mode = (value: Parameters<typeof Scenarios.Service.set>[0]) =>
			runtime.runPromise(
				Effect.flatMap(Scenarios, (scenarios) => scenarios.set(value)),
			)
		const prepare = async () =>
			(
				await post("/v1/connection-drafts", { input: "app.development.test" })
			).json()
		const add = async (remoteIndex: number) => {
			const draft = await prepare()
			const response = await post("/v1/connections", {
				draftId: draft.id,
				revision: draft.revision,
				cardUrl: "https://app.development.test/card.json",
				remoteIndex,
				values: {},
				name:
					remoteIndex === 0
						? "Simulated documents"
						: "Simulated private documents",
				confirmed: true,
			})
			assert.equal(response.status, 201, await response.clone().text())
			return response.json()
		}
		const plain = await add(0)
		const path = "/v1/connections/" + plain.id
		assert.equal((await (await post(path + "/verify")).json())._tag, "Verified")
		await mode("protocol-failure")
		const incompatible = await (await post(path + "/verify")).json()
		assert.equal(incompatible.connection.availability._tag, "ConnectionFailed")
		await mode("requirements-changed")
		const changed = await (await post(path + "/verify")).json()
		assert.equal(changed.connection.availability._tag, "NeedsRevalidation")
		const draft = await prepare()
		const reviewed = await post(path + "/revalidate", {
			revision: changed.connection.revision,
			draftId: draft.id,
			remoteIndex: 0,
			values: {},
			confirmed: true,
		})
		assert.equal(reviewed.status, 200, await reviewed.clone().text())
		assert.equal((await (await post(path + "/verify")).json())._tag, "Verified")
		const account = Schema.decodeUnknownSync(AuthApi.SessionInfo)(
			await (await fetch(address + "/auth/session", { headers })).json(),
		)
		const executions = () =>
			runtime.runPromise(
				Effect.flatMap(Business, (business) =>
					business.executions(ownerKey(account.identity)),
				),
			)
		const created = await post("/v1/sessions", {
			settings: {
				model: {
					_tag: "Config.Selection",
					provider: "development",
					model: "mock-app",
				},
			},
		})
		assert.equal(created.status, 201, await created.clone().text())
		const session = Schema.decodeUnknownSync(SessionView)(await created.json())
		const sessionPath = "/v1/sessions/" + session.session.id
		const wait = async () => {
			let view = Schema.decodeUnknownSync(SessionView)(
				await (await fetch(address + sessionPath, { headers })).json(),
			)
			for (let index = 0; view.activity === "active" && index < 30; index++) {
				view = Schema.decodeUnknownSync(SessionView)(
					await (
						await fetch(
							address +
								sessionPath +
								"/wait?" +
								new URLSearchParams({
									after: String(view.session.revision),
									afterActivity: view.activity,
									timeoutMs: "1000",
								}),
							{ headers },
						)
					).json(),
				)
			}
			assert.notEqual(view.activity, "active")
			return view
		}
		assert.equal(
			(
				await post(sessionPath + "/turns", {
					expected: session.session.revision,
					input: "Read the simulated document",
				})
			).status,
			202,
		)
		const pending = await wait()
		const approvals = await (
			await fetch(address + sessionPath + "/approvals", { headers })
		).json()
		assert.equal(approvals.length, 1)
		assert.equal(await executions(), 0)
		const approval = approvals[0]
		assert.equal(
			(
				await post(
					sessionPath +
						"/turns/" +
						approval.turn +
						"/approvals/" +
						approval.approvalId,
					{ expected: pending.session.revision, approved: true },
				)
			).status,
			202,
		)
		const completed = await wait()
		assert.equal(completed.response?.status, "completed")
		assert.match(JSON.stringify(completed.response), /handlerExecutions/)
		assert.equal(await executions(), 1)
		await mode("available")
		const protectedApp = await add(1)
		const protectedPath = "/v1/connections/" + protectedApp.id
		const authorize = async () => {
			const current = await (
				await fetch(address + protectedPath, { headers })
			).json()
			const started = await post(protectedPath + "/authorization", {
				revision: current.revision,
				scopes: ["documents"],
			})
			assert.equal(started.status, 200, await started.clone().text())
			const authorization = await started.json()
			const query = new URL(authorization.authorizationUrl).search.slice(1)
			const consent = await fetch(address + "/development/apps/authorize", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ query, decision: "allow" }),
				redirect: "manual",
			})
			assert.equal(consent.status, 303)
			const callback = new URL(consent.headers.get("location") ?? "")
			const completed = await fetch(
				address + callback.pathname + callback.search,
				{ headers, redirect: "manual" },
			)
			assert.equal(completed.status, 303, await completed.clone().text())
		}
		await authorize()
		assert.equal(
			(await (await post(protectedPath + "/verify")).json())._tag,
			"Verified",
		)
		await mode("authorization-expired")
		const expired = await (await post(protectedPath + "/verify")).json()
		assert.equal(expired.connection.availability._tag, "AuthorizationExpired")
		await authorize()
		await mode("cleanup-failure")
		const revoke = () =>
			fetch(address + protectedPath + "/authorization", {
				method: "DELETE",
				headers,
			})
		assert.equal((await revoke()).status, 409)
		await mode("available")
		assert.equal((await (await revoke()).json())._tag, "Revoked")
		const disabled = await (
			await fetch(address + protectedPath, { headers })
		).json()
		assert.equal(
			(
				await fetch(address + protectedPath, {
					method: "PUT",
					headers,
					body: JSON.stringify({
						revision: disabled.revision,
						name: disabled.name,
						enabled: true,
					}),
				})
			).status,
			200,
		)
		await authorize()
		await mode("cleanup-failure")
		const partialResponse = await post("/v1/app-experience/reset", {})
		assert.equal(
			partialResponse.status,
			200,
			await partialResponse.clone().text(),
		)
		const partial = await partialResponse.json()
		assert.equal(partial.removed.length, 1)
		assert.equal(partial.pending.length, 1)
		assert.equal(partial.pending[0].id, protectedApp.id)
		assert.equal(
			(await (await fetch(address + protectedPath, { headers })).json())
				.availability._tag,
			"CleanupPending",
		)
		await mode("available")
		const finished = await (await post("/v1/app-experience/reset", {})).json()
		assert.equal(finished.removed.length, 1)
		assert.deepEqual(finished.pending, [])
		assert.equal(await executions(), 1)
		assert.equal((await fetch(address + sessionPath, { headers })).status, 200)
	} finally {
		await runtime.dispose()
		await migration.dispose()
		await database.close()
	}
})
