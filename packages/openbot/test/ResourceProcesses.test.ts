import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import {
	Deferred,
	Effect,
	Fiber,
	Layer,
	Redacted,
	Schedule,
	Schema,
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Resource from "../src/resources/Resource.ts"
import * as Network from "./ResourceNetwork.ts"
import * as PostgresTest from "./PostgresTest.ts"

const modes = [
	"owner exit",
	"delayed close",
	"lost reply",
	"database cut",
	"late old close",
] as const
const Reply = Schema.Union([Schema.TaggedStruct("Closed", {}), Resource.Error])
const waitFor = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	until: (value: A) => boolean,
) =>
	effect.pipe(
		Effect.repeat({ schedule: Schedule.spaced("50 millis"), until }),
		Effect.timeout("15 seconds"),
	)

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
	for (const mode of modes)
		it.effect(
			`two resource processes keep the close result after ${mode}`,
			() =>
				Effect.gen(function* () {
					const database = yield* PostgresTest.start
					const physical = yield* Network.physical
					const databaseProxy = yield* Network.proxy(
						Number(new URL(database.url).port),
					)
					const ownerPort = yield* PostgresTest.freePort
					const clientPort = yield* PostgresTest.freePort
					const rpcProxy = yield* Network.proxy(ownerPort)
					const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
					const run = Effect.gen(function* () {
						yield* DatabasePostgres.migrate
						const sql = yield* PgClient.PgClient
						yield* sql`create table resource_test_nodes (runner integer primary key, port integer not null)`
						yield* sql`create table resource_test_close (hold boolean not null)`
						yield* sql`insert into resource_test_close (hold) values (${mode === "delayed close" || mode === "late old close"})`
						const proxied = new URL(database.url)
						proxied.port = String(databaseProxy.port)
						const spawn = (
							runner: number,
							port: number,
							advertised: number,
							url: string,
						) =>
							spawner.spawn(
								ChildProcess.make(
									"node",
									[
										"--disable-warning=ExperimentalWarning",
										new URL("./ResourceNodeMain.ts", import.meta.url).pathname,
									],
									{
										extendEnv: true,
										env: {
											TEST_RUNNER_ID: String(runner),
											TEST_SERVER_PORT: String(port),
											TEST_ADVERTISE_PORT: String(advertised),
											TEST_PHYSICAL_PORT: String(physical.port),
											TEST_DATABASE_URL: url,
										},
										killSignal: "SIGKILL",
										stdout: "inherit",
										stderr: "inherit",
									},
								),
							)
						const owner = yield* spawn(
							1,
							ownerPort,
							rpcProxy.port,
							proxied.toString(),
						)
						yield* spawn(2, clientPort, clientPort, database.url)
						yield* waitFor(
							sql`select runner from resource_test_nodes`,
							(rows) => rows.length === 2,
						)
						yield* waitFor(physical.counts, (count) => count.opened === 1)
						const http = yield* HttpClient.HttpClient
						const release = http
							.post(`http://127.0.0.1:${clientPort}/release`, {
								headers: { authorization: "Bearer resource-test" },
							})
							.pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Reply)))
						const saved = sql<{
							readonly result: string | null
						}>`select result from openbot_resource_leases where namespace = 'process-test'`
						if (mode === "owner exit") {
							yield* owner.kill({ killSignal: "SIGKILL" })
							yield* waitFor(physical.counts, (count) => count.closed === 1)
							const result = yield* release
							assert.equal(result._tag, "ResourceFailed")
							if (result._tag === "ResourceFailed") {
								assert.equal(result.outcome, "unknown")
								assert.isAbove(result.failure.errorId.length, 0)
							}
							assert.isNull((yield* saved)[0]?.result)
							return
						}
						if (mode === "late old close") {
							const first = yield* sql<{
								readonly lease: string
							}>`select lease from openbot_resource_owners where namespace = 'process-test'`
							yield* http.post(`http://127.0.0.1:${clientPort}/replace`, {
								headers: { authorization: "Bearer resource-test" },
							})
							yield* waitFor(physical.counts, (count) => count.opened === 2)
							assert.equal((yield* physical.counts).closed, 0)
							const current = yield* sql<{
								readonly lease: string
							}>`select lease from openbot_resource_owners where namespace = 'process-test'`
							assert.notEqual(first[0]?.lease, current[0]?.lease)
							yield* sql`update resource_test_close set hold = false`
							yield* waitFor(
								sql<{
									readonly result: string | null
								}>`select result from openbot_resource_leases where lease = ${first[0]?.lease}`,
								(rows) => rows[0]?.result !== null,
							)
							assert.deepEqual(
								yield* sql`select lease from openbot_resource_owners where namespace = 'process-test'`,
								current,
							)
							assert.equal((yield* release)._tag, "Closed")
							yield* waitFor(physical.counts, (count) => count.closed === 2)
							assert.deepEqual(yield* physical.counts, { opened: 2, closed: 2 })
							const results = yield* saved
							assert.equal(results.length, 2)
							for (const result of results)
								assert.deepEqual(
									yield* Schema.decodeEffect(
										Schema.fromJsonString(Resource.ReleaseResult),
									)(result.result ?? "null"),
									{ _tag: "Closed" },
								)
							return
						}
						if (mode === "database cut") {
							// Cut all established database sockets and reject new ones for this owner only.
							yield* databaseProxy.disconnect
							yield* waitFor(physical.counts, (count) => count.closed === 1)
							assert.isNull((yield* saved)[0]?.result)
							yield* databaseProxy.reconnect
							// The surviving node retries the saved close, not the physical action.
							const result = yield* waitFor(
								release,
								(reply) => reply._tag === "Closed",
							)
							assert.equal(result._tag, "Closed")
						} else {
							if (mode === "lost reply") yield* rpcProxy.holdReplies
							const done = yield* Deferred.make<void>()
							const pending = yield* release.pipe(
								Effect.tap(() => Deferred.succeed(done, undefined)),
								Effect.forkScoped,
							)
							if (mode === "delayed close") {
								// This is an actual process and socket delay. Release must wait beyond an RPC deadline.
								yield* Effect.sleep("6 seconds")
								assert.isFalse(yield* Deferred.isDone(done))
								assert.equal((yield* physical.counts).closed, 0)
								assert.isNull((yield* saved)[0]?.result)
								yield* sql`update resource_test_close set hold = false`
							} else {
								yield* waitFor(saved, (rows) => rows[0]?.result !== null)
								assert.isFalse(yield* Deferred.isDone(done))
								yield* owner.kill({ killSignal: "SIGKILL" })
								// Drop the delayed HTTP reply. The client must read the durable close result.
								yield* rpcProxy.disconnect
							}
							assert.equal((yield* Fiber.join(pending))._tag, "Closed")
						}
						yield* waitFor(physical.counts, (count) => count.closed === 1)
						assert.deepEqual(yield* physical.counts, { opened: 1, closed: 1 })
						assert.equal((yield* release)._tag, "Closed")
						const rows = yield* saved
						assert.equal(rows.length, 1)
						assert.deepEqual(
							yield* Schema.decodeEffect(
								Schema.fromJsonString(Resource.ReleaseResult),
							)(rows[0]?.result ?? "null"),
							{ _tag: "Closed" },
						)
					}).pipe(
						Effect.provide(
							Layer.merge(
								DatabasePostgres.layer({
									databaseUrl: Redacted.make(database.url),
								}),
								NodeHttpClient.layerUndici,
							),
						),
					)
					yield* run
				}),
			{ timeout: 45_000 },
		)
})
