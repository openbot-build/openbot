// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Config, Model, Session } from "@openbot-build/core"
import {
	Deferred,
	Effect,
	Layer,
	ManagedRuntime,
	Queue,
	Redacted,
	Stream,
} from "effect"
import * as ManagedSessions from "../src/sessions/ManagedSessions.ts"
import * as AgentFixture from "./AgentFixture.ts"
import * as DevelopmentModel from "../src/app/DevelopmentModel.ts"
import * as RepositoryPostgres from "../src/sessions/RepositoryPostgres.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"
import * as InstanceWork from "../src/execution/InstanceWork.ts"
import * as Signals from "../src/agents/Signals.ts"

test(
	"one Turn can disable memory without changing Session defaults or the next Turn",
	{ timeout: 30000 },
	async () => {
		const database = await PostgresTest.start()
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				RepositoryPostgres.layer.pipe(
					Layer.provideMerge(
						DatabasePostgres.layer({
							databaseUrl: Redacted.make(database.url),
						}),
					),
				),
				DevelopmentModel.layerTools,
			).pipe(Layer.provide(NodeServices.layer)),
		)
		try {
			await runtime.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* DatabasePostgres.migrate
						const options = yield* DevelopmentModel.make
						const sessions = yield* ManagedSessions.make({
							...options.sessions,
							modelCatalog: Effect.succeed({
								providers: options.builtinModels.providers,
								models: options.builtinModels.models,
							}),
							defaults: Effect.succeed({ model: DevelopmentModel.selection }),
							namespace: "turn-memory-owner",
							resolveModel: (selection) =>
								options.builtinModels.resolve(
									selection ?? DevelopmentModel.selection,
								),
						})
						const created = yield* sessions.create({
							...AgentFixture.direct(),
							memory: { use: true, generate: true },
						})
						yield* (yield* sessions.sendStream(created.session.id, {
							expected: created.session.revision,
							input: "Do not learn this turn",
							memory: { use: false, generate: false },
						})).pipe(Stream.runDrain)
						const wait = (
							view: import("@openbot-build/api").SessionView,
						): Effect.Effect<
							import("@openbot-build/api").SessionView,
							import("../src/sessions/Sessions.ts").ServiceError
						> =>
							view.activity !== "active"
								? Effect.succeed(view)
								: sessions
										.wait(
											view.session.id,
											view.session.revision,
											1000,
											view.activity,
										)
										.pipe(Effect.flatMap(wait))
						const first = yield* sessions
							.get(created.session.id)
							.pipe(Effect.flatMap(wait))
						assert.deepEqual(
							first.session.turns[0]?.settings.pluginSettings?.[
								"@openbot-build/openbot/memory"
							],
							{ use: false, generate: false },
						)
						const memory = yield* sessions.memory(created.session.id)
						assert.deepEqual(memory.settings, { use: true, generate: true })
						assert.deepEqual(memory.processed, [])
						yield* (yield* sessions.sendStream(created.session.id, {
							expected: first.session.revision,
							input: "Use the saved defaults",
						})).pipe(Stream.runDrain)
						const second = yield* sessions
							.get(created.session.id)
							.pipe(Effect.flatMap(wait))
						assert.deepEqual(
							second.session.turns[1]?.settings.pluginSettings?.[
								"@openbot-build/openbot/memory"
							],
							{ use: true, generate: true },
						)
						assert.ok(
							(yield* sessions.memory(created.session.id)).processed.length > 0,
						)
						const changed = yield* sessions.settings(created.session.id, {
							expected: second.session.revision,
							settings: second.session.settings,
							memory: { use: false },
						})
						assert.equal(changed.session.revision, second.session.revision + 1)
						const fork = yield* sessions.fork(changed.session.id, {
							memory: { generate: false },
						})
						assert.deepEqual(
							(yield* sessions.memory(fork.session.id)).settings,
							{ use: false, generate: false },
						)
						assert.deepEqual(
							(yield* sessions.memory(changed.session.id)).settings,
							{ use: false, generate: true },
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

test(
	"a revision conflict leaves an unanswered call recoverable instead of reporting it settled",
	{ timeout: 30000 },
	async () => {
		const database = await PostgresTest.start()
		let writes = 0
		const entered = await Effect.runPromise(Deferred.make<void>())
		const finish = await Effect.runPromise(Deferred.make<void>())
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				InstanceWork.layer,
				Signals.layer,
				RepositoryPostgres.layer.pipe(
					Layer.provideMerge(
						DatabasePostgres.layer({
							databaseUrl: Redacted.make(database.url),
						}),
					),
				),
				DevelopmentModel.toolkit.toLayer({
					DevelopmentConfirmation: ({ description }) =>
						Effect.sync(() => {
							writes++
							return { confirmed: description }
						}),
				}),
			).pipe(Layer.provide(NodeServices.layer)),
		)
		try {
			await runtime.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* DatabasePostgres.migrate
						const options = yield* DevelopmentModel.make
						let beforeResolve = Effect.void
						const sessions = yield* ManagedSessions.make({
							...options.sessions,
							modelCatalog: Effect.succeed({
								providers: options.builtinModels.providers,
								models: options.builtinModels.models,
							}),
							defaults: Effect.succeed({ model: DevelopmentModel.selection }),
							namespace: "resolve-race",
							layerExecution: () =>
								DevelopmentModel.toolkit.toLayer({
									DevelopmentConfirmation: ({ description }) =>
										Effect.gen(function* () {
											writes++
											yield* Deferred.succeed(entered, undefined)
											yield* Deferred.await(finish)
											return { confirmed: description }
										}),
								}),
							resolveModel: (selection) =>
								beforeResolve.pipe(
									Effect.andThen(
										options.builtinModels.resolve(
											selection ?? DevelopmentModel.selection,
										),
									),
								),
						})
						const created = yield* sessions.create({
							...AgentFixture.direct(),
							settings: {
								model: Config.Selection.make({
									provider: DevelopmentModel.provider,
									model: Model.Id.make("mock-tool"),
								}),
							},
							memory: { use: false, generate: false },
						})
						yield* (yield* sessions.sendStream(created.session.id, {
							expected: created.session.revision,
							input: "confirm the action",
						})).pipe(Stream.runDrain)
						const waiting = yield* sessions.get(created.session.id)
						const approval = Session.waits(waiting)[0]
						assert.ok(approval)
						beforeResolve = sessions
							.update(created.session.id, {
								expected: waiting.session.revision,
								title: "Changed during approval",
							})
							.pipe(Effect.asVoid, Effect.orDie)
						const conflict = yield* sessions
							.resolveCall(
								created.session.id,
								approval.approvalId,
								Session.Outcome.Approved(),
							)
							.pipe(Effect.flip)
						assert.equal(conflict._tag, "SessionConflict")
						assert.equal(writes, 0)
						const stillWaiting = yield* sessions.get(created.session.id)
						assert.equal(
							Session.waits(stillWaiting)[0]?.approvalId,
							approval.approvalId,
						)
						beforeResolve = Effect.void
						yield* sessions.resolveCall(
							created.session.id,
							approval.approvalId,
							Session.Outcome.Approved(),
						)
						yield* Deferred.await(entered)
						const gate = yield* InstanceWork.InstanceWork
						yield* gate.quiesce
						assert.ok((yield* gate.status).activeTasks > 0)
						yield* Deferred.succeed(finish, undefined)
						let resolved = yield* sessions.get(created.session.id)
						for (
							let attempt = 0;
							attempt < 100 && resolved.activity === "active";
							attempt++
						) {
							yield* Effect.sleep("20 millis")
							resolved = yield* sessions.get(created.session.id)
						}
						assert.equal(Session.status(resolved.session)._tag, "Completed")
						assert.equal(writes, 1)
						assert.equal((yield* sessions.waits(created.session.id)).length, 0)
						yield* sessions.resolveCall(
							created.session.id,
							approval.approvalId,
							Session.Outcome.Approved(),
						)
						assert.equal(
							writes,
							1,
							"an already answered approval never sends the tool again",
						)
						const signals = yield* Signals.Signals
						const pending = yield* Queue.clear(signals.queue)
						assert.ok(
							pending.some(
								(entry) =>
									entry.signal._tag === "TurnChanged" &&
									entry.signal.status === "Completed",
							),
							"an admitted resumed Turn publishes its terminal signal while paused",
						)
						yield* Effect.forEach(pending, (entry) => entry.release)
						for (
							let attempt = 0;
							attempt < 100 && (yield* gate.status).activeTasks > 0;
							attempt++
						)
							yield* Effect.sleep("10 millis")
						assert.equal((yield* gate.status).activeTasks, 0)
					}),
				),
			)
		} finally {
			await Effect.runPromise(Deferred.succeed(finish, undefined))
			await runtime.dispose()
			await database.close()
		}
	},
)

test(
	"a completed streamed Turn keeps its task until memory finishes during pause",
	{ timeout: 30000 },
	async () => {
		const database = await PostgresTest.start()
		const entered = await Effect.runPromise(Deferred.make<void>())
		const finish = await Effect.runPromise(Deferred.make<void>())
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				InstanceWork.layer,
				Signals.layer,
				RepositoryPostgres.layer.pipe(
					Layer.provideMerge(
						DatabasePostgres.layer({
							databaseUrl: Redacted.make(database.url),
						}),
					),
				),
				DevelopmentModel.layerTools,
			).pipe(Layer.provide(NodeServices.layer)),
		)
		try {
			await runtime.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* DatabasePostgres.migrate
						const options = yield* DevelopmentModel.make
						const sessions = yield* ManagedSessions.make({
							...options.sessions,
							modelCatalog: Effect.succeed({
								providers: options.builtinModels.providers,
								models: options.builtinModels.models,
							}),
							defaults: Effect.succeed({ model: DevelopmentModel.selection }),
							namespace: "memory-release",
							resolveModel: (selection) =>
								options.builtinModels.resolve(
									selection ?? DevelopmentModel.selection,
								),
							memory: {
								model: {
									extract: () =>
										Effect.gen(function* () {
											assert.equal(yield* InstanceWork.admitted, true)
											yield* Deferred.succeed(entered, undefined)
											yield* Deferred.await(finish)
											assert.equal(
												yield* InstanceWork.admitted,
												true,
												"postprocessing retains its original task after pause",
											)
											return { changes: [] }
										}),
								},
							},
						})
						const created = yield* sessions.create({
							...AgentFixture.direct(),
							memory: { use: false, generate: true },
						})
						yield* sessions.send(created.session.id, {
							expected: created.session.revision,
							input: "Remember this after the response",
						})
						yield* Deferred.await(entered)
						const gate = yield* InstanceWork.InstanceWork
						yield* gate.quiesce
						assert.ok((yield* gate.status).activeTasks > 0)
						const completed = yield* sessions.get(created.session.id)
						assert.equal(Session.status(completed.session)._tag, "Completed")
						assert.equal(
							completed.activity,
							"active",
							"a completed response can still have real memory work",
						)
						yield* Deferred.succeed(finish, undefined)
						let current = yield* sessions.get(created.session.id)
						for (
							let attempt = 0;
							attempt < 100 && current.activity === "active";
							attempt++
						) {
							yield* Effect.sleep("10 millis")
							current = yield* sessions.get(created.session.id)
						}
						assert.notEqual(current.activity, "active")
						assert.ok(
							(yield* sessions.memory(created.session.id)).processed.length > 0,
						)
						const pending = yield* Queue.clear((yield* Signals.Signals).queue)
						yield* Effect.forEach(pending, (entry) => entry.release)
						for (
							let attempt = 0;
							attempt < 100 && (yield* gate.status).activeTasks > 0;
							attempt++
						)
							yield* Effect.sleep("10 millis")
						assert.equal((yield* gate.status).activeTasks, 0)
					}),
				),
			)
		} finally {
			await Effect.runPromise(Deferred.succeed(finish, undefined))
			await runtime.dispose()
			await database.close()
		}
	},
)
