// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect"
import * as ManagedSessions from "../src/sessions/ManagedSessions.ts"
import * as Approvals from "../src/approvals/Approvals.ts"
import * as DevelopmentModel from "../src/app/DevelopmentModel.ts"
import * as RepositoryPostgres from "../src/sessions/RepositoryPostgres.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"

test("one Turn can disable memory without changing Session defaults or the next Turn", { timeout: 30000 }, async () => {
	const database = await PostgresTest.start()
	const runtime = ManagedRuntime.make(Layer.mergeAll(
		RepositoryPostgres.layer.pipe(Layer.provideMerge(DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }))),
		Approvals.layer, DevelopmentModel.layerTools,
	).pipe(Layer.provide(NodeServices.layer)))
	try {
		await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
			yield* DatabasePostgres.migrate
			const options = yield* DevelopmentModel.make
			const sessions = yield* ManagedSessions.make({ ...options, namespace: "turn-memory-owner" })
			const created = yield* sessions.create({ memory: { use: true, generate: true } })
			yield* (yield* sessions.sendStream(created.session.id, { expected: created.session.revision, input: "Do not learn this turn", memory: { use: false, generate: false } })).pipe(Stream.runDrain)
			const wait = (view: import("@openbot-build/platform-api").SessionView): Effect.Effect<import("@openbot-build/platform-api").SessionView, import("../src/sessions/Sessions.ts").ServiceError> => view.activity !== "active" ? Effect.succeed(view) : sessions.wait(view.session.id, view.session.revision, 1000, view.activity).pipe(Effect.flatMap(wait))
			const first = yield* sessions.get(created.session.id).pipe(Effect.flatMap(wait))
			assert.deepEqual(first.session.turns[0]?.settings.pluginSettings?.["@openbot-build/plugin-memory"], { use: false, generate: false })
			const memory = yield* sessions.memory(created.session.id)
			assert.deepEqual(memory.settings, { use: true, generate: true })
			assert.deepEqual(memory.processed, [])
			yield* (yield* sessions.sendStream(created.session.id, { expected: first.session.revision, input: "Use the saved defaults" })).pipe(Stream.runDrain)
			const second = yield* sessions.get(created.session.id).pipe(Effect.flatMap(wait))
			assert.deepEqual(second.session.turns[1]?.settings.pluginSettings?.["@openbot-build/plugin-memory"], { use: true, generate: true })
			assert.ok((yield* sessions.memory(created.session.id)).processed.length > 0)
			const changed = yield* sessions.settings(created.session.id, { expected: second.session.revision, settings: second.session.settings, memory: { use: false } })
			assert.equal(changed.session.revision, second.session.revision + 1)
			const fork = yield* sessions.fork(changed.session.id, { memory: { generate: false } })
			assert.deepEqual((yield* sessions.memory(fork.session.id)).settings, { use: false, generate: false })
			assert.deepEqual((yield* sessions.memory(changed.session.id)).settings, { use: false, generate: true })
		})))
	} finally { await runtime.dispose(); await database.close() }
})
