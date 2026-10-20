// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Session } from "@openbot-build/core"
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect"
import * as ManagedSessions from "../src/sessions/ManagedSessions.ts"
import * as Approvals from "../src/approvals/Approvals.ts"
import * as DevelopmentModel from "../src/app/DevelopmentModel.ts"
import * as RepositoryPostgres from "../src/sessions/RepositoryPostgres.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"

test(
	"development Session Memory survives forks and a restart without replay or leaks between owners",
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
				Approvals.layer,
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
							...options,
							namespace: "memory-owner",
						})
						let source = yield* sessions.create({})
						source = yield* sessions.updateMemory(source.session.id, {
							expected: source.session.head,
							revision: source.session.revision,
							command: {
								_tag: "Remember",
								key: "shared",
								content: "User supplied fact",
								kind: "fact",
							},
						})
						source = yield* sessions.updateMemory(source.session.id, {
							expected: source.session.head,
							revision: source.session.revision,
							command: {
								_tag: "Remember",
								key: "retired",
								content: "Retracted fact",
								kind: "fact",
							},
						})
						source = yield* sessions.updateMemory(source.session.id, {
							expected: source.session.head,
							revision: source.session.revision,
							command: { _tag: "Forget", key: "retired" },
						})
						yield* (yield* sessions.sendStream(source.session.id, {
							expected: source.session.revision,
							input: "Persist this conversation",
						})).pipe(Stream.runDrain)
						const settle = (
							view: import("@openbot-build/platform-api").SessionView,
						): Effect.Effect<
							import("@openbot-build/platform-api").SessionView,
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
										.pipe(Effect.flatMap(settle))
						source = yield* sessions
							.get(source.session.id)
							.pipe(Effect.flatMap(settle))
						assert.equal(Session.status(source.session)._tag, "Completed")
						const memory = yield* sessions.memory(source.session.id)
						assert.equal(
							memory.entries["shared"]?.content,
							"User supplied fact",
						)
						assert.equal(memory.entries["retired"]?.status, "retracted")
						assert.deepEqual(
							memory.processed,
							source.state.value.memory.history.map((item) => item.id),
						)
						assert.ok(memory.processed.length >= 2)
						const fork = yield* sessions.fork(source.session.id, {
							version: source.session.head,
						})
						assert.equal(Session.status(fork.session)._tag, "Idle")
						assert.deepEqual(
							fork.state.value.memory.history,
							source.state.value.memory.history,
						)
						assert.deepEqual(yield* sessions.memory(fork.session.id), memory)
						const changed = yield* sessions.updateMemory(fork.session.id, {
							expected: fork.session.head,
							revision: fork.session.revision,
							command: {
								_tag: "Remember",
								key: "shared",
								content: "Fork only fact",
								kind: "fact",
							},
						})
						assert.equal(
							(yield* sessions.memory(changed.session.id)).entries["shared"]
								?.content,
							"Fork only fact",
						)
						assert.deepEqual(yield* sessions.memory(source.session.id), memory)
						const stale = yield* sessions
							.updateMemory(fork.session.id, {
								expected: fork.session.head,
								revision: fork.session.revision,
								command: {
									_tag: "Remember",
									key: "stale",
									content: "Must not commit",
									kind: "fact",
								},
							})
							.pipe(Effect.flip)
						assert.equal(stale._tag, "SessionConflict")
						assert.equal(
							(yield* sessions.memory(fork.session.id)).entries["stale"],
							undefined,
						)
						const restored = yield* ManagedSessions.make({
							...options,
							namespace: "memory-owner",
						})
						assert.deepEqual(yield* restored.memory(source.session.id), memory)
						const resumed = yield* restored.get(source.session.id)
						assert.deepEqual(resumed.session, source.session)
						assert.deepEqual(
							resumed.state.value.memory.history,
							source.state.value.memory.history,
						)
						assert.equal(resumed.activity, "inactive")
						const other = yield* ManagedSessions.make({
							...options,
							namespace: "other-owner",
						})
						assert.equal(
							(yield* other.get(source.session.id).pipe(Effect.flip))._tag,
							"SessionNotFound",
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
