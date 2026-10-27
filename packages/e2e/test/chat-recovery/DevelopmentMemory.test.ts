import { assert, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { ChatView } from "@openbot-build/api"
import { Item, Turn } from "@openbot-build/core"
import {
	BrowserHost,
	Caller,
	DevelopmentTesting,
	Messages,
} from "@openbot-build/openbot/testing"

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"a development Chat survives a restart without replay or leaks between owners",
		() =>
			Effect.gen(function* () {
				const { model, hostTools } = yield* DevelopmentTesting.memoryModel
				const publicOrigin = "https://development-memory.example.com"
				const host = yield* BrowserHost.start({
					publicOrigin,
					model,
					hostTools,
				})
				const member = yield* host.login("first-owner")
				const bot = yield* host.defaultBot(member.session)
				const send: Messages.Send = (path, method, body) =>
					Effect.flatMap(host.address, (address) =>
						Caller.withCookie({ address, publicOrigin })(
							member.session,
							path,
							method,
							body,
						),
					)
				const { receipt, view: source } = yield* Messages.talk(
					send,
					bot,
					"Persist this conversation",
				)
				assert.strictEqual(source.status, "Completed")
				assert.strictEqual(source.turn?.id, receipt.turn)
				assert.match(
					yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
						source.response?.output,
					),
					/Development response: Persist this conversation/,
				)
				const read = Effect.gen(function* () {
					const items = yield* Caller.read(
						Schema.Struct({
							items: Schema.Array(Item.Record),
							next: Schema.NullOr(Item.Seq),
						}),
						send(`/v1/chats/${receipt.chat}/items`, "GET"),
					)
					const turns = yield* Caller.read(
						Schema.Struct({
							items: Schema.Array(ChatView.fields.turn.members[0]),
							next: Schema.NullOr(Turn.Id),
						}),
						send(`/v1/chats/${receipt.chat}/turns`, "GET"),
					)
					return { items, turns }
				})
				const saved = yield* read
				assert.ok(saved.items.items.length >= 2)
				assert.strictEqual(saved.turns.items.length, 1)
				yield* host.restart
				assert.deepStrictEqual(yield* Messages.view(send, receipt.chat), source)
				assert.deepStrictEqual(yield* read, saved)
				const other = yield* host.login("other-owner")
				const otherSend: Messages.Send = (path, method, body) =>
					Effect.flatMap(host.address, (address) =>
						Caller.withCookie({ address, publicOrigin })(
							other.session,
							path,
							method,
							body,
						),
					)
				assert.strictEqual(
					(yield* otherSend(`/v1/chats/${receipt.chat}`, "GET")).status,
					404,
				)
				assert.strictEqual(
					(yield* otherSend(`/v1/chats/${receipt.chat}/items`, "GET")).status,
					404,
				)
			}),
		60000,
	)
})
