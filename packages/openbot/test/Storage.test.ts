import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Effect,
	Exit,
	Layer,
	Option,
	Order,
	Record as Rec,
	Redacted,
	Schema,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { SqlClient } from "effect/sql"
import { ChatStoreRepository, Item, Store } from "@openbot-build/core"
import { Prompt } from "effect/ai"
import { getTableName, is, Table } from "drizzle-orm"
import * as Migration from "../src/database/Migrations.ts"
import * as AuthSchema from "../src/database/AuthSchema.ts"
import * as DatabaseSchema from "../src/database/Schema.ts"
import * as StoredChats from "../src/chats/StoredChats.ts"
import { chatHostId, chatHostStore } from "../src/chats/ChatHost.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"
import * as Db from "../src/database/Database.ts"
import * as BotFixture from "./BotFixture.ts"

/** The tables that the Drizzle schema defines. The migrations must make the same tables. */
const definedTables = Arr.sort(
	Arr.flatMap(
		[...Rec.values(DatabaseSchema), ...Rec.values(AuthSchema)],
		(value) => (is(value, Table) ? [getTableName(value)] : []),
	),
	Order.String,
)

/** The OpenBot data of a Chat. The table of Chats copies its Bot and kind into columns. */
const { kind, chain } = BotFixture.direct()
const host = { [chatHostId]: { bot: BotFixture.bot.id, kind, chain } }
assert.strictEqual(chatHostId, "@openbot-build/openbot/chat-host")
/**
 * The OpenBot database layer over a new PostgreSQL. Each test gets its own
 * layer, so each test starts with an empty database.
 */
const database = Layer.unwrap(
	Effect.map(PostgresTest.start, (database) =>
		DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
	),
).pipe(Layer.provideMerge(NodeServices.layer))
/** An Item as JSON, the way the store keeps it. */
const itemJson = (id: string, seq: number) =>
	Schema.encodeEffect(Item.Record)({
		id: Item.Id.make(id),
		seq: Item.Seq.make(seq),
		content: Prompt.make(id),
	}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)))

it.layer(database, { excludeTestServices: true })((it) => {
	it.effect(
		"PostgreSQL saves the revision and the new Items of each Chat in one step within each namespace",
		() =>
			Effect.gen(function* () {
				yield* Migration.initialize
				yield* Migration.check
				const db = yield* Db.make,
					definition = yield* Store.define({
						// The literal key keeps the type of the state exact.
						stores: { "@openbot-build/openbot/chat-host": chatHostStore },
						schemaVersion: "chat/1",
					})
				const store = yield* ChatStoreRepository.make({
					definition,
					persistence: StoredChats.persistence(db, "alice"),
				})
				const sql = yield* SqlClient.SqlClient
				const root = yield* store.create({ business: host })
				// Each namespace has one direct Chat with each Bot.
				const second = yield* store.create({ business: host }).pipe(Effect.flip)
				assert.strictEqual(second.reason, "reference-conflict")
				const other = yield* store.create({
					business: {
						[chatHostId]: { bot: "bot_other", kind, chain },
					},
				})
				const settings = (yield* store.modifyEffect({
					chat: root.chat.id,
					update: (current) =>
						Effect.succeed([
							undefined,
							Option.some({
								chat: {
									settings: { ...current.chat.settings, mode: "plan" },
								},
							}),
						] as const),
				})).view
				assert.strictEqual(settings.chat.settings.mode, "plan")
				assert.strictEqual(settings.chat.revision, 1)
				// Each Chat has its own revision.
				assert.strictEqual((yield* store.read(other.chat.id)).chat.revision, 0)
				// Another namespace does not see the Chat.
				assert.ok(
					Option.isNone(
						yield* StoredChats.persistence(db, "bob").get(root.chat.id),
					),
				)
				// Two saves of the same revision: only one is kept, with its Item.
				const stored = yield* StoredChats.persistence(db, "alice").get(
					root.chat.id,
				)
				assert.ok(Option.isSome(stored))
				const ref = stored.value.ref as {
					readonly [key: string]: Schema.Json
				}
				const competing = yield* Effect.forEach(
					["first", "second"],
					(name) =>
						Effect.flatMap(itemJson(name, 1), (value) =>
							StoredChats.save(db, "alice", {
								chat: root.chat.id,
								ref: { ...ref, revision: 2, seq: 1 },
								revision: 2,
								expected: 1,
								items: [{ seq: 1, id: name, turn: null, value }],
							}).pipe(Effect.exit),
						),
					{ concurrency: 2 },
				)
				assert.strictEqual(Arr.filter(competing, Exit.isSuccess).length, 1)
				assert.deepStrictEqual(
					Arr.map(
						Arr.filterMap(competing, (exit) => Exit.findError(exit)),
						(error) => error.reason,
					),
					["reference-conflict"],
				)
				const winner = competing[0]?._tag === "Success" ? "first" : "second"
				assert.deepStrictEqual(
					Arr.map(yield* store.items(root.chat.id), (item) => item.id),
					[winner],
				)
				const current = yield* store.read(root.chat.id)
				assert.strictEqual(current.chat.revision, 2)
				// A change adds Items to the end of the log. It never writes the old Items again.
				const changed = (yield* store.modifyEffect({
					chat: root.chat.id,
					update: (view) => {
						const value: typeof view.state = {
							...view.state,
							conversation: {
								...view.state.conversation,
								context: {
									_tag: "Prompt",
									prompt: Prompt.make("saved"),
								},
							},
						}
						return Effect.succeed([
							undefined,
							Option.some({
								append: [
									{
										id: Item.Id.make("input"),
										content: Prompt.make("saved"),
									},
								],
								value,
							}),
						] as const)
					},
				})).view
				assert.strictEqual(changed.chat.revision, 3)
				assert.strictEqual(changed.chat.seq, 2)
				assert.deepStrictEqual(
					Arr.map(
						yield* sql<{
							id: string
							seq: number
						}>`SELECT id, seq FROM openbot_chat_items ORDER BY seq`,
						(row) => [row.id, Number(row.seq)],
					),
					[
						[winner, 1],
						["input", 2],
					],
				)
				const stale = yield* store
					.modifyEffect({
						chat: root.chat.id,
						expectedRevision: settings.chat.revision,
						update: (view) =>
							Effect.succeed([
								undefined,
								Option.some({
									append: [
										{
											id: Item.Id.make("stale"),
											content: Prompt.make("stale"),
										},
									],
									chat: {
										settings: { ...view.chat.settings, mode: "build" },
									},
								}),
							] as const),
					})
					.pipe(Effect.flip)
				assert.ok(
					stale._tag === "ChatStoreError" &&
						stale.reason === "reference-conflict",
				)
				assert.deepStrictEqual(yield* store.read(root.chat.id), changed)
				assert.strictEqual(
					(yield* sql`SELECT id FROM openbot_chat_items`).length,
					2,
				)
				const fresh = yield* ChatStoreRepository.make({
					definition,
					persistence: StoredChats.persistence(db, "alice"),
				})
				assert.deepStrictEqual(yield* fresh.read(root.chat.id), changed)
				assert.deepStrictEqual(
					yield* fresh.items(root.chat.id),
					yield* store.items(root.chat.id),
				)
				// Removing a Chat removes its Items. The other Chat stays.
				yield* store.remove(changed.chat)
				assert.ok(Option.isNone(yield* fresh.get(root.chat.id)))
				assert.strictEqual(
					(yield* sql`SELECT id FROM openbot_chat_items`).length,
					0,
				)
				assert.deepStrictEqual(yield* fresh.read(other.chat.id), other)
			}),
	)
})

it.layer(database, { excludeTestServices: true })((it) => {
	it.effect(
		"database initialization creates the required tables and can run twice",
		() =>
			Effect.gen(function* () {
				const before = yield* Effect.flip(Migration.check)
				assert.strictEqual(before.reason, "storage-failed")
				yield* Migration.initialize
				yield* Migration.check
				yield* Migration.initialize
				const sql = yield* SqlClient.SqlClient
				const tables = Arr.sort(
					Arr.map(
						yield* sql<{
							tablename: string
						}>`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'`,
						(row) => row.tablename,
					),
					Order.String,
				)
				assert.deepStrictEqual(tables, definedTables)
			}),
	)
})
