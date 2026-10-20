import assert from "node:assert/strict"
import { test } from "node:test"
import { Redacted } from "effect"
import { AuthApi } from "@openbot-build/platform-api"
import * as BrowserHost from "./BrowserHost.ts"

test(
	"API keys authenticate headless clients, stay in their own account and stop working when revoked",
	{ timeout: 60000 },
	async (t) => {
		const publicOrigin = "https://api.example.com"
		const host = await BrowserHost.start({ publicOrigin })
		try {
			const alice = await host.login("alice")
			const bob = await host.login("bob")
			const account = (
				credential: Redacted.Redacted<string>,
				path: string,
				method = "GET",
				payload?: unknown,
			) =>
				fetch(host.address + path, {
					method,
					headers: {
						cookie:
							AuthApi.SessionCookie +
							"=" +
							encodeURIComponent(Redacted.value(credential)),
						origin: publicOrigin,
						...(payload === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
				})
			const keyed = (
				secret: string,
				path: string,
				method = "GET",
				payload?: unknown,
			) =>
				fetch(host.address + path, {
					method,
					headers: {
						authorization: "Bearer " + secret,
						...(payload === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
				})

			const root = await fetch(host.address + "/")
			assert.equal(root.status, 200)
			assert.equal((await root.json()).apiKeys, "/auth/api-keys")

			const created = await account(alice.session, "/auth/api-keys", "POST", {
				name: "  CI pipeline  ",
			})
			assert.equal(created.status, 201)
			assert.equal(created.headers.get("cache-control"), "no-store")
			const { key, secret } = await created.json()
			assert.match(secret, /^obk_[A-Za-z0-9_-]{43}$/)
			assert.equal(key.name, "CI pipeline")
			assert.ok(secret.startsWith(key.prefix))
			assert.equal(key.expiresAt, null)
			assert.equal(key.lastUsedAt, null)

			const writes = await keyed(secret, "/v1/sessions", "POST", {
				title: "Headless work",
			})
			assert.equal(writes.status, 201, await writes.clone().text())
			const session = await writes.json()
			const listed = await keyed(secret, "/v1/sessions")
			assert.equal(listed.status, 200)
			assert.ok(
				JSON.stringify(await listed.json()).includes(session.session.id),
			)
			assert.equal(
				(
					await account(
						bob.session,
						"/v1/sessions/" + encodeURIComponent(session.session.id),
					)
				).status,
				404,
			)

			const keys = await (await account(alice.session, "/auth/api-keys")).json()
			assert.equal(keys.keys.length, 1)
			assert.notEqual(keys.keys[0].lastUsedAt, null)
			assert.equal(JSON.stringify(keys).includes(secret), false)
			assert.deepEqual(
				(await (await account(bob.session, "/auth/api-keys")).json()).keys,
				[],
			)

			assert.equal((await keyed(secret, "/auth/api-keys")).status, 401)
			assert.equal(
				(await keyed(secret, "/auth/api-keys", "POST", { name: "Minted" }))
					.status,
				401,
			)
			const foreignOrigin = await fetch(host.address + "/auth/api-keys", {
				method: "POST",
				headers: {
					cookie:
						AuthApi.SessionCookie +
						"=" +
						encodeURIComponent(Redacted.value(alice.session)),
					origin: "https://attacker.example",
					"content-type": "application/json",
				},
				body: JSON.stringify({ name: "Cross-site" }),
			})
			assert.equal(foreignOrigin.status, 403)
			assert.equal(
				(await account(alice.session, "/auth/api-keys", "POST", { name: " " }))
					.status,
				400,
			)

			assert.equal(
				(
					await account(
						bob.session,
						"/auth/api-keys/" + encodeURIComponent(key.id),
						"DELETE",
					)
				).status,
				404,
			)
			assert.equal(
				(
					await account(
						alice.session,
						"/auth/api-keys/" + encodeURIComponent(key.id),
						"DELETE",
					)
				).status,
				204,
			)
			assert.equal((await keyed(secret, "/v1/sessions")).status, 401)
			assert.equal((await keyed("obk_unknown", "/v1/sessions")).status, 401)

			const expiring = await (
				await account(alice.session, "/auth/api-keys", "POST", {
					name: "Short-lived",
					expiresInDays: 1,
				})
			).json()
			assert.notEqual(expiring.key.expiresAt, null)
			assert.equal((await keyed(expiring.secret, "/v1/sessions")).status, 200)
			t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 * 86400000 })
			try {
				assert.equal((await keyed(expiring.secret, "/v1/sessions")).status, 401)
			} finally {
				t.mock.timers.reset()
			}

			for (let index = 1; index < 25; index++)
				assert.equal(
					(
						await account(alice.session, "/auth/api-keys", "POST", {
							name: "Key " + index,
						})
					).status,
					201,
				)
			const limited = await account(alice.session, "/auth/api-keys", "POST", {
				name: "One too many",
			})
			assert.equal(limited.status, 409)
			assert.deepEqual(await limited.json(), {
				_tag: "ApiKeyLimitReached",
				limit: 25,
			})
		} finally {
			await host.close()
		}
	},
)
