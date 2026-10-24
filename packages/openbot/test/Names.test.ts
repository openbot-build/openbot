import { assert, it } from "@effect/vitest"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie, withToken } from "./Caller.ts"
import { message, view } from "./Messages.ts"

it(
	"Bot names lose outer spaces, and a direct Chat has no title",
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
			assert.strictEqual(bot.status, 201, await bot.clone().text())
			const created = await bot.json()
			assert.strictEqual(created.name, "Writer")
			const botPath = "/v1/bots/" + created.id
			assert.strictEqual(
				(
					await account(alice.session, botPath, "PATCH", {
						expected: created.revision,
						name: "   ",
					})
				).status,
				400,
			)
			assert.strictEqual(
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
			assert.strictEqual(renamed.status, 200, await renamed.clone().text())
			const second = await renamed.json()
			assert.strictEqual(second.name, "Editor")

			// API keys rename Bots in the same way as the session cookie.
			const token = await account(alice.session, "/v1/user/tokens", "POST", {
				name: "Names",
			})
			const { secret } = await token.json()
			const keyedRename = await keyed(secret, botPath, "PATCH", {
				expected: second.revision,
				name: "  Planner  ",
			})
			assert.strictEqual(
				keyedRename.status,
				200,
				await keyedRename.clone().text(),
			)
			assert.strictEqual((await keyedRename.json()).name, "Planner")

			// Only a channel Chat has a title: the name of its chat on the platform.
			const send = (
				path: string,
				method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
				payload?: unknown,
			) => keyed(secret, path, method, payload)
			const receipt = await message(send, created.id, "Hello")
			const current = await view(send, receipt.chat)
			assert.strictEqual(current.chat.kind, "direct")
			assert.strictEqual("title" in current.chat, false)
		} finally {
			await host.close()
		}
	},
)
