import {
	BrowserHost,
	Caller,
	Policies,
	Chats,
} from "@openbot-build/openbot/testing"
import { assert, layer } from "@effect/vitest"
import { Item } from "@openbot-build/core"
import { Authorization } from "@openbot-build/domain"
import { ChatSummary, ChatView, UserTokensApi } from "@openbot-build/api"
import { Array as Arr, Effect, Order, Schema } from "effect"

const publicOrigin = "https://chat-reads.example.com"
const Items = Schema.Struct({
	items: Schema.Array(Item.Record),
	next: Schema.NullOr(Item.Seq),
})
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"Chat reads use saved data and list only the records allowed to a token",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const member = yield* host.login("chat-reader")
				const other = yield* host.login("other-reader")
				const ids = yield* host.run(Chats.seedReadChats(member.identity))
				const first = ids[0]!
				const second = ids[1]!
				const address = yield* host.address
				const cookie = Caller.withCookie({ address, publicOrigin })
				const token = yield* cookie(member.session, "/v1/user/tokens", "POST", {
					name: "Read one Chat",
					policy: yield* Policies.json(function* (_) {
						yield* _.allow("read", Authorization.Chat, {
							when: ($) => $.eq("id", first),
						})
					}),
				}).pipe(Effect.flatMap(Caller.json(UserTokensApi.CreatedToken, 201)))
				const keyed = Caller.withToken(address)
				const list = yield* keyed(token.secret, "/v1/chats").pipe(
					Effect.flatMap(Caller.json(Schema.Array(ChatSummary))),
				)
				assert.deepStrictEqual(
					Arr.map(list, (entry) => entry.chat.id),
					[first],
				)
				assert.strictEqual(list[0]?.executionId, null)
				const all = yield* cookie(member.session, "/v1/chats").pipe(
					Effect.flatMap(Caller.json(Schema.Array(ChatSummary))),
				)
				assert.deepStrictEqual(
					Arr.sort(
						Arr.map(all, (entry) => entry.chat.id),
						Order.String,
					),
					[first, second],
				)
				const current = yield* keyed(token.secret, `/v1/chats/${first}`).pipe(
					Effect.flatMap(Caller.json(ChatView)),
				)
				assert.strictEqual(current.status, "Idle")
				assert.strictEqual(current.executionId, null)
				assert.strictEqual("activity" in current, false)
				const newest = yield* keyed(
					token.secret,
					`/v1/chats/${first}/items?limit=2`,
				).pipe(Effect.flatMap(Caller.json(Items)))
				assert.deepStrictEqual(
					Arr.map(newest.items, (item) => item.id),
					["first-3", "first-2"],
				)
				const older = yield* keyed(
					token.secret,
					`/v1/chats/${first}/items?limit=2&before=${newest.next}`,
				).pipe(Effect.flatMap(Caller.json(Items)))
				assert.deepStrictEqual(
					Arr.map(older.items, (item) => item.id),
					["first-1"],
				)
				assert.strictEqual(older.next, null)
				assert.strictEqual(
					(yield* keyed(token.secret, `/v1/chats/${second}/items`)).status,
					403,
				)
				assert.strictEqual(
					(yield* cookie(other.session, `/v1/chats/${first}/items`)).status,
					404,
				)
				const empty = yield* keyed(token.secret, "/v1/chats?kind=task").pipe(
					Effect.flatMap(Caller.json(Schema.Array(ChatSummary))),
				)
				assert.deepStrictEqual(empty, [])
				// No Bot or model was made. Reading these Chats cannot start model work.
				yield* host.restart
				const after = Caller.withCookie({
					address: yield* host.address,
					publicOrigin,
				})
				const saved = yield* after(member.session, `/v1/chats/${first}`).pipe(
					Effect.flatMap(Caller.json(ChatView)),
				)
				assert.deepStrictEqual(saved, current)
				yield* after(
					member.session,
					`/v1/user/tokens/${token.token.id}`,
					"DELETE",
				)
				assert.strictEqual(
					(yield* Caller.withToken(yield* host.address)(
						token.secret,
						"/v1/chats",
					)).status,
					401,
				)
			}),
	)
})
