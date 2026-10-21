import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { once } from "node:events"
import { createHmac, randomUUID } from "node:crypto"
import { Redacted } from "effect"
import { Pool } from "pg"
import * as BrowserHost from "./BrowserHost.ts"

test(
	"private cookie checks stay read-only during freeze and revocation requires its durable lease",
	{ timeout: 60000 },
	async () => {
		let frozen = false,
			allowRevoke = false,
			accountId = "",
			credentialDigest = ""
		const token = "fixture-internal-token-at-least-thirty-two-bytes"
		const authority = createServer((req, res) => {
			assert.equal(req.headers.authorization, "Bearer " + token)
			res.setHeader("content-type", "application/json")
			if (
				req.url === "/internal/auth/revocation-check" ||
				req.url === "/internal/auth/revocation-status-check"
			) {
				res.writeHead(allowRevoke ? 200 : 409)
				res.end(
					JSON.stringify({
						allowed: allowRevoke,
						epoch: 7,
						accountId,
						credentialDigest,
					}),
				)
				return
			}
			if (req.url === "/internal/auth/release") {
				res.end('{"released":true}')
				return
			}
			if (req.url === "/internal/auth/admit") {
				res.end(
					JSON.stringify({
						allowed: !frozen,
						epoch: 7,
						phase: frozen ? "COPIED" : "E_ACTIVE",
						leaseId: randomUUID(),
					}),
				)
				return
			}
			res.writeHead(409)
			res.end('{"allowed":false}')
		})
		authority.listen(0, "127.0.0.1")
		await once(authority, "listening")
		const address = authority.address()
		if (address === null || typeof address === "string")
			throw new Error("Expected TCP")
		const host = await BrowserHost.start({
			publicOrigin: "https://client.example.com",
			authCompatibility: {
				sessionCookie: "__Host-e-session",
				loginCookie: "__Host-e-login",
				providerId: "kai",
				callbackPath: "/auth/callback",
			},
			execution: {
				origin: `http://127.0.0.1:${address.port}`,
				token: Redacted.make(token),
				backend: "openbot",
			},
		})
		const pool = new Pool({ connectionString: host.databaseUrl })
		try {
			const alice = await host.login("alice")
			const cookie =
				"__Host-e-session=" + encodeURIComponent(Redacted.value(alice.session))
			accountId = alice.identity.userId
			credentialDigest = createHmac("sha256", token)
				.update(
					Redacted.value(alice.session).slice(
						0,
						Redacted.value(alice.session).lastIndexOf("."),
					),
				)
				.digest("hex")
			const call = (
				path: string,
				headers: Record<string, string>,
				body: object = {},
			) =>
				fetch(host.address + path, {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body: JSON.stringify(body),
				})
			const privateHeaders = { authorization: "Bearer " + token, cookie }
			frozen = true
			assert.equal(
				(await fetch(host.address + "/auth/session", { headers: { cookie } }))
					.status,
				503,
			)
			assert.equal(
				(await call("/internal/auth/session", { cookie })).status,
				401,
			)
			for (const value of [
				"",
				"__Host-e-session=invalid",
				"__Host-e-session=" +
					encodeURIComponent(Redacted.value(alice.session) + "forged"),
			]) {
				const result = await call("/internal/auth/session", {
					...privateHeaders,
					cookie: value,
					"x-user-id": alice.identity.userId,
				})
				assert.equal(result.status, 200)
				assert.equal((await result.json()).accountId, null)
			}
			const before = (
				await pool.query(
					"SELECT * FROM openbot_auth_session WHERE user_id=$1",
					[alice.identity.userId],
				)
			).rows
			const valid = await call("/internal/auth/session", privateHeaders)
			assert.equal(valid.status, 200)
			assert.equal((await valid.json()).accountId, alice.identity.userId)
			assert.deepEqual(
				(
					await pool.query(
						"SELECT * FROM openbot_auth_session WHERE user_id=$1",
						[alice.identity.userId],
					)
				).rows,
				before,
			)
			await pool.query(
				"UPDATE openbot_auth_session SET expires_at='2020-01-01' WHERE user_id=$1",
				[alice.identity.userId],
			)
			assert.equal(
				(await (await call("/internal/auth/session", privateHeaders)).json())
					.accountId,
				null,
			)
			assert.equal(
				(
					await pool.query(
						"SELECT count(*)::int AS n FROM openbot_auth_session WHERE user_id=$1",
						[alice.identity.userId],
					)
				).rows[0].n,
				1,
			)
			await pool.query(
				"UPDATE openbot_auth_session SET expires_at='2099-01-01' WHERE user_id=$1",
				[alice.identity.userId],
			)
			assert.equal(
				(
					await call("/internal/auth/revoke", privateHeaders, {
						epoch: 7,
						leaseId: "invalid",
					})
				).status,
				503,
			)
			allowRevoke = true
			assert.equal(
				(
					await call(
						"/internal/auth/revoke",
						{ ...privateHeaders, cookie: "__Host-e-session=forged" },
						{ epoch: 7, leaseId: "verified-durable-lease" },
					)
				).status,
				503,
			)
			const revoked = await call("/internal/auth/revoke", privateHeaders, {
				epoch: 7,
				leaseId: "verified-durable-lease",
			})
			assert.equal(revoked.status, 204)
			// Reconcile a receipt whose first deletion failed before committing.
			await pool.query(
				"INSERT INTO openbot_auth_session(id,user_id,token,expires_at,created_at,updated_at) VALUES($1,$2,$3,'2099-01-01',now(),now())",
				[before[0].id, alice.identity.userId, before[0].token],
			)
			assert.deepEqual(
				await (
					await call(
						"/internal/auth/revocation-status",
						{ authorization: "Bearer " + token },
						{ epoch: 7, leaseId: "verified-durable-lease" },
					)
				).json(),
				{ revoked: false },
			)
			assert.deepEqual(
				await (
					await call(
						"/internal/auth/revocation-status",
						{ authorization: "Bearer " + token },
						{ epoch: 7, leaseId: "verified-durable-lease", retry: true },
					)
				).json(),
				{ revoked: true },
			)
			assert.ok(
				revoked.headers
					.getSetCookie()
					.some(
						(value) =>
							value.startsWith("__Host-e-session=") &&
							value.includes("Max-Age=0"),
					),
			)
			assert.equal(
				(
					await pool.query(
						"SELECT count(*)::int AS n FROM openbot_auth_session WHERE user_id=$1",
						[alice.identity.userId],
					)
				).rows[0].n,
				0,
			)
		} finally {
			await pool.end()
			await host.close()
			authority.closeAllConnections()
			await new Promise<void>((resolve, reject) =>
				authority.close((error) =>
					error === undefined ? resolve() : reject(error),
				),
			)
		}
	},
)
