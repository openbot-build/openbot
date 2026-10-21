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
import * as Migration from "../src/database/Migrations.ts"
import * as RepositoryPostgres from "../src/sessions/RepositoryPostgres.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"
import * as ManagedSessions from "../src/sessions/ManagedSessions.ts"
import * as Approvals from "../src/approvals/Approvals.ts"
import * as BackendLayers from "../src/app/BackendLayers.ts"
import { Backend } from "../src/app/Backend.ts"

test(
	"PostgreSQL saves independent Session revisions and immutable Memory in one step within each tenant",
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
						const repository = yield* RepositoryPostgres.make,
							definition = yield* Store.define({
								stores: {},
								schemaVersion: "memory/1",
							})
						const store = yield* SessionStoreRepository.make({
							definition,
							persistence: repository.store("alice"),
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
						assert.equal(
							yield* repository.store("bob").getRef(root.session.id),
							null,
						)
						const competing = yield* Effect.forEach(
							["first", "second"],
							(title) =>
								repository
									.save("alice", {
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
									})
									.pipe(Effect.exit),
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
											memory: {
												...view.state.value.memory,
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
							(yield* sql`SELECT id FROM openbot_memory_versions`).length,
							2,
						)
						assert.equal(
							(yield* sql`SELECT id FROM openbot_memory_contents`).length,
							1,
						)
						const fork = yield* store.fork({ source: changed.session.id })
						assert.equal(fork.session.head, changed.session.head)
						assert.equal(
							(yield* sql`SELECT id FROM openbot_memory_versions`).length,
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
							persistence: repository.store("alice"),
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
					assert.deepEqual(tables, [
						"openbot_api_keys",
						"openbot_app_authorizations",
						"openbot_app_connections",
						"openbot_app_drafts",
						"openbot_app_index_entries",
						"openbot_app_index_jobs",
						"openbot_app_index_results",
						"openbot_app_invocations",
						"openbot_app_records",
						"openbot_app_secrets",
						"openbot_auth_account",
						"openbot_auth_session",
						"openbot_auth_user",
						"openbot_auth_verification",
						"openbot_developer_records",
						"openbot_memory_contents",
						"openbot_memory_versions",
						"openbot_session_references",
					])
				}),
			)
		} finally {
			await runtime.dispose()
			await database.close()
		}
	},
)

test(
	"Platform builds resident user middleware once and releases it with the host Scope",
	{ timeout: 30000 },
	async () => {
		class ResidentConfiguration extends Context.Service<
			ResidentConfiguration,
			number
		>()("@openbot-build/platform/test/Storage.test/ResidentConfiguration") {}
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
			Layer.merge(RepositoryPostgres.layer, Approvals.layer).pipe(
				Layer.provideMerge(
					DatabasePostgres.layer({
						databaseUrl: Redacted.make(database.url),
					}).pipe(Layer.provide(NodeServices.layer)),
				),
				Layer.provideMerge(model),
				Layer.provideMerge(Layer.succeed(ResidentConfiguration, 7)),
			),
		)
		let builds = 0
		let active = 0
		let turns = 0
		const plugin = Plugin.make({ id: Plugin.Id.make("platform-resident") })(
			() =>
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
