import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Redacted,
	Schedule,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Store from "../src/execution/Store.ts"
import * as Fixture from "./ExecutionPermitFixture.ts"
import * as PostgresTest from "./PostgresTest.ts"

class Database extends Context.Service<Database, PostgresTest.Database>()(
	"@openbot-build/openbot/test/ExecutionPermitProcesses.test/Database",
) {}

const tables = Layer.effectDiscard(
	Effect.gen(function* () {
		yield* DatabasePostgres.migrate
		const sql = yield* PgClient.PgClient
		yield* sql`create table permit_test_nodes (runner integer primary key, go boolean not null default false)`
		yield* sql`create table permit_test_work (
			runner integer not null, slot integer not null, waiting boolean not null default false,
			entered boolean not null default false, released boolean not null default false,
			closed boolean not null default false, permit_id text, deadline float8,
			admitted_at float8, last_check text, result text, primary key (runner, slot))`
		yield* sql`create table permit_test_counts (active integer not null, peak integer not null)`
		yield* sql`insert into permit_test_counts (active, peak) values (0, 0)`
	}),
).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(Database, (database) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
			),
		),
	),
)

const services = Fixture.services.pipe(
	Layer.provideMerge(tables),
	Layer.provideMerge(Layer.effect(Database, PostgresTest.start)),
	Layer.provideMerge(NodeServices.layer),
)

interface Work {
	readonly waiting: boolean
	readonly entered: boolean
	readonly closed: boolean
	readonly permitId: string | null
	readonly deadline: number | null
	readonly admittedAt: number | null
	readonly lastCheck: string | null
	readonly result: string | null
}

const waitWork = Effect.fn(function* (
	runner: number,
	until: (work: Work) => boolean,
) {
	const sql = yield* PgClient.PgClient
	const [work] =
		yield* sql<Work>`select waiting, entered, closed, permit_id as "permitId", deadline,
		admitted_at as "admittedAt", last_check as "lastCheck", result
		from permit_test_work where runner = ${runner} and slot = 0`.pipe(
			Effect.repeat({
				schedule: Schedule.spaced("20 millis"),
				until: (rows) => rows[0] !== undefined && until(rows[0]),
			}),
			Effect.timeout("20 seconds"),
		)
	if (work === undefined) return yield* Effect.die("The process has no work.")
	return work
})

const spawn = Effect.fn(function* (
	runner: number,
	fence: Store.Fence,
	pool: string,
	options: {
		readonly duration?: number
		readonly batch?: number
		readonly limit?: number
	} = {},
) {
	const database = yield* Database
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const process = yield* spawner.spawn(
		ChildProcess.make(
			"node",
			[
				"--disable-warning=ExperimentalWarning",
				new URL("./ExecutionPermitNode.ts", import.meta.url).pathname,
			],
			{
				extendEnv: true,
				env: {
					TEST_DATABASE_URL: `${database.url}?application_name=permit-node-${runner}`,
					TEST_RUNNER_ID: String(runner),
					TEST_NAMESPACE: fence.namespace,
					TEST_EXECUTION_ID: fence.id,
					TEST_GENERATION: String(fence.generation),
					TEST_POOL: pool,
					TEST_DURATION: String(options.duration ?? 30_000),
					TEST_BATCH: String(options.batch ?? 1),
					TEST_LIMIT: String(options.limit ?? 1),
				},
				// A failed test must also stop a child left in SIGSTOP.
				killSignal: "SIGKILL",
				stdout: "inherit",
				stderr: "inherit",
			},
		),
	)
	const sql = yield* PgClient.PgClient
	yield* sql`select runner from permit_test_nodes where runner = ${runner}`.pipe(
		Effect.repeat({
			schedule: Schedule.spaced("20 millis"),
			until: (rows) => rows.length === 1,
		}),
		Effect.timeout("20 seconds"),
	)
	return process
})

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect("two Node processes keep one shared permit limit", () =>
		Effect.gen(function* () {
			const sql = yield* PgClient.PgClient
			const first = yield* spawn(
				1,
				yield* Fixture.start("process-cap-1"),
				"cap",
				{
					batch: 16,
					limit: 2,
				},
			)
			const second = yield* spawn(
				2,
				yield* Fixture.start("process-cap-2"),
				"cap",
				{
					batch: 16,
					limit: 2,
				},
			)
			assert.notEqual(first.pid, second.pid)
			yield* sql`update permit_test_nodes set go = true where runner in (1, 2)`
			assert.equal(yield* first.exitCode, 0)
			assert.equal(yield* second.exitCode, 0)
			assert.deepEqual(
				yield* sql`select active, peak from permit_test_counts`,
				[{ active: 0, peak: 2 }],
			)
			assert.deepEqual(
				yield* sql`select runner, count(*)::int as count from permit_test_work
					where entered and closed and result = 'done' and last_check = 'allowed'
					group by runner order by runner`,
				[
					{ runner: 1, count: 16 },
					{ runner: 2, count: 16 },
				],
			)
			assert.equal(
				(yield* sql`select id from openbot_execution_permits`).length,
				0,
			)
		}),
	)

	it.effect(
		"a paused owner keeps its place until the deadline and cannot release the new place",
		() =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
				const store = yield* Store.Store
				const old = yield* Fixture.start("process-deadline")
				const first = yield* spawn(3, old, "deadline", { duration: 10_000 })
				yield* sql`update permit_test_nodes set go = true where runner = 3`
				const held = yield* waitWork(3, (work) => work.entered)
				assert.equal(
					yield* spawner.exitCode(
						ChildProcess.make("kill", ["-STOP", String(first.pid)]),
					),
					0,
				)
				const disconnected = yield* sql<{
					readonly killed: boolean
				}>`select pg_terminate_backend(pid) as killed from pg_stat_activity
				where application_name = 'permit-node-3'`
				assert.isAbove(disconnected.length, 0)
				assert.isTrue(
					Arr.every(disconnected, (connection) => connection.killed),
				)
				// Grant the next generation through the same store call used by the engine.
				const current = yield* store.takeOver(old)
				const second = yield* spawn(4, current, "deadline")
				yield* sql`update permit_test_nodes set go = true where runner = 4`
				const queued = yield* waitWork(4, (work) => work.waiting)
				assert.isFalse(queued.entered)
				assert.deepEqual(
					yield* sql`select id, generation from openbot_execution_permits where execution_id = ${old.id}`,
					[{ id: held.permitId, generation: old.generation }],
				)
				const entered = yield* waitWork(4, (work) => work.entered)
				assert.isAtLeast(
					entered.admittedAt ?? 0,
					held.deadline ?? Number.POSITIVE_INFINITY,
				)
				assert.notEqual(entered.permitId, held.permitId)
				assert.equal(
					yield* spawner.exitCode(
						ChildProcess.make("kill", ["-CONT", String(first.pid)]),
					),
					0,
				)
				assert.equal(yield* first.exitCode, 0)
				const closed = yield* waitWork(3, (work) => work.closed)
				assert.equal(closed.lastCheck, "ExecutionConflict")
				assert.oneOf(closed.result, [
					"TimeoutError",
					"SqlError",
					"ExecutionConflict",
				])
				// The old finalizer has run against the same execution, with its new permit present.
				assert.deepEqual(
					yield* sql`select id, generation from openbot_execution_permits where execution_id = ${old.id}`,
					[{ id: entered.permitId, generation: current.generation }],
				)
				yield* sql`update permit_test_work set released = true where runner = 4`
				assert.equal(yield* second.exitCode, 0)
				assert.equal((yield* waitWork(4, (work) => work.closed)).result, "done")
				assert.equal(
					(yield* sql`select id from openbot_execution_permits`).length,
					0,
				)
			}),
	)

	it.effect(
		"cancel and process shutdown release only their own permits and allow a fresh process",
		() =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const store = yield* Store.Store
				const owner = yield* Fixture.start("process-cancel-owner")
				const waiter = yield* Fixture.start("process-cancel-waiter")
				const first = yield* spawn(5, owner, "cancel")
				yield* sql`update permit_test_nodes set go = true where runner = 5`
				const held = yield* waitWork(5, (work) => work.entered)
				const second = yield* spawn(6, waiter, "cancel")
				yield* sql`update permit_test_nodes set go = true where runner = 6`
				assert.isFalse((yield* waitWork(6, (work) => work.waiting)).entered)
				yield* store.cancel(
					waiter,
					Execution.CommandKey.make("stop"),
					Fixture.actor,
				)
				assert.equal(yield* second.exitCode, 0)
				const cancelled = yield* waitWork(6, (work) => work.closed)
				assert.isFalse(cancelled.entered)
				assert.equal(cancelled.result, "ExecutionConflict")
				assert.deepEqual(yield* sql`select id from openbot_execution_permits`, [
					{ id: held.permitId },
				])
				yield* store.cancel(
					owner,
					Execution.CommandKey.make("stop"),
					Fixture.actor,
				)
				// NodeRuntime closes the actual owner scope before its process exits.
				yield* first.kill({ killSignal: "SIGTERM" })
				assert.equal(
					(yield* waitWork(5, (work) => work.closed)).lastCheck,
					"ExecutionConflict",
				)
				assert.equal(
					(yield* sql`select id from openbot_execution_permits`).length,
					0,
				)
				yield* sql`delete from permit_test_work where runner = 6`
				yield* sql`delete from permit_test_nodes where runner = 6`
				const restart = yield* spawn(
					6,
					yield* Fixture.start("process-cancel-new"),
					"cancel",
				)
				assert.notEqual(restart.pid, second.pid)
				yield* sql`update permit_test_nodes set go = true where runner = 6`
				yield* waitWork(6, (work) => work.entered)
				yield* sql`update permit_test_work set released = true where runner = 6`
				assert.equal(yield* restart.exitCode, 0)
				assert.equal((yield* waitWork(6, (work) => work.closed)).result, "done")
				assert.equal(
					(yield* sql`select id from openbot_execution_permits`).length,
					0,
				)
			}),
	)
})
