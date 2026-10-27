import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	Order,
	Record as Rec,
	Redacted,
	Ref,
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
import * as HostTools from "../src/chats/HostTools.ts"
import * as ModelRegistry from "../src/models/ModelRegistry.ts"
import * as ChatsFixture from "./ChatsFixture.ts"
import { Backend } from "../src/app/Backend.ts"
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

class ResidentConfiguration extends Context.Service<
	ResidentConfiguration,
	number
>()("@openbot-build/openbot/test/Storage.test/ResidentConfiguration") {}

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

/** One set of services serves all the steps of a test, like one running server. */
const residentServices = ChatsFixture.services.pipe(
	Layer.provideMerge(database),
	Layer.provideMerge(model),
	Layer.provideMerge(Layer.succeed(ResidentConfiguration, 7)),
)

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

/**
 * A host plugin with resources that live as long as its runtime. It counts
 * its builds, its open resources and its Turns. A failing one also has a part
 * whose build fails.
 */
const residentTools = (
	counters: {
		readonly builds: Ref.Ref<number>
		readonly active: Ref.Ref<number>
		readonly turns: Ref.Ref<number>
	},
	options: { readonly fail: boolean },
) =>
	Layer.effect(
		HostTools.HostTools,
		Effect.map(ResidentConfiguration, (configuration) => {
			const plugin = Plugin.make({ id: Plugin.Id.make("openbot-resident") })(
				() =>
					Effect.gen(function* () {
						// The host gives its services to the plugin when it builds the layer.
						assert.strictEqual(configuration, 7)
						yield* Ref.update(counters.builds, (n) => n + 1)
						const ready = yield* Deferred.make<void>()
						yield* Effect.forkScoped(
							Effect.acquireRelease(
								Ref.update(counters.active, (n) => n + 1),
								() => Ref.update(counters.active, (n) => n - 1),
							).pipe(
								Effect.andThen(Deferred.succeed(ready, undefined)),
								Effect.andThen(Effect.never),
							),
						)
						yield* Deferred.await(ready)
						return (next, options) =>
							Stream.unwrap(
								Effect.gen(function* () {
									assert.strictEqual(yield* Ref.get(counters.active), 1)
									yield* Ref.update(counters.turns, (n) => n + 1)
									return next(options)
								}),
							)
					}),
			)
			const failed = Plugin.make({ id: Plugin.Id.make("failed") })(() =>
				Effect.die("construction-failed"),
			)
			return HostTools.HostTools.of({
				plugin: options.fail ? PluginComposition.merge(plugin, failed) : plugin,
			})
		}),
	)

it.layer(residentServices, { excludeTestServices: true })((it) => {
	it.effect(
		"OpenBot builds resident host middleware once and releases it with the host Scope",
		() =>
			Effect.gen(function* () {
				const counters = {
					builds: yield* Ref.make(0),
					active: yield* Ref.make(0),
					turns: yield* Ref.make(0),
				}
				const { builds, active, turns } = counters
				yield* Migration.initialize
				const answers = yield* LanguageModel.LanguageModel
				yield* Effect.scoped(
					Effect.gen(function* () {
						const instance = yield* ManagedChats.make(
							ChatsFixture.models(answers),
						)
						assert.strictEqual(yield* Ref.get(builds), 1)
						assert.strictEqual(yield* Ref.get(active), 1)
						const initial = yield* instance.create(BotFixture.direct())
						yield* instance.runtime.execute({
							chat: initial.chat.id,
							input: "one",
						})
						yield* instance.runtime
							.stream({ chat: initial.chat.id, input: "two" })
							.pipe(Stream.runDrain)
						assert.strictEqual(yield* Ref.get(builds), 1)
						assert.strictEqual(yield* Ref.get(turns), 2)
						assert.strictEqual(yield* Ref.get(active), 1)
					}),
				).pipe(Effect.provide(residentTools(counters, { fail: false })))
				assert.strictEqual(yield* Ref.get(active), 0)
				yield* Effect.scoped(
					Effect.gen(function* () {
						const backend = yield* Backend
						yield* Effect.forEach([2, 3], (expectedBuilds) =>
							Effect.gen(function* () {
								const result = yield* backend
									.get("failed-construction", {
										kind: "member",
										userId: "test-user",
										organizationId: "test-organization",
									})
									.pipe(Effect.exit)
								assert.ok(Exit.isFailure(result))
								assert.strictEqual(yield* Ref.get(builds), expectedBuilds)
								assert.strictEqual(yield* Ref.get(active), 0)
							}),
						)
					}),
				).pipe(
					Effect.provide(
						BackendLayers.layer().pipe(
							Layer.provide(residentTools(counters, { fail: true })),
							// The build fails before the runtime reads the model registry.
							Layer.provide(Layer.mock(ModelRegistry.ModelRegistry, {})),
						),
					),
				)
			}),
	)
})
