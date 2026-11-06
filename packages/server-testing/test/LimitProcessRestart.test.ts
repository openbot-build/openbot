/**
 * The limit plugins and the missing-feature policy across a restart of the
 * server process. Each test starts a server in a child process, starts a
 * Turn, and stops the process in the middle of a model step. A new process
 * with a changed plugins file then goes on with the Turn on the same
 * database. No value in the memory of the first process can reach the
 * second one, so the second process works only from what the Turn saved.
 */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import * as TestDatabase from "@openbot-build/server-database/Testing"
import * as SecretsModule from "@openbot-build/server-kernel/Secrets"
import { Secrets } from "@openbot-build/server-kernel/Secrets"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	FileSystem,
	Layer,
	Path,
	Redacted,
	Schedule,
	String as Str,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Caller from "../src/Caller.ts"
import * as DevelopmentLogin from "../src/DevelopmentLogin.ts"
import * as Failures from "../src/Failures.ts"
import * as Messages from "../src/Messages.ts"
import { waitFeature } from "./LimitFixture.ts"

const publicOrigin = "https://localhost:8443"
/** The same keys as the server processes, so the test can open sealed records. */
const secretKeys = Redacted.make("test:" + Str.repeat(32)("11"))

const turnLimit = (maxSteps: number) =>
	`- id: turn-limiter\n  disabled: false\n  config:\n    maxSteps: ${maxSteps}\n`
const tokenLimit = (maxTokens: number) =>
	`- id: token-limiter\n  disabled: false\n  config:\n    maxTokens: ${maxTokens}\n`
const timeLimit = (maxDuration: number) =>
	`- id: time-limiter\n  disabled: false\n  config:\n    maxDuration: ${maxDuration}\n`

const poll = <A, E, R>(
	read: Effect.Effect<A, E, R>,
	ready: (value: A) => boolean,
) =>
	read.pipe(
		Effect.repeat({ until: ready, schedule: Schedule.spaced("50 millis") }),
		Effect.timeout("90 seconds"),
	)

/** The public failure category of one execution. */
const categoryOf = (send: Messages.Send, executionId: string) =>
	Effect.map(
		Effect.flatMap(
			send(`/v1/executions/${executionId}`, "GET"),
			Caller.json(Execution.Record),
		),
		(record) => record.failure?.category,
	)

/**
 * Starts a new database and gives a way to start server processes on it,
 * each with the plugins file of the test as it is at the start.
 */
const cluster = Effect.gen(function* () {
	const database = yield* TestDatabase.migrated
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const services = yield* Layer.build(
		Layer.merge(
			PgClient.layer({ url: Redacted.make(database.url) }),
			SecretsModule.layer(secretKeys),
		),
	)
	const sql = Context.get(services, PgClient.PgClient)
	yield* sql`create table limit_restart_nodes (node integer primary key, address text not null)`
	yield* sql`create table limit_restart_calls (
		id serial primary key, node integer not null, results integer not null, held boolean not null)`
	const pluginsFile = path.join(
		yield* fs.makeTempDirectoryScoped(),
		"plugins.yml",
	)
	/**
	 * Starts server process `node`. A model request with `hold` tool results
	 * never ends; with `always`, no request ends; with `never`, every one ends.
	 */
	const start = Effect.fn(function* (
		node: number,
		plugins: string,
		hold: string,
	) {
		yield* fs.writeFileString(pluginsFile, plugins)
		const child = yield* spawner.spawn(
			ChildProcess.make(
				"node",
				[
					"--disable-warning=ExperimentalWarning",
					new URL("./LimitRestartNode.ts", import.meta.url).pathname,
				],
				{
					extendEnv: true,
					env: {
						LIMIT_RESTART_DATABASE_URL: `${database.url}?application_name=limit-restart-${node}`,
						LIMIT_RESTART_NODE: String(node),
						LIMIT_RESTART_PLUGINS_FILE: pluginsFile,
						LIMIT_RESTART_HOLD: hold,
					},
					killSignal: "SIGKILL",
					stdout: "inherit",
					stderr: "inherit",
				},
			),
		)
		const rows = yield* poll(
			sql<{
				readonly address: string
			}>`select address from limit_restart_nodes where node = ${node}`,
			(rows) => rows.length === 1,
		).pipe(
			Effect.raceFirst(
				child.exitCode.pipe(
					Effect.flatMap((code) =>
						Effect.die(
							`The server ${node} stopped before it was ready: ${code}`,
						),
					),
				),
			),
		)
		return {
			address: rows[0]!.address,
			// A normal stop, as in a new deploy. A hard kill also works, but
			// then the cluster waits up to 35 seconds for the lease of the dead
			// runner to end, which makes the time of the tests vary.
			stop: Effect.andThen(
				child.kill({ killSignal: "SIGTERM" }),
				child.exitCode,
			).pipe(Effect.timeout("60 seconds")),
		}
	})
	/** The model requests that server process `node` saw, in order. */
	const calls = (node: number) =>
		sql<{
			readonly results: number
			readonly held: boolean
		}>`select results, held from limit_restart_calls where node = ${node} order by id`
	/** The text of the sealed error record of one execution. */
	const recordOf = (executionId: string) =>
		Effect.gen(function* () {
			const rows = Arr.filter(
				yield* Failures.read,
				(row) => row.executionId === executionId,
			)
			assert.strictEqual(rows.length, 1)
			const row = rows[0]!
			const secrets = yield* Secrets
			return yield* secrets.open(row.cause, `failure:${row.id}`)
		}).pipe(Effect.provideContext(services))
	return { start, calls, recordOf }
})

/**
 * Starts a Turn on server process 1 with the plugins file `before`. The model
 * request with `hold` tool results never ends. When the Turn waits in that
 * request, the test stops the process. Process 2 starts with the plugins
 * file `after`, and the test waits until the Turn comes to rest there.
 * A normal stop waits 15 seconds for the Turn, the time that the cluster
 * gives an entity to end.
 */
const restartProcess = (options: {
	readonly before: string
	readonly after: string
	readonly hold: string
	readonly holdAfter?: string
}) =>
	Effect.gen(function* () {
		const nodes = yield* cluster
		const first = yield* nodes.start(1, options.before, options.hold)
		const session = yield* DevelopmentLogin.signIn(first.address, publicOrigin)
		const bot = yield* Messages.bot(session.send)
		const begin = yield* Clock.currentTimeMillis
		const receipt = yield* Messages.message(session.send, bot, "Read it twice")
		yield* poll(
			nodes.calls(1),
			Arr.some((call) => call.held),
		)
		yield* first.stop
		const stopped = yield* Clock.currentTimeMillis
		const second = yield* nodes.start(
			2,
			options.after,
			options.holdAfter ?? "never",
		)
		const send = DevelopmentLogin.browser(
			second.address,
			publicOrigin,
			session.credential,
		)
		// Not `Messages.settled`: the time limit test waits longer than its 20 seconds.
		const view = yield* poll(
			Messages.view(send, receipt.chat),
			(view) => view.status !== "Running" && view.inbox === 0,
		)
		const end = yield* Clock.currentTimeMillis
		assert.strictEqual(view.response?.id, receipt.turn)
		return {
			send,
			receipt,
			view,
			begin,
			stopped,
			end,
			before: yield* nodes.calls(1),
			after: Arr.map(yield* nodes.calls(2), (call) => call.results),
			recordOf: nodes.recordOf,
		}
	})

// The servers are real processes, so the tests need real time.
layer(
	Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer),
	{ excludeTestServices: true, timeout: "240 seconds" },
)((it) => {
	it.effect(
		"a new process goes on with a Turn without a limit plugin that was turned off",
		() =>
			Effect.gen(function* () {
				const { view, after } = yield* restartProcess({
					before: turnLimit(1),
					after: "- id: turn-limiter\n  disabled: true\n",
					hold: "0",
				})
				// The pin has a limit of 1 step and says `skip`. Without the plugin
				// the new process runs all 3 steps, and does not wait for it.
				assert.deepStrictEqual(after, [0, 1, 2])
				assert.strictEqual(view.response?.status, "completed")
			}).pipe(Effect.scoped),
		{ timeout: 180_000 },
	)

	it.effect(
		"a new process waits for a feature that was turned off, and fails the Turn after the bound",
		() =>
			Effect.gen(function* () {
				const { send, receipt, view, after, recordOf } = yield* restartProcess({
					before: "- id: wait-feature\n  disabled: false\n",
					after: "- id: wait-feature\n  disabled: true\n",
					hold: "0",
				})
				// The pin says `wait`, so the Turn makes no model request without
				// the feature. It fails when the bound of 2 seconds is over.
				assert.deepStrictEqual(after, [])
				assert.strictEqual(view.response?.status, "failed")
				assert.strictEqual(view.response?.error?.code, "internal_error")
				const record = yield* recordOf(receipt.executionId)
				assert.include(record, "BotFeatureMissing")
				assert.include(record, waitFeature)
				assert.strictEqual(
					yield* categoryOf(send, receipt.executionId),
					"unavailable",
				)
			}).pipe(Effect.scoped),
		{ timeout: 180_000 },
	)

	it.effect(
		"a new process keeps the saved step count and the limit of the pin",
		() =>
			Effect.gen(function* () {
				const { send, receipt, view, before, after, recordOf } =
					yield* restartProcess({
						before: turnLimit(2),
						// A new limit counts only for new Turns.
						after: turnLimit(5),
						hold: "1",
					})
				assert.deepStrictEqual(
					Arr.map(before, (call) => call.results),
					[0, 1],
				)
				// Step 1 ran in the first process. The new process runs step 2
				// again, and stops before step 3. With a new count it would run
				// 2 more steps and complete.
				assert.deepStrictEqual(after, [1])
				assert.strictEqual(view.response?.status, "failed")
				assert.strictEqual(view.response?.error?.code, "limited")
				const record = yield* recordOf(receipt.executionId)
				assert.include(record, "ModelStepLimitExceeded")
				assert.match(record, /\["maxSteps",2\]/)
				assert.strictEqual(
					yield* categoryOf(send, receipt.executionId),
					"limited",
				)
			}).pipe(Effect.scoped),
		{ timeout: 180_000 },
	)

	it.effect(
		"a new process keeps the saved token usage and the limit of the pin",
		() =>
			Effect.gen(function* () {
				const { send, receipt, view, after, recordOf } = yield* restartProcess({
					before: tokenLimit(3),
					after: tokenLimit(100),
					hold: "1",
				})
				// Each step uses 2 tokens. Without the 2 saved tokens of step 1,
				// step 3 would be under the limit of 3.
				assert.deepStrictEqual(after, [1])
				assert.strictEqual(view.response?.status, "failed")
				assert.strictEqual(view.response?.error?.code, "limited")
				const record = yield* recordOf(receipt.executionId)
				assert.include(record, "TokenLimitExceeded")
				assert.match(record, /\["maxTokens",3\]/)
				assert.match(record, /\["usedTokens",4\]/)
				assert.strictEqual(
					yield* categoryOf(send, receipt.executionId),
					"limited",
				)
			}).pipe(Effect.scoped),
		{ timeout: 180_000 },
	)

	it.effect(
		"a new process keeps the time deadline from the start of the Turn",
		() =>
			Effect.gen(function* () {
				// The stop of the first process and the start of the second one
				// take about 20 seconds. The deadline comes after them.
				const maxDuration = 40_000
				const { send, receipt, view, begin, stopped, end, after, recordOf } =
					yield* restartProcess({
						before: timeLimit(maxDuration),
						after: timeLimit(600_000),
						// No model request ends, in either process.
						hold: "always",
						holdAfter: "always",
					})
				// The second process runs the first step again, and the limit stops
				// it. On a slow machine the deadline can be over before the second
				// process starts; then the limit stops the Turn before the step.
				assert.isAtMost(after.length, 1)
				assert.strictEqual(view.response?.status, "failed")
				assert.strictEqual(view.response?.error?.code, "limited")
				const record = yield* recordOf(receipt.executionId)
				assert.include(record, "TimeLimitExceeded")
				assert.strictEqual(
					yield* categoryOf(send, receipt.executionId),
					"limited",
				)
				// The Turn cannot end before its deadline.
				assert.isAtLeast(end - begin, maxDuration)
				// A deadline that started again in the new process would end at
				// least `maxDuration` after the stop of the first process.
				assert.isBelow(end - stopped, maxDuration)
			}).pipe(Effect.scoped),
		{ timeout: 180_000 },
	)
})
