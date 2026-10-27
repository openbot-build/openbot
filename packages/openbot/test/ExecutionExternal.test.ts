import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Redacted,
	Schedule,
	String as Str,
} from "effect"
import {
	Headers,
	HttpRouter,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as PostgresTest from "./PostgresTest.ts"

const actor = { kind: "member", organizationId: "org", userId: "user" } as const

const cases = [
	{ point: "before_send", retry: "idempotent", action: "retry" },
	{ point: "before_send", retry: "never", action: "retry" },
	{ point: "after_reply", retry: "idempotent", action: "retry" },
	{ point: "after_reply", retry: "never", action: "retry" },
	{ point: "after_reply", retry: "never", action: "late" },
	{ point: "before_send", retry: "idempotent", action: "revoke" },
] as const

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
	for (const { point, retry, action } of cases)
		it.effect(
			`a second process takes over ${retry} HTTP work at ${point} with ${action}`,
			() =>
				Effect.gen(function* () {
					const database = yield* PostgresTest.start
					const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
					const run = Effect.gen(function* () {
						yield* DatabasePostgres.migrate
						const sql = yield* PgClient.PgClient
						const store = yield* Store.Store
						yield* sql`create table execution_external_nodes (runner integer primary key)`
						yield* sql`create table execution_external_stops (
							execution_id text primary key, point text not null, runner integer not null,
							generation integer not null, call_id text not null, released boolean not null default false)`
						yield* sql`create table execution_external_ends (execution_id text primary key, runner integer not null, generation integer not null)`
						yield* sql`create table execution_external_denied (execution_id text primary key)`
						yield* sql`create table execution_external_requests (
							id integer generated always as identity primary key,
							execution_id text not null, call_id text not null)`
						yield* sql`create table execution_external_effects (
							id integer generated always as identity primary key,
							execution_id text not null, provider_key text not null unique)`
						const provider = HttpRouter.serve(
							HttpRouter.add(
								"POST",
								"/write",
								Effect.gen(function* () {
									const request = yield* HttpServerRequest.HttpServerRequest
									const executionId = Option.getOrThrow(
										Headers.get(request.headers, "execution-id"),
									)
									const callId = Option.getOrThrow(
										Headers.get(request.headers, "idempotency-key"),
									)
									const mode = Option.getOrThrow(
										Headers.get(request.headers, "retry-mode"),
									)
									const effectId = yield* sql.withTransaction(
										Effect.gen(function* () {
											const [sent] = yield* sql<{
												readonly id: number
											}>`insert into execution_external_requests
										(execution_id, call_id) values (${executionId}, ${callId}) returning id`
											if (sent === undefined)
												return yield* Effect.die("The request has no ID.")
											const providerKey =
												mode === "idempotent" ? callId : `${callId}:${sent.id}`
											yield* sql`insert into execution_external_effects (execution_id, provider_key)
										values (${executionId}, ${providerKey}) on conflict (provider_key) do nothing`
											const [saved] = yield* sql<{
												readonly id: number
											}>`select id from execution_external_effects
										where provider_key = ${providerKey}`
											if (saved === undefined)
												return yield* Effect.die("The effect has no ID.")
											return saved.id
										}),
									)
									return HttpServerResponse.jsonUnsafe({
										effectId,
										private: "private external result",
									})
								}).pipe(Effect.orDie),
							),
							{ disableLogger: true, disableListenLog: true },
						).pipe(Layer.provideMerge(NodeHttpServer.layerTest))
						const context = yield* Layer.build(provider)
						const address = Context.get(context, HttpServer.HttpServer).address
						if (address._tag === "UnixPathAddress")
							return yield* Effect.die("The provider needs TCP.")
						const spawn = (runner: number) =>
							spawner.spawn(
								ChildProcess.make(
									"node",
									[
										"--disable-warning=ExperimentalWarning",
										new URL("./ExecutionExternalNode.ts", import.meta.url)
											.pathname,
									],
									{
										extendEnv: true,
										env: {
											TEST_DATABASE_URL: `${database.url}?application_name=external-node-${runner}`,
											TEST_RUNNER_ID: String(runner),
											TEST_EXTERNAL_URL: `http://127.0.0.1:${address.port}`,
										},
										killSignal: "SIGKILL",
										stdout: "inherit",
										stderr: "inherit",
									},
								),
							)
						const first = yield* spawn(1)
						const second = yield* spawn(2)
						yield* sql`select * from execution_external_nodes`.pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: (rows) => rows.length === 2,
							}),
							Effect.timeout("20 seconds"),
						)
						const receipt = yield* store.submit(
							"external-test",
							Execution.CommandKey.make("write"),
							{
								workflow: "test-external-write",
								resource: { kind: "ExternalTest", id: "write" },
								identity: {
									owner: { organizationId: "org", userId: "user" },
									actor,
								},
								input: { point, retry },
							},
						)
						const key = {
							namespace: "external-test",
							id: receipt.executionId,
						}
						const [stop] = yield* sql<{
							readonly runner: number
							readonly generation: number
							readonly callId: string
						}>`select runner, generation, call_id as "callId"
							from execution_external_stops where execution_id = ${key.id}`.pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: (rows) => rows.length > 0,
							}),
							Effect.timeout("20 seconds"),
						)
						if (stop === undefined)
							return yield* Effect.die("The stop has no owner.")
						const [before] = yield* store.calls(key)
						assert.equal(
							before?.status,
							point === "before_send" ? "intended" : "sending",
						)
						assert.isNull(before?.result)
						const requests = () =>
							sql<{
								readonly callId: string
							}>`select call_id as "callId" from execution_external_requests where execution_id = ${key.id} order by id`
						const effects = () =>
							sql`select id from execution_external_effects where execution_id = ${key.id}`
						assert.equal(
							(yield* requests()).length,
							point === "before_send" ? 0 : 1,
						)
						assert.equal(
							(yield* effects()).length,
							point === "before_send" ? 0 : 1,
						)
						const owner = stop.runner === 1 ? first : second
						if (action === "revoke")
							yield* sql`insert into execution_external_denied (execution_id) values (${key.id})`
						if (action === "late") {
							// Pause the actual owner. Its open call can still return after takeover.
							assert.equal(
								yield* spawner.exitCode(
									ChildProcess.make("kill", ["-STOP", String(owner.pid)]),
								),
								0,
							)
							// Losing the database connection releases the old node's advisory locks.
							const disconnected =
								yield* sql`select pg_terminate_backend(pid) from pg_stat_activity
                                where application_name = ${`external-node-${stop.runner}`}`
							assert.isAbove(disconnected.length, 0)
						} else yield* owner.kill({ killSignal: "SIGKILL" })
						if (action === "revoke") {
							const denied = yield* store.get(key).pipe(
								Effect.repeat({
									schedule: Schedule.spaced("50 millis"),
									until: (value) => value.status === "failed",
								}),
								Effect.timeout("25 seconds"),
							)
							assert.equal(denied.failure?.category, "forbidden")
							assert.isAbove(
								(yield* store.load(key)).generation,
								stop.generation,
							)
							assert.equal((yield* requests()).length, 0)
							assert.equal((yield* effects()).length, 0)
							assert.equal((yield* store.calls(key))[0]?.status, "intended")
							return
						}
						if (retry === "never" && point === "after_reply") {
							yield* store.get(key).pipe(
								Effect.repeat({
									schedule: Schedule.spaced("50 millis"),
									until: (value) => value.status === "outcome_unknown",
								}),
								// A paused TCP peer needs six ten-second health probes.
								Effect.timeout(action === "late" ? "75 seconds" : "25 seconds"),
							)
							const decisionId = Execution.callDecisionId(
								Execution.CallId.make(stop.callId),
							)
							yield* store.decision(key, decisionId).pipe(
								Effect.repeat({
									schedule: Schedule.spaced("50 millis"),
									until: Option.isSome,
								}),
								Effect.timeout("10 seconds"),
							)
							assert.isAbove(
								(yield* store.load(key)).generation,
								stop.generation,
							)
							// Wake the survivor more than once. A wake is not a choice to send again.
							for (let wake = 0; wake < 3; wake++) {
								yield* store.notify(
									key,
									Execution.CommandKey.make(`wake-${wake}`),
									actor,
									`wake-${wake}`,
								)
								yield* sql`select command_id from openbot_execution_outbox where execution_id = ${key.id} and sent_at is null`.pipe(
									Effect.repeat({
										schedule: Schedule.spaced("50 millis"),
										until: (rows) => rows.length === 0,
									}),
									Effect.timeout("5 seconds"),
								)
								assert.equal((yield* requests()).length, 1)
								assert.equal((yield* store.get(key)).status, "outcome_unknown")
							}
							if (action === "late") {
								yield* sql`update execution_external_stops set released = true where execution_id = ${key.id}`
								assert.equal(
									yield* spawner.exitCode(
										ChildProcess.make("kill", ["-CONT", String(owner.pid)]),
									),
									0,
								)
							} else
								yield* store.decide(
									key,
									Execution.CommandKey.make("retry"),
									decisionId,
									"retry",
									actor,
								)
						}
						yield* store.get(key).pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: (value) => value.status === "completed",
							}),
							Effect.timeout("25 seconds"),
						)
						assert.isAbove((yield* store.load(key)).generation, stop.generation)
						const [end] = yield* sql<{
							readonly runner: number
							readonly generation: number
						}>`select runner, generation from execution_external_ends where execution_id = ${key.id}`
						// A resumed node may later own a new generation. Its old generation must not end work.
						if (action !== "late") assert.notEqual(end?.runner, stop.runner)
						assert.isAbove(end?.generation ?? 0, stop.generation)
						assert.equal(end?.generation, (yield* store.load(key)).generation)
						const sent = yield* requests()
						const saved = yield* store.calls(key)
						assert.equal(
							sent.length,
							point === "before_send" || action === "late" ? 1 : 2,
						)
						assert.equal(
							(yield* effects()).length,
							retry === "never" && point === "after_reply" && action === "retry"
								? 2
								: 1,
						)
						if (
							retry === "never" &&
							point === "after_reply" &&
							action === "retry"
						) {
							assert.notEqual(sent[0]?.callId, sent[1]?.callId)
							assert.deepEqual(
								Arr.map(saved, (call) => call.status),
								["outcome_unknown", "completed"],
							)
						} else {
							assert.isTrue(
								Arr.every(sent, (request) => request.callId === stop.callId),
							)
							assert.equal(saved.length, 1)
							assert.equal(saved[0]?.status, "completed")
						}
						const messages = yield* sql<{
							readonly payload: string | null
						}>`select payload from openbot_cluster_messages`
						assert.isFalse(
							Arr.some(messages, (message) =>
								Str.includes("private external result")(message.payload ?? ""),
							),
						)
					})
					yield* run.pipe(
						Effect.provide(
							Store.layer.pipe(
								Layer.provide(
									Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
								),
								Layer.provideMerge(
									DatabasePostgres.layer({
										databaseUrl: Redacted.make(database.url),
									}),
								),
							),
						),
					)
				}),
			{ timeout: 120_000 },
		)
})
