// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import {
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	ManagedRuntime,
	Option,
	Redacted,
	Stream,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { SqlClient } from "effect/sql"
import {
	Item,
	Plugin,
	PluginComposition,
	SessionStoreRepository,
	Store,
} from "@openbot-build/core"
import { LanguageModel, Prompt, Response } from "effect/ai"
import { getTableName, is, Table } from "drizzle-orm"
import * as Migration from "../src/database/Migrations.ts"
import * as AuthSchema from "../src/database/AuthSchema.ts"
import * as DatabaseSchema from "../src/database/Schema.ts"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import * as StoredSessions from "../src/sessions/StoredSessions.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"
import * as ManagedSessions from "../src/sessions/ManagedSessions.ts"
import * as BackendLayers from "../src/app/BackendLayers.ts"
import { Backend } from "../src/app/Backend.ts"

/** The tables that the Drizzle schema defines. The migrations must make the same tables. */
const definedTables = [
	...Object.values(DatabaseSchema),
	...Object.values(AuthSchema),
]
	.flatMap((value) => (is(value, Table) ? [getTableName(value)] : []))
	.sort()
/** The tables of the durable execution of Workflow Runs. Effect defines them, not Drizzle. */
const clusterTables = [
	"locks",
	"messages",
	"migrations",
	"replies",
	"runner_migrations",
	"runners",
].map((name) => Migration.clusterPrefix + "_" + name)

test(
	"PostgreSQL saves independent Session revisions and immutable Timeline versions in one step within each namespace",
	{ timeout: 30000 },
	async () => {
		const database = await PostgresTest.start(),
			runtime = ManagedRuntime.make(
				DatabasePostgres.layer({
					databaseUrl: Redacted.make(database.url),
				}).pipe(Layer.provide(NodeServices.layer)),
			)
		try {
			await runtime.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* Migration.initialize
						yield* Migration.check
						const db = yield* makeWithDefaults(),
							definition = yield* Store.define({
								stores: {},
								schemaVersion: "timeline/1",
							})
						const store = yield* SessionStoreRepository.make({
							definition,
							persistence: StoredSessions.persistence(db, "alice"),
						})
						const root = yield* store.create({
							metadata: {},
						})
						const settings = yield* store.updateSettings({
							expected: root.session,
							settings: { ...root.session.settings, mode: "plan" },
						})
						assert.equal(settings.session.head, root.session.head)
						assert.equal(settings.session.revision, 1)
						assert.ok(
							Option.isNone(
								yield* StoredSessions.persistence(db, "bob").getRef(
									root.session.id,
								),
							),
						)
						const competing = yield* Effect.forEach(
							["first", "second"],
							(title) =>
								StoredSessions.save(db, "alice", {
									delta: {
										expected: settings.session,
										session: {
											...settings.session,
											revision: Session.Revision.make(
												settings.session.revision + 1,
											),
											metadata: { ...settings.session.metadata, title },
										},
										versions: [],
										messages: [],
									},
									response: Option.none(),
								}).pipe(Effect.exit),
							{ concurrency: 2 },
						)
						assert.equal(competing.filter(Exit.isSuccess).length, 1)
						assert.equal(competing.filter(Exit.isFailure).length, 1)
						const current = yield* store.read(root.session.id)
						const changed = (yield* store.modifyEffect({
							session: root.session.id,
							update: (view) =>
								Effect.succeed([
									undefined,
									Option.some({
										value: {
											...view.state.value,
											conversation: {
												...view.state.value.conversation,
												history: [
													{
														id: Item.Id.make("input"),
														content: Prompt.make("saved"),
													},
												],
												context: {
													_tag: "Prompt" as const,
													prompt: Prompt.make("saved"),
												},
											},
										},
									}),
								] as const),
						})).view
						assert.notEqual(changed.session.head, current.session.head)
						const sql = yield* SqlClient.SqlClient
						assert.equal(
							(yield* sql`SELECT id FROM openbot_timeline_versions`).length,
							2,
						)
						assert.equal(
							(yield* sql`SELECT id FROM openbot_timeline_contents`).length,
							1,
						)
						const fork = yield* store.fork({ source: changed.session.id })
						assert.equal(fork.session.head, changed.session.head)
						assert.equal(
							(yield* sql`SELECT id FROM openbot_timeline_versions`).length,
							2,
						)
						const stale = yield* Effect.exit(
							store.updateMetadata({
								expected: root.session,
								metadata: { ...root.session.metadata, title: "stale" },
							}),
						)
						assert.ok(Exit.isFailure(stale))
						assert.deepEqual(
							(yield* store.read(root.session.id)).state.value,
							changed.state.value,
						)
						const fresh = yield* SessionStoreRepository.make({
							definition,
							persistence: StoredSessions.persistence(db, "alice"),
						})
						assert.deepEqual(yield* fresh.read(root.session.id), changed)
						yield* store.remove(changed.session)
						assert.deepEqual(
							(yield* fresh.read(fork.session.id)).state.value,
							changed.state.value,
						)
					}),
				),
			)
		} finally {
			await runtime.dispose()
			await database.close()
		}
	},
)
import { Session } from "@openbot-build/core"

test(
	"database initialization creates the required tables and can run twice",
	{ timeout: 30000 },
	async () => {
		const database = await PostgresTest.start()
		const runtime = ManagedRuntime.make(
			DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }).pipe(
				Layer.provide(NodeServices.layer),
			),
		)
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
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
					assert.deepEqual(tables, [...definedTables, ...clusterTables].sort())
				}),
			)
		} finally {
			await runtime.dispose()
			await database.close()
		}
	},
)

test(
	"OpenBot builds resident user middleware once and releases it with the host Scope",
	{ timeout: 30000 },
	async () => {
		class ResidentConfiguration extends Context.Service<
			ResidentConfiguration,
			number
		>()("@openbot-build/openbot/test/Storage.test/ResidentConfiguration") {}
		const database = await PostgresTest.start()
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
		const runtime = ManagedRuntime.make(
			DatabasePostgres.layer({
				databaseUrl: Redacted.make(database.url),
			}).pipe(
				Layer.provide(NodeServices.layer),
				Layer.provideMerge(model),
				Layer.provideMerge(Layer.succeed(ResidentConfiguration, 7)),
			),
		)
		let builds = 0
		let active = 0
		let turns = 0
		const plugin = Plugin.make({ id: Plugin.Id.make("openbot-resident") })(() =>
			Effect.gen(function* () {
				assert.equal(yield* ResidentConfiguration, 7)
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
							assert.equal(active, 1)
							turns++
							return next(options)
						}),
					)
			}),
		)
		try {
			await runtime.runPromise(Migration.initialize)
			await runtime.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const instance = yield* ManagedSessions.make({
							runtime: { plugin },
						})
						assert.equal(builds, 1)
						assert.equal(active, 1)
						const initial = yield* instance.store.create({
							metadata: {},
						})
						const first = yield* instance.runtime.execute({
							base: Session.position(initial.session),
							input: "one",
						})
						yield* instance.runtime
							.stream({ base: Session.position(first.session), input: "two" })
							.pipe(Stream.runDrain)
						assert.equal(builds, 1)
						assert.equal(turns, 2)
						assert.equal(active, 1)
					}),
				),
			)
			assert.equal(active, 0)
			const failing = PluginComposition.merge(
				plugin,
				Plugin.make({ id: Plugin.Id.make("failed") })(() =>
					Effect.fail("construction-failed" as const),
				),
			)
			await runtime.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const backend = yield* Backend
						yield* Effect.forEach([2, 3], (expectedBuilds) =>
							Effect.gen(function* () {
								const result = yield* backend
									.get("failed-construction")
									.pipe(Effect.result)
								assert.equal(result._tag, "Failure")
								assert.equal(builds, expectedBuilds)
								assert.equal(active, 0)
							}),
						)
					}),
				).pipe(
					Effect.provide(BackendLayers.layer({ runtime: { plugin: failing } })),
				),
			)
		} finally {
			await runtime.dispose()
			await database.close()
		}
	},
)
