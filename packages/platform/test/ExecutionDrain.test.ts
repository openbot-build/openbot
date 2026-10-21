import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout } from "node:timers/promises"
import { Redacted } from "effect"
import * as BrowserHost from "./BrowserHost.ts"

test(
	"drain waits for background execution and rejects new writes",
	{ timeout: 30000 },
	async (t) => {
		let phase = "OPENBOT_ACTIVE",
			serial = 0
		const leases = new Set<string>()
		const actualFetch = globalThis.fetch
		const authority = t.mock.method(
			globalThis,
			"fetch",
			async (url: URL | RequestInfo, init?: RequestInit) => {
				const parsed = new URL(url instanceof Request ? url.url : String(url))
				if (parsed.hostname !== "authority.test") return actualFetch(url, init)
				if (parsed.pathname.startsWith("/internal/auth/"))
					return Response.json(
						parsed.pathname.endsWith("release")
							? { released: true }
							: {
									allowed: true,
									epoch: 1,
									phase: "OPENBOT_ACTIVE",
									leaseId: "auth-" + ++serial,
								},
					)
				const body = JSON.parse(String(init?.body))
				const path = parsed.pathname.split("/").at(-1)
				if (path === "assignment") return Response.json({ assigned: true })
				if (path === "release") {
					leases.delete(body.leaseId)
					return Response.json({ released: true })
				}
				if (path === "drain-check")
					return Response.json({
						allowed: phase === "DRAINING" && body.migrationId === "migration-1",
						epoch: 4,
						phase,
						migrationId: body.migrationId,
					})
				const allowed =
					phase === "OPENBOT_ACTIVE" ||
					(phase === "DRAINING" &&
						path === "acquire" &&
						body.intent !== "admit")
				const leaseId = String(++serial)
				if (path === "acquire" && allowed) leases.add(leaseId)
				return Response.json({ allowed, epoch: 4, phase, leaseId })
			},
		)
		const publicOrigin = "https://client.example.com"
		const host = await BrowserHost.start({
			publicOrigin,
			execution: {
				origin: "http://authority.test",
				token: Redacted.make("test-only"),
				backend: "openbot",
			},
		})
		try {
			const alice = await host.login("alice")
			const headers = {
				cookie:
					"__Host-openbot-session=" +
					encodeURIComponent(Redacted.value(alice.session)),
				origin: publicOrigin,
				"content-type": "application/json",
			}
			const stale = await fetch(host.address + "/v1/sessions", {
				method: "POST",
				headers: { ...headers, "x-kay-epoch": "3" },
				body: JSON.stringify({ title: "Stale gateway request" }),
			})
			assert.equal(stale.status, 503)
			const created = await fetch(host.address + "/v1/sessions", {
				method: "POST",
				headers,
				body: JSON.stringify({ title: "Drain fixture" }),
			})
			assert.equal(created.status, 201, await created.clone().text())
			const saved = await created.json()
			const started = await fetch(
				host.address + "/v1/sessions/" + saved.session.id + "/turns",
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						expected: saved.session.revision,
						input: "slow response",
					}),
				},
			)
			assert.equal(started.status, 202, await started.clone().text())
			const control = (action: string, token = "test-only") =>
				fetch(host.address + "/internal/execution/" + action, {
					method: "POST",
					headers: { authorization: "Bearer " + token },
				})
			assert.equal((await control("quiesce", "wrong")).status, 401)
			const quiesced = await control("quiesce")
			assert.equal(quiesced.status, 200)
			assert.equal((await quiesced.json()).drained, false)
			assert.equal(
				(
					await fetch(host.address + "/v1/sessions", {
						method: "POST",
						headers,
						body: JSON.stringify({ title: "Cannot start during release" }),
					})
				).status,
				503,
			)
			const resumed = await control("resume")
			assert.equal((await resumed.json()).quiesced, false)
			phase = "DRAINING"
			const rejected = await fetch(host.address + "/v1/sessions", {
				method: "POST",
				headers,
				body: JSON.stringify({ title: "Should not start" }),
			})
			assert.equal(rejected.status, 503)
			const drain = (
				overrides: Record<string, unknown> = {},
				token = "test-only",
			) =>
				fetch(host.address + "/internal/execution/drain", {
					method: "POST",
					headers: {
						authorization: "Bearer " + token,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						accountId: alice.identity.userId,
						sourceTenantId: JSON.stringify([
							alice.identity.organizationId,
							alice.identity.userId,
						]),
						migrationId: "migration-1",
						epoch: 4,
						...overrides,
					}),
				})
			assert.equal((await drain({}, "wrong")).status, 401)
			assert.equal((await drain({ epoch: 99 })).status, 409)
			assert.equal((await drain({ migrationId: "wrong" })).status, 409)
			const missingOwner = await fetch(
				host.address + "/internal/apps/authorization-owner",
				{
					method: "POST",
					headers: {
						authorization: "Bearer test-only",
						"content-type": "application/json",
					},
					body: JSON.stringify({ flowId: "missing" }),
				},
			)
			assert.equal(missingOwner.status, 404)
			const busy = await drain()
			assert.equal(busy.status, 200, await busy.clone().text())
			assert.equal((await busy.json()).drained, false)
			let drained = false
			for (let attempt = 0; attempt < 60 && !drained; attempt++) {
				await setTimeout(200)
				const response = await drain()
				assert.equal(response.status, 200)
				drained = (await response.json()).drained
			}
			assert.equal(drained, true)
			assert.equal((await (await control("quiesce")).json()).drained, true)
			await control("resume")
			assert.equal(leases.size, 0)
			phase = "OPENBOT_ACTIVE"
			const approvalSession = await fetch(host.address + "/v1/sessions", {
				method: "POST",
				headers,
				body: JSON.stringify({ title: "Approval waits" }),
			})
			assert.equal(approvalSession.status, 201)
			const pending = await approvalSession.json()
			const approval = await fetch(
				host.address + "/v1/sessions/" + pending.session.id + "/turns",
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						expected: pending.session.revision,
						input: "approval needed",
					}),
				},
			)
			assert.equal(approval.status, 202)
			await setTimeout(700)
			phase = "DRAINING"
			const waiting = await drain()
			assert.equal(waiting.status, 200)
			assert.equal(
				(await waiting.json()).drained,
				false,
				"pending approval must defer migration",
			)
			await host.restart()
			const persisted = await control("quiesce")
			assert.equal(persisted.status, 200)
			const status = await persisted.json()
			assert.equal(
				status.drained,
				false,
				"restarted runtime must inspect unopened durable approvals",
			)
			assert.ok(status.persistedPending > 0)
		} finally {
			await host.close()
			authority.mock.restore()
		}
	},
)
