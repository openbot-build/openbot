import { assert, layer } from "@effect/vitest"
import { ChatView, ChatCommandReceipt, ExecutionsApi } from "@openbot-build/api"
import { Item, Turn } from "@openbot-build/core"
import { Effect, Schema, Array as Arr } from "effect"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import * as Messages from "./Messages.ts"
import * as Db from "../src/database/Database.ts"
import * as StoredChats from "../src/chats/StoredChats.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"

const ChatItemsPage = Schema.Struct({
	items: Schema.Array(Item.Record),
	next: Schema.NullOr(Item.Seq),
})
const ChatTurnsPage = Schema.Struct({
	items: Schema.Array(Turn.Record),
	next: Schema.NullOr(Turn.Id),
})
const publicOrigin = "https://conversations.example.com"
layer(BrowserHost.layerPlatform, {
	excludeTestServices: true,
	timeout: "90 seconds",
})((it) => {
	it.effect(
		"conversation branches keep committed history and command receipts stay private",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const call = Caller.withCookie({
					address: yield* host.address,
					publicOrigin,
				})
				const alice = yield* host.login("alice")
				const bob = yield* host.login("bob")
				const send: Messages.Send = (path, method, payload) =>
					call(alice.session, path, method, payload)
				const botId = yield* host.defaultBot(alice.session)
				const create = (requestId: string) =>
					send("/v1/chats", "POST", { botId, requestId }).pipe(
						Effect.flatMap(Caller.json(ChatView, 201)),
					)
				const first = yield* create("first")
				const second = yield* create("second")
				const concurrent = yield* Effect.all(
					[create("concurrent"), create("concurrent")],
					{ concurrency: 2 },
				)
				assert.strictEqual(concurrent[0].chat.id, concurrent[1].chat.id)
				assert.notStrictEqual(first.chat.id, second.chat.id)
				assert.strictEqual(first.chat.bot, second.chat.bot)
				assert.deepStrictEqual(first.chat.memory, { read: true, write: true })
				assert.strictEqual((yield* create("first")).chat.id, first.chat.id)
				assert.strictEqual(
					(yield* send("/v1/chats", "POST", {
						botId,
						requestId: "first",
						memory: { read: false, write: false },
					})).status,
					409,
				)
				const path = "/v1/chats/" + first.chat.id
				const receipt = yield* send(path + "/messages", "POST", {
					commandKey: "saved-message",
					input: "Remember the color blue.",
				}).pipe(Effect.flatMap(Caller.json(ChatCommandReceipt, 202)))
				const settled = yield* Messages.settled(send, first.chat.id)
				const recovered = yield* send(
					"/v1/execution-commands/saved-message",
					"GET",
				).pipe(
					Effect.flatMap(
						Caller.json(Schema.NullOr(ExecutionsApi.Execution.Receipt)),
					),
				)
				assert.strictEqual(recovered?.executionId, receipt.executionId)
				assert.strictEqual(receipt.inputItems?.length, 1)
				assert.deepStrictEqual(recovered?.inputItems, receipt.inputItems)
				const privateReceipt = yield* call(
					bob.session,
					"/v1/execution-commands/saved-message",
				).pipe(
					Effect.flatMap(
						Caller.json(Schema.NullOr(ExecutionsApi.Execution.Receipt)),
					),
				)
				assert.isNull(privateReceipt)
				assert.notStrictEqual((yield* call(bob.session, path)).status, 200)
				const before = yield* host.toolCalls
				const fork = yield* send(path + "/forks", "POST", {
					expected: settled.chat.revision,
					requestId: "fork",
					reason: "fork",
				}).pipe(Effect.flatMap(Caller.json(ChatView, 201)))
				assert.strictEqual(fork.chat.branchOf?.chat, first.chat.id)
				assert.strictEqual(fork.chat.bot, first.chat.bot)
				const originalItems = yield* send(path + "/items", "GET").pipe(
					Effect.flatMap(Caller.json(ChatItemsPage)),
				)
				const forkItems = yield* send(
					"/v1/chats/" + fork.chat.id + "/items",
					"GET",
				).pipe(Effect.flatMap(Caller.json(ChatItemsPage)))
				assert.deepStrictEqual(
					Arr.map(forkItems.items, (item) => item.id),
					Arr.map(originalItems.items, (item) => item.id),
				)
				assert.strictEqual(yield* host.toolCalls, before)
				const originalTurns = yield* send(path + "/turns", "GET").pipe(
					Effect.flatMap(Caller.json(ChatTurnsPage)),
				)
				const forkTurns = yield* send(
					"/v1/chats/" + fork.chat.id + "/turns",
					"GET",
				).pipe(Effect.flatMap(Caller.json(ChatTurnsPage)))
				assert.deepStrictEqual(
					Arr.map(forkTurns.items, (turn) => turn.id),
					Arr.map(originalTurns.items, (turn) => turn.id),
				)
				const changed = yield* send(path, "PATCH", {
					expected: settled.chat.revision,
					memory: { read: false, write: false },
				}).pipe(Effect.flatMap(Caller.json(ChatView)))
				assert.deepStrictEqual(changed.chat.memory, {
					read: false,
					write: false,
				})
				assert.strictEqual(
					(yield* send(path + "/forks", "POST", {
						expected: settled.chat.revision,
						requestId: "stale",
						reason: "fork",
					})).status,
					409,
				)
				// A transient override is committed with this input, not with the Chat default.
				yield* send(path + "/messages", "POST", {
					commandKey: "memory-override",
					input: "Hello.",
					memory: { read: true, write: false },
				}).pipe(Effect.flatMap(Caller.json(ChatCommandReceipt, 202)))
				const after = yield* Messages.settled(send, first.chat.id)
				assert.deepStrictEqual(after.chat.memory, { read: false, write: false })
				const turns = yield* host.run(
					Effect.flatMap(Db.make, (db) =>
						StoredChats.persistence(db, ownerKey(alice.identity))
							.turns(first.chat.id, {})
							.pipe(
								Effect.flatMap(
									Schema.decodeUnknownEffect(Schema.Array(Turn.Record)),
								),
							),
					),
				)
				assert.deepStrictEqual(
					Arr.last(turns)._tag === "Some"
						? turns[turns.length - 1]?.metadata?.["memory"]
						: undefined,
					{ read: true, write: false },
				)
				const unchanged = yield* send(
					"/v1/chats/" + second.chat.id + "/items",
					"GET",
				).pipe(Effect.flatMap(Caller.json(ChatItemsPage)))
				assert.strictEqual(unchanged.items.length, 0)
			}),
	)
})
