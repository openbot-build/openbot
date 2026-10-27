import * as BotFixture from "./BotFixture.ts"
import { assert, layer } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { Chat } from "@openbot-build/core"
import { Array as Arr, Clock, Effect, Schema, Stream } from "effect"
import { LanguageModel, Response } from "effect/ai"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as ManagedChats from "../src/chats/ManagedChats.ts"
import * as HostTools from "../src/chats/HostTools.ts"
import * as ChatsFixture from "./ChatsFixture.ts"
import * as StoredChats from "../src/chats/StoredChats.ts"
import * as Db from "../src/database/Database.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import { untilTrue } from "./Wait.ts"

const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

// The database is a real server, so the test runs on the real clock.
layer(ChatsFixture.layerDatabase, {
	excludeTestServices: true,
	timeout: "60 seconds",
})((it) => {
	it.effect(
		"another server ends a running Turn whose server stopped saying that it runs, and then starts the input that waits",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				// The first server runs a Turn that never ends, as if it hangs and then dies.
				const stuck = yield* LanguageModel.make({
					generateText: () => Effect.never,
					streamText: () => Stream.never,
				})
				const first = yield* ManagedChats.make(ChatsFixture.models(stuck)).pipe(
					Effect.provide(HostTools.none),
				)
				// The second server answers at once.
				const quick = yield* LanguageModel.make({
					generateText: () => Effect.succeed([]),
					streamText: () =>
						Stream.make(
							Response.makePart("text-start", { id: "answer" }),
							Response.makePart("text-delta", {
								id: "answer",
								delta: "Recovered.",
							}),
							Response.makePart("text-end", { id: "answer" }),
							Response.makePart("finish", { reason: "stop", usage }),
						),
				})
				const second = yield* ManagedChats.make(
					ChatsFixture.models(quick),
				).pipe(Effect.provide(HostTools.none))

				const created = yield* first.create(BotFixture.direct())
				const chat = created.chat.id
				const started = yield* first.deliver(chat, {
					input: "hello",
					author: ChatHost.authorOf("test-user"),
				})
				assert.strictEqual(started.delivery, "started")
				// Another person speaks while the Turn runs, so the input waits.
				const queued = yield* first.deliver(chat, {
					input: "me too",
					author: ChatHost.authorOf("other-user"),
				})
				assert.strictEqual(queued.delivery, "queued")

				// The running Turn says that it runs, so the sweep leaves it alone.
				const db = yield* Db.make
				const now = yield* Clock.currentTimeMillis
				const fresh = yield* StoredChats.needingSweep(db, now - 120_000)
				assert.deepStrictEqual(
					Arr.map(fresh, (row) => row.id),
					[],
				)
				// The first server stops saying that it runs.
				const sql = yield* PgClient.PgClient
				yield* sql`update openbot_chats set runner_seen_at = 0 where id = ${chat}`
				const stale = yield* StoredChats.needingSweep(db, now - 120_000)
				assert.deepStrictEqual(
					Arr.map(stale, (row) => row.id),
					[chat],
				)
				assert.strictEqual(Chat.currentTurn(stale[0]!.ref)?.id, started.turn)

				// The second server ends the Turn and starts the waiting input.
				yield* second.closeStale(chat, started.turn!)
				const view = yield* untilTrue(
					"the second server completes the input that waits",
					second.get(chat),
					(current) =>
						current.turn?.id !== started.turn && current.status === "Completed",
					{ times: 200 },
				)
				assert.strictEqual(view.status, "Completed")
				assert.strictEqual(view.turn?.author, ChatHost.authorOf("other-user"))
				assert.match(yield* encodeJson(view.response?.output), /Recovered\./)
				const turns = yield* second.turns(chat, {})
				assert.deepStrictEqual(
					Arr.map(turns.items, (turn) => turn.status._tag),
					["Interrupted", "Completed"],
				)
			}),
		60000,
	)

	it.effect(
		"a stored Chat that does not decode does not stop the sweep of the other Chats",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const model = yield* LanguageModel.make({
					generateText: () => Effect.succeed([]),
					streamText: () => Stream.empty,
				})
				const chats = yield* ManagedChats.make(ChatsFixture.models(model)).pipe(
					Effect.provide(HostTools.none),
				)
				// A member has only one direct Chat with a Bot, so these are channel Chats.
				const input = { ...BotFixture.direct(), kind: "channel" as const }
				const good = (yield* chats.create(input)).chat.id
				const bad = (yield* chats.create(input)).chat.id
				// Both Chats have a running Turn whose server stopped saying that it runs.
				const sql = yield* PgClient.PgClient
				yield* sql`update openbot_chats set status = 'Running', runner_seen_at = 0 where id in (${good}, ${bad})`
				yield* sql`update openbot_chats set body = '{"broken":true}' where id = ${bad}`
				const db = yield* Db.make
				const now = yield* Clock.currentTimeMillis
				const swept = yield* StoredChats.needingSweep(db, now - 120_000)
				assert.deepStrictEqual(
					Arr.map(swept, (row) => row.id),
					[good],
				)
				yield* sql`delete from openbot_chats where id in (${good}, ${bad})`
			}),
		60000,
	)
})
