import assert from "node:assert/strict"
import { test } from "node:test"
import { AuthApi } from "@openbot-build/api"
import { Redacted } from "effect"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie, withToken } from "./Caller.ts"

test(
	"User tokens authenticate headless clients, stay with their member and stop working when revoked",
	{ timeout: 60000 },
	async (t) => {
		const publicOrigin = "https://api.example.com"
		const host = await BrowserHost.start({ publicOrigin })
		try {
			const alice = await host.login("alice")
			const bob = await host.login("bob")
			await host.defaultAgent(alice.session)
			const account = withCookie({ address: host.address, publicOrigin })
			const keyed = withToken(host.address)

			const root = await fetch(host.address + "/")
			assert.equal(root.status, 200)
			assert.equal((await root.json()).tokens, "/v1/user/tokens")

			const created = await account(alice.session, "/v1/user/tokens", "POST", {
				name: "  CI pipeline  ",
			})
			assert.equal(created.status, 201, await created.clone().text())
			assert.equal(created.headers.get("cache-control"), "no-store")
			const { token, secret } = await created.json()
			assert.match(secret, /^obut_[A-Za-z0-9_-]{43}$/)
			assert.equal(token.name, "CI pipeline")
			assert.ok(secret.startsWith(token.prefix))
			assert.equal(token.expiresAt, null)
			assert.equal(token.lastUsedAt, null)

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
			// Members of one organization still do not see each other's Sessions.
			assert.equal(
				(
					await account(
						bob.session,
						"/v1/sessions/" + encodeURIComponent(session.session.id),
					)
				).status,
				404,
			)

			const verified = await (await keyed(secret, "/v1/tokens/verify")).json()
			assert.equal(verified.caller.kind, "user_token")
			assert.equal(verified.caller.userId, alice.identity.userId)
			assert.equal(
				verified.caller.organizationId,
				alice.identity.organizationId,
			)
			assert.equal(verified.token.id, token.id)
			assert.equal(
				(await (await account(alice.session, "/v1/tokens/verify")).json())
					.token,
				null,
			)

			const tokens = await (
				await account(alice.session, "/v1/user/tokens")
			).json()
			assert.equal(tokens.items.length, 1)
			assert.notEqual(tokens.items[0].lastUsedAt, null)
			assert.equal(JSON.stringify(tokens).includes(secret), false)
			assert.deepEqual(
				(await (await account(bob.session, "/v1/user/tokens")).json()).items,
				[],
			)

			// A token made without policies cannot manage tokens.
			const denied = await keyed(secret, "/v1/user/tokens", "POST", {
				name: "Minted",
			})
			assert.equal(denied.status, 403)
			assert.equal((await denied.json())._tag, "PermissionDenied")
			assert.equal((await keyed(secret, "/v1/user/tokens")).status, 403)

			const foreignOrigin = await fetch(host.address + "/v1/user/tokens", {
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
				(await account(alice.session, "/v1/user/tokens", "POST", { name: " " }))
					.status,
				400,
			)
			const foreignPolicy = await account(
				alice.session,
				"/v1/user/tokens",
				"POST",
				{
					name: "Other organization",
					policies: [
						{
							effect: "allow",
							permissionGroups: ["sessions.read"],
							resources: ["openbot.org.someone-else"],
						},
					],
				},
			)
			assert.equal(foreignPolicy.status, 400)
			assert.equal((await foreignPolicy.json())._tag, "TokenPolicyInvalid")

			assert.equal(
				(
					await account(
						bob.session,
						"/v1/user/tokens/" + encodeURIComponent(token.id),
						"DELETE",
					)
				).status,
				404,
			)
			assert.equal(
				(
					await account(
						alice.session,
						"/v1/user/tokens/" + encodeURIComponent(token.id),
						"DELETE",
					)
				).status,
				204,
			)
			assert.equal((await keyed(secret, "/v1/sessions")).status, 401)
			assert.equal((await keyed("obut_unknown", "/v1/sessions")).status, 401)

			const expiring = await (
				await account(alice.session, "/v1/user/tokens", "POST", {
					name: "Short-lived",
					expiresInDays: 1,
				})
			).json()
			assert.notEqual(expiring.token.expiresAt, null)
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
						await account(alice.session, "/v1/user/tokens", "POST", {
							name: "Token " + index,
						})
					).status,
					201,
				)
			const limited = await account(alice.session, "/v1/user/tokens", "POST", {
				name: "One too many",
			})
			assert.equal(limited.status, 409)
			assert.deepEqual(await limited.json(), {
				_tag: "TokenLimitReached",
				limit: 25,
			})
		} finally {
			await host.close()
		}
	},
)

test(
	"Token policies can only narrow what the member can do",
	{ timeout: 60000 },
	async () => {
		const publicOrigin = "https://api.example.com"
		const host = await BrowserHost.start({ publicOrigin })
		try {
			const alice = await host.login("alice")
			const account = withCookie({ address: host.address, publicOrigin })
			const keyed = withToken(host.address)
			const make = async (policies: unknown) => {
				const response = await account(
					alice.session,
					"/v1/user/tokens",
					"POST",
					{
						name: "Scoped",
						policies,
					},
				)
				assert.equal(response.status, 201, await response.clone().text())
				return (await response.json()).secret as string
			}

			const readOnly = await make([
				{
					effect: "allow",
					permissionGroups: ["sessions.read"],
					resources: ["openbot.org.{org}.user.{self}"],
				},
			])
			assert.equal((await keyed(readOnly, "/v1/sessions")).status, 200)
			const write = await keyed(readOnly, "/v1/sessions", "POST", {
				title: "Not allowed",
			})
			assert.equal(write.status, 403)
			assert.equal((await write.json()).permission, "sessions.write")

			// A deny wins over an allow in the same token.
			const denied = await make([
				{
					effect: "allow",
					permissionGroups: ["sessions.read", "sessions.write"],
					resources: ["openbot.org.{org}"],
				},
				{
					effect: "deny",
					permissionGroups: ["sessions.write"],
					resources: ["openbot.org.{org}.user.{self}.session"],
				},
			])
			assert.equal((await keyed(denied, "/v1/sessions")).status, 200)
			assert.equal(
				(await keyed(denied, "/v1/sessions", "POST", { title: "No" })).status,
				403,
			)

			// A token never gets more than its member. Alice is a Super Administrator,
			// but she loses organization.write here, and so does her broad token.
			const broad = await make([
				{
					effect: "allow",
					permissionGroups: ["organization.read", "organization.write"],
					resources: ["openbot.org.{org}"],
				},
			])
			assert.equal(
				(await keyed(broad, "/v1/organization", "PATCH", { name: "Acme" }))
					.status,
				200,
			)
			const bob = await host.login("bob")
			const promoted = await account(
				alice.session,
				"/v1/organization/members/" + encodeURIComponent(bob.identity.userId),
				"PATCH",
				{ roles: ["super_administrator"] },
			)
			assert.equal(promoted.status, 200, await promoted.clone().text())
			const narrowed = await account(
				bob.session,
				"/v1/organization/members/" + encodeURIComponent(alice.identity.userId),
				"PATCH",
				{ roles: ["member"] },
			)
			assert.equal(narrowed.status, 200, await narrowed.clone().text())
			assert.equal(
				(await keyed(broad, "/v1/organization", "PATCH", { name: "Acme 2" }))
					.status,
				403,
			)
		} finally {
			await host.close()
		}
	},
)
