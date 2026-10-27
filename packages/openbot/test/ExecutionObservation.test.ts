import * as ErrorRecords from "../src/errors/Records.ts"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Option,
	Queue,
	Redacted,
	Ref,
	Stream,
	String as Str,
} from "effect"
import { TestClock } from "effect/testing"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as PostgresTest from "./PostgresTest.ts"

const database = Layer.effectDiscard(DatabasePostgres.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = Layer.merge(Store.layer, ErrorRecords.layer).pipe(
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const start = Effect.fn(function* (namespace: string) {
	const store = yield* Store.Store
	const receipt = yield* store.submit(
		namespace,
		Execution.CommandKey.make("start"),
		{
			workflow: "test",
			resource: { kind: "Chat", id: namespace },
			identity: {
				owner: { organizationId: "org", userId: "user" },
				actor: { kind: "member", organizationId: "org", userId: "user" },
			},
			input: null,
		},
	)
	const fence = yield* store.takeOver({ namespace, id: receipt.executionId })
	return { fence, sequence: (yield* store.get(fence)).sequence }
})

interface Read {
	readonly after: number
	readonly count: number
}

/** Count real database reads without changing their data or order. */
const track = Effect.gen(function* () {
	const store = yield* Store.Store
	const reads = yield* Queue.unbounded<Read>()
	const history = yield* Ref.make<ReadonlyArray<Read>>([])
	const gets = yield* Ref.make(0)
	return {
		history,
		gets,
		read: (matches: (read: Read) => boolean) =>
			Queue.take(reads).pipe(Effect.repeat({ until: matches })),
		store: Store.Store.of({
			...store,
			get: (key) =>
				Ref.update(gets, (count) => count + 1).pipe(
					Effect.andThen(store.get(key)),
				),
			events: (key, after) =>
				store.events(key, after).pipe(
					Effect.tap((events) =>
						Effect.gen(function* () {
							const read = { after, count: events.length }
							yield* Ref.update(history, Arr.append(read))
							yield* Queue.offer(reads, read)
						}),
					),
				),
		}),
	}
})

layer(services, { timeout: "60 seconds" })((it) => {
	it.effect("a live slow reader fills a gap after more than 128 events", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const { fence, sequence } = yield* start("observe-slow")
			const tracked = yield* track
			const blocked = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const caughtUp = yield* Deferred.make<void>()
			const last = sequence + 1 + 384
			const seen = yield* Ref.make<ReadonlyArray<number>>([])
			yield* Effect.gen(function* () {
				const observation = yield* Observation.Observation
				const reading = yield* observation.observe(fence, sequence).pipe(
					Stream.tap((event) =>
						Effect.gen(function* () {
							if (event.sequence === sequence + 1) {
								yield* Deferred.succeed(blocked, undefined)
								yield* Deferred.await(release)
							}
							yield* Ref.update(seen, Arr.append(event.sequence))
							if (event.sequence === last)
								yield* Deferred.succeed(caughtUp, undefined)
						}),
					),
					Stream.runCollect,
					Effect.forkScoped,
				)
				yield* tracked.read((read) => read.after === sequence)
				yield* store.wake(fence, "first")
				yield* TestClock.adjust("1 second")
				yield* Deferred.await(blocked)
				yield* store.commit(
					fence,
					{
						events: Arr.map(Arr.range(1, 384), (part) => ({
							_tag: "Text" as const,
							step: "model",
							attempt: 0,
							text: String(part),
						})),
					},
					Effect.void,
				)
				yield* TestClock.adjust("1 second")
				// The node has published three full pages while this consumer is held.
				yield* tracked.read((read) => read.after === last && read.count === 0)
				assert.equal((yield* store.get(fence)).status, "running")
				assert.deepEqual(yield* Ref.get(seen), [])
				yield* Deferred.succeed(release, undefined)
				yield* Deferred.await(caughtUp)
				assert.deepEqual(yield* Ref.get(seen), Arr.range(sequence + 1, last))
				assert.isTrue(
					Arr.filter(
						yield* Ref.get(tracked.history),
						(read) => read.after === sequence + 1 && read.count === 128,
					).length >= 2,
				)
				yield* store.transition(fence, "completed")
				yield* TestClock.adjust("1 second")
				const events = yield* Fiber.join(reading)
				assert.deepEqual(
					Arr.map(events, (event) => event.sequence),
					Arr.range(sequence + 1, last + 1),
				)
				assert.deepEqual(Option.getOrThrow(Arr.last(events)).body, {
					_tag: "State",
					status: "completed",
					failure: null,
				})
			}).pipe(
				Effect.provide(Observation.layer),
				Effect.provideService(Store.Store, tracked.store),
			)
		}),
	)

	it.effect("the event log wakes a live reader when no notice is sent", () =>
		Effect.gen(function* () {
			const sql = yield* PgClient.PgClient
			const store = yield* Store.Store
			const { fence, sequence } = yield* start("observe-no-notice")
			const tracked = yield* track
			// Shadow only this transaction's notify call. The event writes stay real.
			yield* sql`create schema observation_no_notice`
			yield* sql`create table observation_no_notice.skipped (channel text not null)`
			yield* sql`create function observation_no_notice.pg_notify(text, text) returns void
				language sql as 'insert into observation_no_notice.skipped (channel) values ($1)'`
			yield* Effect.gen(function* () {
				const observation = yield* Observation.Observation
				const reading = yield* observation
					.observe(fence, sequence)
					.pipe(Stream.runCollect, Effect.forkScoped)
				yield* tracked.read((read) => read.after === sequence)
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`set local search_path = observation_no_notice, pg_catalog, public`
						yield* store.wake(fence, "saved-without-notice")
						yield* store.transition(fence, "completed")
					}),
				)
				assert.equal(
					(yield* sql`select channel from observation_no_notice.skipped`)
						.length,
					2,
				)
				yield* TestClock.adjust("1 second")
				const events = yield* Fiber.join(reading)
				assert.deepEqual(
					Arr.map(events, (event) => event.sequence),
					[sequence + 1, sequence + 2],
				)
				assert.deepEqual(
					Arr.map(events, (event) => event.body._tag),
					["Wake", "State"],
				)
			}).pipe(
				Effect.provide(Observation.layer),
				Effect.provideService(Store.Store, tracked.store),
			)
		}),
	)

	it.effect("a lost PostgreSQL listener does not lose saved events", () =>
		Effect.gen(function* () {
			const sql = yield* PgClient.PgClient
			const store = yield* Store.Store
			const { fence, sequence } = yield* start("observe-listen-loss")
			const tracked = yield* track
			yield* Effect.gen(function* () {
				const observation = yield* Observation.Observation
				const reading = yield* observation
					.observe(fence, sequence)
					.pipe(Stream.runCollect, Effect.forkScoped)
				yield* tracked.read((read) => read.after === sequence)
				const listeners = yield* sql<{ readonly pid: number }>`
					select pid from pg_stat_activity
					where datname = current_database() and query ilike 'listen %'`.pipe(
					Effect.repeat({ until: (rows) => rows.length > 0 }),
				)
				assert.equal(listeners.length, 1)
				yield* sql`select pg_terminate_backend(${listeners[0]!.pid})`
				yield* sql`select pid from pg_stat_activity
					where datname = current_database() and query ilike 'listen %'`.pipe(
					Effect.repeat({ until: (rows) => rows.length === 0 }),
				)
				yield* store.wake(fence, "saved-after-disconnect")
				yield* store.transition(fence, "completed")
				yield* TestClock.adjust("1 second")
				const events = yield* Fiber.join(reading)
				assert.deepEqual(
					Arr.map(events, (event) => event.sequence),
					[sequence + 1, sequence + 2],
				)
				assert.deepEqual(
					Arr.map(events, (event) => event.body._tag),
					["Wake", "State"],
				)
			}).pipe(
				Effect.provide(Observation.layer),
				Effect.provideService(Store.Store, tracked.store),
			)
		}),
	)

	it.effect("observers of one execution share one node reader", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const { fence, sequence } = yield* start("observe-shared")
			const tracked = yield* track
			yield* Effect.gen(function* () {
				const observation = yield* Observation.Observation
				const readers = yield* Effect.forEach(Arr.range(1, 8), () =>
					observation
						.observe(fence, sequence)
						.pipe(Stream.runDrain, Effect.forkScoped),
				)
				for (const _ of readers)
					yield* tracked.read((read) => read.after === sequence)
				// Each subscriber reads its state. Only one shared reader reads it too.
				assert.equal(yield* Ref.get(tracked.gets), readers.length + 1)
				assert.equal((yield* Ref.get(tracked.history)).length, readers.length)
				yield* TestClock.adjust("1 second")
				yield* tracked.read((read) => read.after === sequence)
				assert.equal(
					(yield* Ref.get(tracked.history)).length,
					readers.length + 1,
				)
				for (const reader of Arr.dropRight(readers, 1))
					yield* Fiber.interrupt(reader)
				yield* TestClock.adjust("1 second")
				yield* tracked.read((read) => read.after === sequence)
				assert.equal(
					(yield* Ref.get(tracked.history)).length,
					readers.length + 2,
				)
				yield* Fiber.interrupt(Arr.lastNonEmpty(readers))
				yield* TestClock.adjust("1 second")
				assert.equal(
					(yield* Ref.get(tracked.history)).length,
					readers.length + 2,
				)
				assert.equal((yield* store.get(fence)).status, "running")
			}).pipe(
				Effect.provide(Observation.layer),
				Effect.provideService(Store.Store, tracked.store),
			)
		}),
	)

	it.effect(
		"a cursor keeps model attempts apart after an observer reconnects",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const { fence } = yield* start("observe-reconnect")
				const first = yield* store.readAttempt(fence, "model", null)
				yield* store.sending(fence, first.id)
				yield* store.commit(
					fence,
					{
						events: [
							{ _tag: "Text", step: "model", attempt: 0, text: "First part" },
						],
					},
					Effect.void,
				)
				yield* Effect.gen(function* () {
					const observation = yield* Observation.Observation
					const before = yield* observation.observe(fence, 0).pipe(
						Stream.takeUntil((event) => event.body._tag === "Text"),
						Stream.runCollect,
					)
					const cursor = Option.getOrThrow(Arr.last(before)).sequence
					assert.equal((yield* store.get(fence)).status, "running")
					const owner = yield* store.takeOver(fence)
					const second = yield* store.readAttempt(owner, "model", null)
					assert.equal(second.attempt, 1)
					yield* store.sending(owner, second.id)
					yield* store.finishCall(owner, second.id, { done: true }, [
						{ _tag: "Text", step: "model", attempt: 1, text: "New reply" },
					])
					yield* store.transition(owner, "completed")
					const after = yield* Stream.runCollect(
						observation.observe(fence, cursor),
					)
					assert.deepEqual(
						Arr.map(after, (event) => event.body),
						[
							{ _tag: "StepStarted", step: "model", attempt: 1 },
							{ _tag: "Text", step: "model", attempt: 1, text: "New reply" },
							{ _tag: "StepCompleted", step: "model", attempt: 1 },
							{ _tag: "State", status: "completed", failure: null },
						],
					)
					assert.deepEqual(
						Arr.map([...before, ...after], (event) => event.sequence),
						Arr.range(1, cursor + after.length),
					)
					const terminal = Option.getOrThrow(Arr.last(after))
					assert.deepEqual(
						yield* Stream.runCollect(
							observation.observe(fence, terminal.sequence - 1),
						),
						[terminal],
					)
					assert.deepEqual(
						yield* Stream.runCollect(
							observation.observe(fence, terminal.sequence),
						),
						[],
					)
				}).pipe(Effect.provide(Observation.layer))
			}),
	)

	it.effect(
		"two real processes observe the same execution from their cursors",
		() =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const store = yield* Store.Store
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
				const { fence, sequence } = yield* start("observe-processes")
				yield* sql`create table observation_process_reads (
				node integer primary key, ready boolean not null, events jsonb)`
				const url = sql.config.url
				if (url === undefined)
					return yield* Effect.die("The test database has no URL.")
				const processes = yield* Effect.forEach([1, 2], (node) =>
					spawner.spawn(
						ChildProcess.make(
							"node",
							[
								"--disable-warning=ExperimentalWarning",
								new URL("./ExecutionObserverNode.ts", import.meta.url).pathname,
							],
							{
								extendEnv: true,
								env: {
									OBSERVE_DATABASE_URL: Redacted.value(url),
									OBSERVE_NODE: String(node),
									OBSERVE_NAMESPACE: fence.namespace,
									OBSERVE_EXECUTION_ID: fence.id,
									OBSERVE_AFTER: String(node === 1 ? 0 : sequence),
								},
								stdout: "inherit",
								stderr: "inherit",
							},
						),
					),
				)
				yield* sql`select node from observation_process_reads where ready = true`.pipe(
					Effect.repeat({ until: (rows) => rows.length === 2 }),
				)
				assert.equal((yield* store.get(fence)).status, "running")
				yield* store.wake(fence, "saved-on-another-node")
				yield* store.transition(fence, "completed")
				for (const child of processes) assert.equal(yield* child.exitCode, 0)
				const rows = yield* sql<{
					readonly node: number
					readonly events: ReadonlyArray<Execution.Event>
				}>`select node, events from observation_process_reads order by node`
				assert.deepEqual(
					Arr.map(rows[0]!.events, (event) => event.sequence),
					Arr.range(1, sequence + 2),
				)
				assert.deepEqual(
					Arr.map(rows[1]!.events, (event) => event.sequence),
					[sequence + 1, sequence + 2],
				)
				assert.deepEqual(Arr.takeRight(rows[0]!.events, 2), rows[1]!.events)
			}),
	)
})
