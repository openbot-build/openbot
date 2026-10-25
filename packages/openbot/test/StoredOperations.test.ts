// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Chat, Operation, Operations, Turn } from "@openbot-build/core"
import { Effect, Fiber, Layer, Redacted, type Scope, Stream } from "effect"
import * as Db from "../src/database/Database.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as StoredOperations from "../src/operations/StoredOperations.ts"
import * as PostgresTest from "./PostgresTest.ts"

const chat = Chat.Id.make("chat-1")
const record = (id: string): Operation.Record => ({
	id: Operation.Id.make(id),
	chat,
	turn: Turn.Id.make("turn-1"),
	callId: "call-1",
	tool: "Slow",
	kind: "tool",
	status: Operation.Status.Running(),
	startedAt: 1,
})

/** Runs the test against a new database, with the migrations done. */
const withDatabase = <A, E>(
	test: Effect.Effect<
		A,
		E,
		PgClient.PgClient | NodeServices.NodeServices | Scope.Scope
	>,
) =>
	Effect.gen(function* () {
		const database = yield* Effect.acquireRelease(
			Effect.promise(() => PostgresTest.start()),
			(database) => Effect.promise(() => database.close()),
		)
		// The scope of the test ends first, while the database is still there.
		return yield* Effect.andThen(
			DatabasePostgres.migrate,
			Effect.scoped(test).pipe(Effect.provide(StoredOperations.layerChannel)),
		).pipe(
			Effect.provide(
				DatabasePostgres.layer({
					databaseUrl: Redacted.make(database.url),
				}).pipe(Layer.provideMerge(NodeServices.layer)),
			),
		)
	})

it.live(
	"two servers share Operations: one ends an Operation once, and the other sees it change",
	() =>
		withDatabase(
			Effect.gen(function* () {
				const first = yield* StoredOperations.make("ns")
				const second = yield* StoredOperations.make("ns")
				const other = yield* StoredOperations.make("other")
				const changed = yield* second.changes.pipe(
					Stream.take(2),
					Stream.runCollect,
					Effect.forkChild({ startImmediately: true }),
				)
				yield* Effect.sleep("200 millis")
				yield* first.insert(record("op-1"))
				assert.deepStrictEqual(
					yield* second.get(Operation.Id.make("op-1")),
					record("op-1"),
				)
				assert.strictEqual(
					yield* other.get(Operation.Id.make("op-1")),
					undefined,
				)
				const ended = yield* first.finish(
					Operation.Id.make("op-1"),
					Operation.Status.Completed({ result: "done" }),
					5,
				)
				assert.deepStrictEqual(
					ended?.status,
					Operation.Status.Completed({ result: "done" }),
				)
				// Only the first end counts.
				assert.strictEqual(
					yield* second.finish(
						Operation.Id.make("op-1"),
						Operation.Status.Cancelled(),
						6,
					),
					undefined,
				)
				assert.deepStrictEqual(
					(yield* second.list(chat)).map((each) => each.status._tag),
					["Completed"],
				)
				assert.deepStrictEqual(yield* Fiber.join(changed), ["op-1", "op-1"])
			}),
		),
	60000,
)

it.live(
	"a sweep ends an Operation whose server stopped, only once",
	() =>
		withDatabase(
			Effect.gen(function* () {
				const store = yield* StoredOperations.make("ns")
				const db = yield* Db.make
				yield* store.insert(record("op-2"))
				const now = Date.now()
				assert.deepStrictEqual(
					yield* StoredOperations.stale(db, now - 60_000),
					[],
				)
				const found = yield* StoredOperations.stale(db, now + 60_000)
				assert.deepStrictEqual(
					found.map((each) => [each.namespace, each.record.id]),
					[["ns", "op-2"]],
				)
				const ended = yield* StoredOperations.interrupt(db, found[0]!)
				assert.strictEqual(ended?.status._tag, "Interrupted")
				assert.strictEqual(
					yield* StoredOperations.interrupt(db, found[0]!),
					undefined,
				)
				assert.strictEqual(
					(yield* store.get(Operation.Id.make("op-2")))?.status._tag,
					"Interrupted",
				)
			}),
		),
	60000,
)

it.live(
	"a server stops an Operation that another server runs",
	() =>
		withDatabase(
			Effect.gen(function* () {
				const settings = (): Effect.Effect<Operations.Settings> =>
					Effect.succeed({ ...Operations.defaultSettings, budget: "10 millis" })
				const running = yield* Operations.make({
					store: yield* StoredOperations.make("ns"),
					settings,
				})
				const elsewhere = yield* Operations.make({
					store: yield* StoredOperations.make("ns"),
					settings,
				})
				yield* Effect.sleep("200 millis")
				const outcome = yield* running.run(
					{
						chat,
						turn: Turn.Id.make("turn-1"),
						callId: "call-1",
						tool: "Slow",
						notify: () => Effect.void,
					},
					Effect.never,
					() => Operation.Status.Completed({ result: null }),
				)
				assert.strictEqual(outcome._tag, "Background")
				if (outcome._tag !== "Background") return
				const stopped = yield* elsewhere.cancel(chat, outcome.record.id)
				assert.strictEqual(stopped.status._tag, "Cancelled")
			}),
		),
	60000,
)
