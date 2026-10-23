// @effect-diagnostics strictEffectProvide:off
import * as BotFixture from "./BotFixture.ts"
import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Chat } from "@openbot-build/core"
import { Effect, Layer, Redacted, Stream } from "effect"
import { LanguageModel, Response } from "effect/ai"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as ManagedChats from "../src/chats/ManagedChats.ts"
import * as StoredChats from "../src/chats/StoredChats.ts"
import * as Db from "../src/database/Database.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"

const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}

test(
	"another server ends a running Turn whose server stopped saying that it runs, and then starts the input that waits",
	{ timeout: 60000 },
	async () => {
		const database = await PostgresTest.start()
		const layer = DatabasePostgres.layer({
			databaseUrl: Redacted.make(database.url),
		}).pipe(Layer.provide(NodeServices.layer))
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* DatabasePostgres.migrate
						// The first server runs a Turn that never ends, as if it hangs and then dies.
						const stuck = yield* LanguageModel.make({
							generateText: () => Effect.never,
							streamText: () => Stream.never,
						})
						const first = yield* ManagedChats.make().pipe(
							Effect.provideService(LanguageModel.LanguageModel, stuck),
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
						const second = yield* ManagedChats.make().pipe(
							Effect.provideService(LanguageModel.LanguageModel, quick),
						)

						const created = yield* first.create(BotFixture.direct())
						const chat = created.chat.id
						const started = yield* first.deliver(chat, {
							input: "hello",
							author: ChatHost.authorOf("test-user"),
						})
						assert.equal(started.delivery, "started")
						// Another person speaks while the Turn runs, so the input waits.
						const queued = yield* first.deliver(chat, {
							input: "me too",
							author: ChatHost.authorOf("other-user"),
						})
						assert.equal(queued.delivery, "queued")

						// The running Turn says that it runs, so the sweep leaves it alone.
						const db = yield* Db.make
						const now = Date.now()
						const fresh = yield* StoredChats.needingSweep(db, now - 120_000)
						assert.deepEqual(
							fresh.map((row) => row.id),
							[],
						)
						// The first server stops saying that it runs.
						const sql = yield* PgClient.PgClient
						yield* sql`update openbot_chats set runner_seen_at = 0 where id = ${chat}`
						const stale = yield* StoredChats.needingSweep(db, now - 120_000)
						assert.deepEqual(
							stale.map((row) => row.id),
							[chat],
						)
						assert.equal(Chat.currentTurn(stale[0]!.ref)?.id, started.turn)

						// The second server ends the Turn and starts the waiting input.
						yield* second.closeStale(chat, started.turn!)
						let view = yield* second.get(chat)
						for (
							let tries = 0;
							tries < 200 &&
							(view.turn?.id === started.turn || view.status !== "Completed");
							tries++
						) {
							yield* Effect.sleep(25)
							view = yield* second.get(chat)
						}
						assert.equal(view.status, "Completed")
						assert.equal(view.turn?.author, ChatHost.authorOf("other-user"))
						assert.match(JSON.stringify(view.response?.output), /Recovered\./)
						const turns = yield* second.turns(chat, {})
						assert.deepEqual(
							turns.items.map((turn) => turn.status._tag),
							["Interrupted", "Completed"],
						)
					}),
				).pipe(Effect.provide(layer)),
			)
		} finally {
			await database.close()
		}
	},
)
