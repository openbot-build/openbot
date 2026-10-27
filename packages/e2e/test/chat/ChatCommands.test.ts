import {
	BrowserHost,
	Caller,
	Policies,
	Messages,
	Chats,
} from "@openbot-build/openbot/testing"
import { assert, layer } from "@effect/vitest"
import {
	ChatCommandReceipt,
	ChatView,
	ChatTodos,
	UserTokensApi,
} from "@openbot-build/api"
import { Authorization, BotId } from "@openbot-build/domain"
import { Array as Arr, Effect, HashSet } from "effect"

const publicOrigin = "https://chat-commands.example.com"
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"Chat writes need no member runtime and keep revisions and current rights",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const member = yield* host.login("chat-writer")
				const bot = BotId.make(yield* host.defaultBot(member.session))
				const ids = yield* host.run(
					Effect.forEach(
						Arr.range(1, 4),
						() => Chats.direct(member.identity, bot),
						{ concurrency: 4 },
					),
				)
				assert.strictEqual(HashSet.size(HashSet.fromIterable(ids)), 1)
				const chat = ids[0]!
				const address = yield* host.address
				const cookie = Caller.withCookie({ address, publicOrigin })
				const initial = yield* cookie(member.session, `/v1/chats/${chat}`).pipe(
					Effect.flatMap(Caller.json(ChatView)),
				)
				assert.strictEqual(initial.turn, null)
				const changed = yield* cookie(
					member.session,
					`/v1/chats/${chat}`,
					"PATCH",
					{
						expected: initial.chat.revision,
						mode: "plan",
					},
				).pipe(Effect.flatMap(Caller.json(ChatView)))
				assert.strictEqual(changed.chat.settings.mode, "plan")
				assert.strictEqual(changed.turn, null)
				assert.strictEqual(changed.executionId, null)
				assert.strictEqual(
					(yield* cookie(member.session, `/v1/chats/${chat}`, "PATCH", {
						expected: initial.chat.revision,
						mode: "build",
					})).status,
					409,
				)
				const items: ChatTodos["items"] = [
					{ id: "one", content: "Read the file.", status: "pending" },
				]
				const withTodos = yield* cookie(
					member.session,
					`/v1/chats/${chat}/todos`,
					"PUT",
					{
						revision: changed.chat.revision,
						items,
					},
				).pipe(Effect.flatMap(Caller.json(ChatView)))
				assert.strictEqual(withTodos.chat.settings.mode, "plan")
				assert.deepStrictEqual(
					yield* cookie(member.session, `/v1/chats/${chat}/todos`).pipe(
						Effect.flatMap(Caller.json(ChatTodos)),
					),
					{ items },
				)
				assert.strictEqual(
					(yield* cookie(member.session, `/v1/chats/${chat}/todos`, "PUT", {
						revision: changed.chat.revision,
						items: [],
					})).status,
					409,
				)
				const token = yield* cookie(member.session, "/v1/user/tokens", "POST", {
					name: "Read this Chat",
					policy: yield* Policies.json(function* (_) {
						yield* _.allow("read", Authorization.Chat, {
							when: ($) => $.eq("id", chat),
						})
					}),
				}).pipe(Effect.flatMap(Caller.json(UserTokensApi.CreatedToken, 201)))
				const keyed = Caller.withToken(address)
				assert.strictEqual(
					(yield* keyed(token.secret, `/v1/chats/${chat}`, "PATCH", {
						expected: withTodos.chat.revision,
						mode: "build",
					})).status,
					403,
				)
				yield* host.restart
				const after = Caller.withCookie({
					address: yield* host.address,
					publicOrigin,
				})
				const saved = yield* after(member.session, `/v1/chats/${chat}`).pipe(
					Effect.flatMap(Caller.json(ChatView)),
				)
				assert.deepStrictEqual(saved, withTodos)
				// Clearing a Chat model follows the Bot for each new Turn. The chosen
				// model stays on that Turn, so recovery cannot pick a different one.
				const reset = yield* after(
					member.session,
					`/v1/chats/${chat}`,
					"PATCH",
					{
						expected: saved.chat.revision,
						model: null,
						mode: "build",
					},
				).pipe(Effect.flatMap(Caller.json(ChatView)))
				assert.strictEqual(reset.chat.settings.model, undefined)
				const send: Messages.Send = (path, method, payload) =>
					after(member.session, path, method, payload)
				const receipt = yield* Messages.message(send, bot, "Use the Bot model.")
				const result = yield* Messages.settled(send, receipt.chat)
				assert.strictEqual(result.turn?.status._tag, "Completed")
				assert.deepStrictEqual(
					result.turn?.settings.model,
					initial.chat.settings.model,
				)
				assert.strictEqual(result.chat.settings.model, undefined)
				const retry = yield* send(`/v1/bots/${bot}/messages`, "POST", {
					input: "Use the Bot model.",
					commandKey: receipt.commandKey,
				}).pipe(Effect.flatMap(Caller.json(ChatCommandReceipt, 202)))
				assert.deepStrictEqual(retry, receipt)
				assert.strictEqual(
					(yield* send(`/v1/bots/${bot}/messages`, "POST", {
						input: "Another input",
						commandKey: receipt.commandKey,
					})).status,
					409,
				)
				assert.deepStrictEqual(
					yield* Messages.settled(send, receipt.chat),
					result,
				)
			}),
	)
})
