// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest"
import {
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	Redacted,
	Schema,
	Stream,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { SqlClient } from "effect/sql"
import {
	ChatStoreRepository,
	Item,
	Plugin,
	PluginComposition,
	Store,
} from "@openbot-build/core"
import { LanguageModel, Prompt, Response } from "effect/ai"
import { getTableName, is, Table } from "drizzle-orm"
import * as Migration from "../src/database/Migrations.ts"
import * as AuthSchema from "../src/database/AuthSchema.ts"
import * as DatabaseSchema from "../src/database/Schema.ts"
import * as StoredChats from "../src/chats/StoredChats.ts"
import { chatHostId, chatHostStore } from "../src/chats/ChatHost.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"
import * as ManagedChats from "../src/chats/ManagedChats.ts"
import * as BackendLayers from "../src/app/BackendLayers.ts"
import { Backend } from "../src/app/Backend.ts"
import * as Db from "../src/database/Database.ts"
import * as BotFixture from "./BotFixture.ts"

/** The tables that the Drizzle schema defines. The migrations must make the same tables. */
const definedTables = [
	...Object.values(DatabaseSchema),
	...Object.values(AuthSchema),
]
	.flatMap((value) => (is(value, Table) ? [getTableName(value)] : []))
	.sort()

/** The OpenBot data of a Chat. The table of Chats copies its Bot and kind into columns. */
const { kind, chain } = BotFixture.direct()
const host = { [chatHostId]: { bot: BotFixture.bot.id, kind, chain } }
assert.strictEqual(chatHostId, "@openbot-build/openbot/chat-host")
/** Starts a new PostgreSQL. It stops when the test ends. */
const startDatabase = Effect.acquireRelease(
	Effect.promise(() => PostgresTest.start()),
	(database) => Effect.promise(() => database.close()),
)
/** The OpenBot database layer for a PostgreSQL address. */
const databaseLayer = (url: string) =>
	DatabasePostgres.layer({ databaseUrl: Redacted.make(url) }).pipe(
		Layer.provide(NodeServices.layer),
	)
/** An Item as JSON, the way the store keeps it. */
const itemJson = (id: string, seq: number) =>
	Schema.decodeSync(Schema.Json)(
		Schema.encodeSync(Item.Record)({
			id: Item.Id.make(id),
			seq: Item.Seq.make(seq),
			content: Prompt.make(id),
		}),
	)

it.live(
	"PostgreSQL saves the revision and the new Items of each Chat in one step within each namespace",
	() =>
		Effect.gen(function* () {
			const database = yield* startDatabase
			yield* Effect.gen(function* () {
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
						StoredChats.save(db, "alice", {
							chat: root.chat.id,
							ref: { ...ref, revision: 2, seq: 1 },
							revision: 2,
							expected: 1,
							items: [
								{ seq: 1, id: name, turn: null, value: itemJson(name, 1) },
							],
						}).pipe(Effect.exit),
					{ concurrency: 2 },
				)
				assert.strictEqual(competing.filter(Exit.isSuccess).length, 1)
				assert.strictEqual(competing.filter(Exit.isFailure).length, 1)
				const winner = competing[0]?._tag === "Success" ? "first" : "second"
				assert.deepStrictEqual(
					(yield* store.items(root.chat.id)).map((item) => item.id),
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
					(yield* sql<{
						id: string
						seq: number
					}>`SELECT id, seq FROM openbot_chat_items ORDER BY seq`).map(
						(row) => [row.id, Number(row.seq)],
					),
					[
						[winner, 1],
						["input", 2],
					],
				)
				const stale = yield* Effect.exit(
					store.modifyEffect({
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
					}),
				)
				assert.ok(Exit.isFailure(stale))
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
			}).pipe(
				// The Chat store closes before the database.
				Effect.scoped,
				Effect.provide(databaseLayer(database.url)),
			)
		}),
	{ timeout: 30000 },
)

it.live(
	"database initialization creates the required tables and can run twice",
	() =>
		Effect.gen(function* () {
			const database = yield* startDatabase
			yield* Effect.gen(function* () {
				const before = yield* Effect.exit(Migration.check)
				assert.ok(Exit.isFailure(before))
				yield* Migration.initialize
				yield* Migration.check
				yield* Migration.initialize
				const sql = yield* SqlClient.SqlClient
				const tables = (yield* sql<{
					tablename: string
				}>`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'`)
					.map((row) => row.tablename)
					.sort()
				assert.deepStrictEqual(tables, definedTables)
			}).pipe(Effect.provide(databaseLayer(database.url)))
		}),
	{ timeout: 30000 },
)

it.live(
	"OpenBot builds resident user middleware once and releases it with the host Scope",
	() =>
		Effect.gen(function* () {
			class ResidentConfiguration extends Context.Service<
				ResidentConfiguration,
				number
			>()("@openbot-build/openbot/test/Storage.test/ResidentConfiguration") {}
			const database = yield* startDatabase
			const model = Layer.effect(
				LanguageModel.LanguageModel,
				LanguageModel.make({
					generateText: () => Effect.succeed([]),
					streamText: () =>
						Stream.make(
							Response.makePart("finish", {
								reason: "stop",
								usage: Response.Usage.make({
									inputTokens: { total: 1 },
									outputTokens: { total: 1 },
								}),
							}),
						),
				}),
			)
			// One set of services serves all the steps below, like one running server.
			const services = databaseLayer(database.url).pipe(
				Layer.provideMerge(model),
				Layer.provideMerge(Layer.succeed(ResidentConfiguration, 7)),
			)
			let builds = 0
			let active = 0
			let turns = 0
			const plugin = Plugin.make({ id: Plugin.Id.make("openbot-resident") })(
				() =>
					Effect.gen(function* () {
						assert.strictEqual(yield* ResidentConfiguration, 7)
						builds++
						const ready = yield* Deferred.make<void>()
						yield* Effect.forkScoped(
							Effect.acquireRelease(
								Effect.sync(() => {
									active++
								}),
								() =>
									Effect.sync(() => {
										active--
									}),
							).pipe(
								Effect.andThen(Deferred.succeed(ready, undefined)),
								Effect.andThen(Effect.never),
							),
						)
						yield* Deferred.await(ready)
						return (next, options) =>
							Stream.unwrap(
								Effect.sync(() => {
									assert.strictEqual(active, 1)
									turns++
									return next(options)
								}),
							)
					}),
			)
			yield* Effect.gen(function* () {
				yield* Migration.initialize
				yield* Effect.scoped(
					Effect.gen(function* () {
						const instance = yield* ManagedChats.make({
							runtime: { plugin },
						})
						assert.strictEqual(builds, 1)
						assert.strictEqual(active, 1)
						const initial = yield* instance.create(BotFixture.direct())
						yield* instance.runtime.execute({
							chat: initial.chat.id,
							input: "one",
						})
						yield* instance.runtime
							.stream({ chat: initial.chat.id, input: "two" })
							.pipe(Stream.runDrain)
						assert.strictEqual(builds, 1)
						assert.strictEqual(turns, 2)
						assert.strictEqual(active, 1)
					}),
				)
				assert.strictEqual(active, 0)
				const failing = PluginComposition.merge(
					plugin,
					Plugin.make({ id: Plugin.Id.make("failed") })(() =>
						Effect.fail("construction-failed" as const),
					),
				)
				yield* Effect.scoped(
					Effect.gen(function* () {
						const backend = yield* Backend
						yield* Effect.forEach([2, 3], (expectedBuilds) =>
							Effect.gen(function* () {
								const result = yield* backend
									.get("failed-construction")
									.pipe(Effect.result)
								assert.strictEqual(result._tag, "Failure")
								assert.strictEqual(builds, expectedBuilds)
								assert.strictEqual(active, 0)
							}),
						)
					}),
				).pipe(
					Effect.provide(BackendLayers.layer({ runtime: { plugin: failing } })),
				)
			}).pipe(Effect.provide(services))
		}),
	{ timeout: 30000 },
)
