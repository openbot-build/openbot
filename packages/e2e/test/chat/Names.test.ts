import { BrowserHost, Caller, Messages } from "@openbot-build/openbot/testing"
import { assert, layer } from "@effect/vitest"
import { BotsApi, UserTokensApi } from "@openbot-build/api"
import { Effect, String as Str } from "effect"
const { message, view } = Messages
type Send = Messages.Send

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"Bot names lose outer spaces, and a direct Chat has no title",
		() =>
			Effect.gen(function* () {
				const publicOrigin = "https://names.example.com"
				const host = yield* BrowserHost.start({ publicOrigin })
				const alice = yield* host.login("alice")
				yield* host.defaultBot(alice.session)
				const address = yield* host.address
				const account = Caller.withCookie({ address, publicOrigin })
				const keyed = Caller.withToken(address)

				const created = yield* Effect.flatMap(
					account(alice.session, "/v1/bots", "POST", {
						name: "  Writer  ",
						role: "Writes text",
						instructions: "Write short text.",
					}),
					Caller.json(BotsApi.Bot, 201),
				)
				assert.strictEqual(created.name, "Writer")
				const botPath = "/v1/bots/" + created.id
				assert.strictEqual(
					(yield* account(alice.session, botPath, "PATCH", {
						expected: created.revision,
						name: "   ",
					})).status,
					400,
				)
				assert.strictEqual(
					(yield* account(alice.session, botPath, "PATCH", {
						expected: created.revision,
						name: Str.repeat(101)("x"),
					})).status,
					400,
				)
				const second = yield* Effect.flatMap(
					account(alice.session, botPath, "PATCH", {
						expected: created.revision,
						name: " Editor ",
					}),
					Caller.json(BotsApi.Bot, 200),
				)
				assert.strictEqual(second.name, "Editor")

				// API keys rename Bots in the same way as the session cookie.
				const { secret } = yield* Effect.flatMap(
					account(alice.session, "/v1/user/tokens", "POST", {
						name: "Names",
					}),
					Caller.json(UserTokensApi.CreatedToken),
				)
				const keyedRename = yield* Effect.flatMap(
					keyed(secret, botPath, "PATCH", {
						expected: second.revision,
						name: "  Planner  ",
					}),
					Caller.json(BotsApi.Bot, 200),
				)
				assert.strictEqual(keyedRename.name, "Planner")

				// Only a channel Chat has a title: the name of its chat on the platform.
				const send: Send = (path, method, payload) =>
					keyed(secret, path, method, payload)
				const receipt = yield* message(send, created.id, "Hello")
				const current = yield* view(send, receipt.chat)
				assert.strictEqual(current.chat.kind, "direct")
				assert.strictEqual("title" in current.chat, false)
			}),
		60000,
	)
})
