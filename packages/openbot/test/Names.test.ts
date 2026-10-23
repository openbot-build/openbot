import assert from "node:assert/strict"
import { test } from "node:test"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie, withToken } from "./Caller.ts"

test(
	"Bot names and Session titles lose outer spaces, and a Session can have no title",
	{ timeout: 60000 },
	async () => {
		const publicOrigin = "https://names.example.com"
		const host = await BrowserHost.start({ publicOrigin })
		try {
			const alice = await host.login("alice")
			await host.defaultBot(alice.session)
			const account = withCookie({ address: host.address, publicOrigin })
			const keyed = withToken(host.address)

			const bot = await account(alice.session, "/v1/bots", "POST", {
				name: "  Writer  ",
				role: "Writes text",
				instructions: "Write short text.",
			})
			assert.equal(bot.status, 201, await bot.clone().text())
			const created = await bot.json()
			assert.equal(created.name, "Writer")
			const botPath = "/v1/bots/" + created.id
			assert.equal(
				(
					await account(alice.session, botPath, "PATCH", {
						expected: created.revision,
						name: "   ",
					})
				).status,
				400,
			)
			assert.equal(
				(
					await account(alice.session, botPath, "PATCH", {
						expected: created.revision,
						name: "x".repeat(101),
					})
				).status,
				400,
			)
			const renamed = await account(alice.session, botPath, "PATCH", {
				expected: created.revision,
				name: " Editor ",
			})
			assert.equal(renamed.status, 200, await renamed.clone().text())
			assert.equal((await renamed.json()).name, "Editor")

			// A Session without a title has no title field.
			const untitled = await account(alice.session, "/v1/sessions", "POST", {})
			assert.equal(untitled.status, 201, await untitled.clone().text())
			const first = await untitled.json()
			assert.equal("title" in first.session.metadata, false)
			assert.equal(
				(await account(alice.session, "/v1/sessions", "POST", { title: "" }))
					.status,
				400,
			)

			// API keys rename Sessions in the same way as the session cookie.
			const token = await account(alice.session, "/v1/user/tokens", "POST", {
				name: "Names",
			})
			const { secret } = await token.json()
			const sessionPath = "/v1/sessions/" + first.session.id
			const titled = await keyed(secret, sessionPath, "PATCH", {
				expected: first.session.revision,
				title: "  Plan  ",
			})
			assert.equal(titled.status, 200, await titled.clone().text())
			const second = await titled.json()
			assert.equal(second.session.metadata.title, "Plan")

			// A Fork without a title keeps the title of its source.
			const fork = await account(
				alice.session,
				sessionPath + "/fork",
				"POST",
				{},
			)
			assert.equal(fork.status, 201, await fork.clone().text())
			assert.equal((await fork.json()).session.metadata.title, "Plan")

			const cleared = await account(alice.session, sessionPath, "PATCH", {
				expected: second.session.revision,
				title: null,
			})
			assert.equal(cleared.status, 200, await cleared.clone().text())
			const third = await cleared.json()
			assert.equal("title" in third.session.metadata, false)
			assert.equal(third.session.metadata.archived, false)
		} finally {
			await host.close()
		}
	},
)
