import { assert, it, vi } from "@effect/vitest"
import { AuthApi, Authorization } from "@openbot-build/api"
import { Redacted } from "effect"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie, withToken } from "./Caller.ts"
import { message } from "./Messages.ts"
import * as Policies from "./Policies.ts"

it(
	"User tokens authenticate headless clients, stay with their member and stop working when revoked",
	{ timeout: 60000 },
	async () => {
		const publicOrigin = "https://api.example.com"
		const host = await BrowserHost.start({ publicOrigin })
		try {
			const alice = await host.login("alice")
			const bob = await host.login("bob")
			const bot = await host.defaultBot(alice.session)
			const account = withCookie({ address: host.address, publicOrigin })
			const keyed = withToken(host.address)

			const root = await fetch(host.address + "/")
			assert.strictEqual(root.status, 200)
			assert.strictEqual((await root.json()).tokens, "/v1/user/tokens")

			const created = await account(alice.session, "/v1/user/tokens", "POST", {
				name: "  CI pipeline  ",
			})
			assert.strictEqual(created.status, 201, await created.clone().text())
			assert.strictEqual(created.headers.get("cache-control"), "no-store")
			const { token, secret } = await created.json()
			assert.match(secret, /^obut_[A-Za-z0-9_-]{43}$/)
			assert.strictEqual(token.name, "CI pipeline")
			assert.ok(secret.startsWith(token.prefix))
			assert.strictEqual(token.expiresAt, null)
			assert.strictEqual(token.lastUsedAt, null)

			const receipt = await message(
				(path, method, payload) => keyed(secret, path, method, payload),
				bot,
				"Headless work",
			)
			const listed = await keyed(secret, "/v1/chats")
			assert.strictEqual(listed.status, 200)
			assert.ok(JSON.stringify(await listed.json()).includes(receipt.chat))
			// Members of one organization still do not see each other's Chats.
			assert.strictEqual(
				(
					await account(
						bob.session,
						"/v1/chats/" + encodeURIComponent(receipt.chat),
					)
				).status,
				404,
			)

			const verified = await (await keyed(secret, "/v1/tokens/verify")).json()
			assert.strictEqual(verified.caller.kind, "user_token")
			assert.strictEqual(verified.caller.userId, alice.identity.userId)
			assert.strictEqual(
				verified.caller.organizationId,
				alice.identity.organizationId,
			)
			assert.strictEqual(verified.token.id, token.id)
			assert.strictEqual(
				(await (await account(alice.session, "/v1/tokens/verify")).json())
					.token,
				null,
			)

			const tokens = await (
				await account(alice.session, "/v1/user/tokens")
			).json()
			assert.strictEqual(tokens.items.length, 1)
			assert.notStrictEqual(tokens.items[0].lastUsedAt, null)
			assert.strictEqual(JSON.stringify(tokens).includes(secret), false)
			assert.deepStrictEqual(
				(await (await account(bob.session, "/v1/user/tokens")).json()).items,
				[],
			)

			// A token made without a policy cannot manage tokens.
			const denied = await keyed(secret, "/v1/user/tokens", "POST", {
				name: "Minted",
			})
			assert.strictEqual(denied.status, 403)
			assert.strictEqual((await denied.json())._tag, "Forbidden")
			assert.strictEqual((await keyed(secret, "/v1/user/tokens")).status, 403)

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
			assert.strictEqual(foreignOrigin.status, 403)
			assert.strictEqual(
				(await account(alice.session, "/v1/user/tokens", "POST", { name: " " }))
					.status,
				400,
			)
			// A token policy that names another organization gives nothing, because
			// every check also needs the policy of the member in its own organization.
			const foreignPolicy = await account(
				alice.session,
				"/v1/user/tokens",
				"POST",
				{
					name: "Other organization",
					policy: Policies.json(function* (_) {
						yield* _.allow("read", Authorization.Chat, {
							when: ($) => $.under("org", "someone-else"),
						})
					}),
				},
			)
			assert.strictEqual(foreignPolicy.status, 201)
			const foreign = await foreignPolicy.json()
			assert.strictEqual((await keyed(foreign.secret, "/v1/chats")).status, 403)
			assert.strictEqual(
				(
					await account(
						alice.session,
						"/v1/user/tokens/" + encodeURIComponent(foreign.token.id),
						"DELETE",
					)
				).status,
				204,
			)

			assert.strictEqual(
				(
					await account(
						bob.session,
						"/v1/user/tokens/" + encodeURIComponent(token.id),
						"DELETE",
					)
				).status,
				404,
			)
			assert.strictEqual(
				(
					await account(
						alice.session,
						"/v1/user/tokens/" + encodeURIComponent(token.id),
						"DELETE",
					)
				).status,
				204,
			)
			assert.strictEqual((await keyed(secret, "/v1/chats")).status, 401)
			assert.strictEqual((await keyed("obut_unknown", "/v1/chats")).status, 401)

			const expiring = await (
				await account(alice.session, "/v1/user/tokens", "POST", {
					name: "Short-lived",
					expiresInDays: 1,
				})
			).json()
			assert.notStrictEqual(expiring.token.expiresAt, null)
			assert.strictEqual(
				(await keyed(expiring.secret, "/v1/chats")).status,
				200,
			)
			// Only Date is fake, so the server and fetch still use real timers.
			vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 86400000 })
			try {
				assert.strictEqual(
					(await keyed(expiring.secret, "/v1/chats")).status,
					401,
				)
			} finally {
				vi.useRealTimers()
			}

			for (let index = 1; index < 25; index++)
				assert.strictEqual(
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
			assert.strictEqual(limited.status, 409)
			assert.deepStrictEqual(await limited.json(), {
				_tag: "TokenLimitReached",
				limit: 25,
			})
		} finally {
			await host.close()
		}
	},
)

it(
	"Token policies can only narrow what the member can do",
	{ timeout: 60000 },
	async () => {
		const publicOrigin = "https://api.example.com"
		const host = await BrowserHost.start({ publicOrigin })
		try {
			const alice = await host.login("alice")
			const account = withCookie({ address: host.address, publicOrigin })
			const keyed = withToken(host.address)
			const make = async (policy: unknown) => {
				const response = await account(
					alice.session,
					"/v1/user/tokens",
					"POST",
					{
						name: "Scoped",
						policy,
					},
				)
				assert.strictEqual(response.status, 201, await response.clone().text())
				return (await response.json()).secret as string
			}

			const bot = await host.defaultBot(alice.session)
			const receipt = await message(
				(path, method, payload) =>
					account(alice.session, path, method, payload),
				bot,
				"Hello",
			)
			const chatPath = "/v1/chats/" + encodeURIComponent(receipt.chat)
			const messages = "/v1/bots/" + encodeURIComponent(bot) + "/messages"

			const readOnly = await make(
				Policies.json(function* (_) {
					yield* _.allow("read", Authorization.Chat, Policies.own)
				}),
			)
			assert.strictEqual((await keyed(readOnly, "/v1/chats")).status, 200)
			const read = await keyed(readOnly, chatPath)
			assert.strictEqual(read.status, 200, await read.clone().text())
			const { chat } = await read.json()
			const write = await keyed(readOnly, chatPath, "PATCH", {
				expected: chat.revision,
				mode: "plan",
			})
			assert.strictEqual(write.status, 403)
			assert.deepInclude(await write.json(), { action: "write", kind: "Chat" })
			assert.strictEqual(
				(await keyed(readOnly, messages, "POST", { input: "Not allowed" }))
					.status,
				403,
			)

			// A deny wins over an allow in the same token.
			const allowChats = function* (_: Policies.Builder) {
				yield* _.allow(
					["run", "read", "write"],
					Authorization.Chat,
					Policies.inOrganization,
				)
				yield* _.allow(
					["read", "delegate"],
					Authorization.Bot,
					Policies.inOrganization,
				)
			}
			const full = await make(Policies.json(allowChats))
			const sent = await keyed(full, messages, "POST", { input: "Allowed" })
			assert.strictEqual(sent.status, 202, await sent.clone().text())
			const denied = await make(
				Policies.json(function* (_) {
					yield* allowChats(_)
					yield* _.deny("write", Authorization.Chat, Policies.own)
				}),
			)
			assert.strictEqual((await keyed(denied, "/v1/chats")).status, 200)
			const refused = await keyed(denied, messages, "POST", { input: "No" })
			assert.strictEqual(refused.status, 403)
			assert.deepInclude(await refused.json(), {
				action: "write",
				kind: "Chat",
			})

			// A token never gets more than its member. Alice is a Super Administrator,
			// but she loses organization.write here, and so does her broad token.
			const broad = await make(
				Policies.json(function* (_) {
					yield* _.allow(
						["read", "write"],
						Authorization.Organization,
						Policies.inOrganization,
					)
				}),
			)
			assert.strictEqual(
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
			assert.strictEqual(promoted.status, 200, await promoted.clone().text())
			const narrowed = await account(
				bob.session,
				"/v1/organization/members/" + encodeURIComponent(alice.identity.userId),
				"PATCH",
				{ roles: ["member"] },
			)
			assert.strictEqual(narrowed.status, 200, await narrowed.clone().text())
			assert.strictEqual(
				(await keyed(broad, "/v1/organization", "PATCH", { name: "Acme 2" }))
					.status,
				403,
			)
		} finally {
			await host.close()
		}
	},
)
