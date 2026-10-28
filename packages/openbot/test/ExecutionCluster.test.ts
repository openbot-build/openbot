import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { Execution, ServiceId, type WorkIdentity } from "@openbot-build/domain"
import {
	Array as Arr,
	Effect,
	Layer,
	Redacted,
	Schedule,
	String as Str,
	Option,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as PostgresTest from "./PostgresTest.ts"

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
	for (const kind of ["member", "service"] as const)
		it.effect(
			`another process takes over ${kind} work from a saved step`,
			() =>
				Effect.gen(function* () {
					const database = yield* PostgresTest.start
					const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
					const firstRunner = 1
					const secondRunner = 2
					const run = Effect.gen(function* () {
						yield* DatabasePostgres.migrate
						const sql = yield* PgClient.PgClient
						yield* sql`create table execution_test_steps (
				execution_id text not null, step text not null, count integer not null, runner integer not null,
				primary key (execution_id, step))`
						const spawn = (runner: number) =>
							spawner.spawn(
								ChildProcess.make(
									"node",
									[
										"--disable-warning=ExperimentalWarning",
										new URL("./ExecutionNodeMain.ts", import.meta.url).pathname,
									],
									{
										extendEnv: true,
										env: {
											TEST_DATABASE_URL: database.url,
											TEST_RUNNER_ID: String(runner),
										},
										stdout: "inherit",
										stderr: "inherit",
									},
								),
							)
						const store = yield* Store.Store
						const identity: WorkIdentity =
							kind === "service"
								? {
										owner: { kind: "platform" },
										actor: {
											kind: "service",
											serviceId: ServiceId.make("test-service"),
										},
									}
								: {
										owner: { organizationId: "org", userId: "user" },
										actor: {
											kind: "member",
											organizationId: "org",
											userId: "user",
										},
									}
						const receipt = yield* store.submit(
							"cluster-test",
							Execution.CommandKey.make("start"),
							{
								workflow: kind === "service" ? "test-service" : "test-durable",
								resource: { kind: "Chat", id: "test-chat" },
								identity,
								input: { secret: "this must not enter engine messages" },
							},
						)
						const cancelled = yield* store.submit(
							"cluster-test",
							Execution.CommandKey.make("cancel-before-start"),
							{
								workflow: kind === "service" ? "test-service" : "test-durable",
								resource: { kind: "Chat", id: "cancel-chat" },
								identity,
								input: null,
							},
						)
						const cancelledKey = {
							namespace: "cluster-test",
							id: cancelled.executionId,
						}
						yield* store.cancel(
							cancelledKey,
							Execution.CommandKey.make("cancel"),
							Store.commandActor(identity),
						)
						const pending = yield* store.submit(
							"cluster-test",
							Execution.CommandKey.make("decision"),
							{
								workflow: "test-decision",
								resource: { kind: "Chat", id: "decision-chat" },
								identity: {
									owner: { organizationId: "org", userId: "user" },
									actor: {
										kind: "member",
										organizationId: "org",
										userId: "user",
									},
								},
								input: null,
							},
						)
						const decisionKey = {
							namespace: "cluster-test",
							id: pending.executionId,
						}
						const first = yield* spawn(firstRunner)
						const second = yield* spawn(secondRunner)
						const rows = yield* sql<{
							readonly runner: number
						}>`select runner from execution_test_steps where execution_id = ${receipt.executionId} and step = 'first'`.pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: (rows) => rows.length > 0,
							}),
							Effect.timeout("20 seconds"),
						)
						if (kind === "service") {
							const key = { namespace: "cluster-test", id: receipt.executionId }
							const notify = store.notify(
								key,
								Execution.CommandKey.make("continue"),
								Store.commandActor(identity),
								"continue",
							)
							assert.deepEqual(yield* notify, yield* notify)
						}
						const owner = rows[0]?.runner === firstRunner ? first : second
						yield* owner.kill({ killSignal: "SIGKILL" })
						const key = { namespace: "cluster-test", id: receipt.executionId }
						const completed = yield* store.get(key).pipe(
							Effect.repeat({
								schedule: Schedule.spaced("100 millis"),
								until: (record) => record.status === "completed",
							}),
							Effect.timeout("25 seconds"),
						)
						assert.strictEqual(completed.status, "completed")
						const steps = yield* sql<{
							readonly step: string
							readonly count: number
						}>`select step, count from execution_test_steps where execution_id = ${key.id} order by step`
						assert.deepStrictEqual(steps, [
							{ step: "first", count: 1 },
							{ step: "second", count: 1 },
						])
						const cancelledState = yield* store.get(cancelledKey).pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: (state) => state.status === "cancelled",
							}),
							Effect.timeout("10 seconds"),
						)
						assert.strictEqual(cancelledState.status, "cancelled")
						assert.strictEqual(
							(yield* sql`select * from execution_test_steps where execution_id = ${cancelledKey.id}`)
								.length,
							0,
						)
						yield* store.get(decisionKey).pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: (state) => state.status === "waiting",
							}),
							Effect.timeout("10 seconds"),
						)
						yield* store.decide(
							decisionKey,
							Execution.CommandKey.make("answer"),
							"approval",
							"allow",
							{ kind: "member", organizationId: "org", userId: "user" },
						)
						const approved = yield* store.get(decisionKey).pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: (state) => state.status === "completed",
							}),
							Effect.timeout("10 seconds"),
						)
						assert.strictEqual(approved.status, "completed")
						const release = yield* store.submit(
							"cluster-test",
							Execution.CommandKey.make("release"),
							{
								workflow: "test-release",
								resource: { kind: "Chat", id: "release-chat" },
								identity: {
									owner: { organizationId: "org", userId: "user" },
									actor: {
										kind: "member",
										organizationId: "org",
										userId: "user",
									},
								},
								input: null,
							},
						)
						const releaseKey = {
							namespace: "cluster-test",
							id: release.executionId,
						}
						const waitStep = (step: string) =>
							sql`select * from execution_test_steps where execution_id = ${releaseKey.id} and step = ${step}`.pipe(
								Effect.repeat({
									schedule: Schedule.spaced("50 millis"),
									until: (rows) => rows.length > 0,
								}),
								Effect.timeout("10 seconds"),
							)
						yield* waitStep("acquired")
						yield* store.cancel(
							releaseKey,
							Execution.CommandKey.make("release-cancel"),
							{ kind: "member", organizationId: "org", userId: "user" },
						)
						yield* waitStep("releasing")
						assert.strictEqual(
							(yield* store.get(releaseKey)).status,
							"cancelling",
						)
						assert.strictEqual(
							(yield* sql`select * from execution_test_steps where execution_id = ${releaseKey.id} and step = 'released'`)
								.length,
							0,
						)
						yield* waitStep("released")
						yield* store.get(releaseKey).pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: (state) => state.status === "cancelled",
							}),
							Effect.timeout("10 seconds"),
						)
						// Restore two processes, then stop the owner of a held model reservation.
						const replacement = yield* spawn(
							rows[0]?.runner === firstRunner ? firstRunner : secondRunner,
						)
						const survivor = rows[0]?.runner === firstRunner ? second : first
						yield* sql`INSERT INTO openbot_model_providers (id, owner_kind, owner_id, kind, name, api_key, version, created_at, updated_at) VALUES ('provider', 'organization', 'org', 'openai-compat', 'Model', 'test key', 1, 0, 0)`
						yield* sql`INSERT INTO openbot_model_prices (id, provider_id, model_id, effective_from, schedule, created_by, created_at) VALUES ('price', 'provider', 'model', 0, '{"timeZone":"UTC","tiers":[{"upToInputTokens":null,"inputUncached":1000000,"inputCacheRead":0,"inputCacheWrite":0,"output":0,"outputReasoning":null}],"periods":[]}', 'root', 0)`
						const held = yield* store.submit(
							"cluster-test",
							Execution.CommandKey.make("held"),
							{
								workflow: "test-held-usage",
								resource: { kind: "Chat", id: "held-chat" },
								identity: {
									owner: { organizationId: "org", userId: "user" },
									actor: {
										kind: "member",
										organizationId: "org",
										userId: "user",
									},
								},
								input: null,
							},
						)
						const heldKey = { namespace: "cluster-test", id: held.executionId }
						const heldRows = yield* sql<{
							readonly runner: number
						}>`select runner from execution_test_steps where execution_id = ${held.executionId} and step = 'reserved'`.pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: (rows) => rows.length > 0,
							}),
							Effect.timeout("20 seconds"),
						)
						const heldOwner =
							heldRows[0]?.runner === rows[0]?.runner ? replacement : survivor
						yield* heldOwner.kill({ killSignal: "SIGKILL" })
						yield* store.cancel(
							heldKey,
							Execution.CommandKey.make("cancel-held"),
							{ kind: "member", organizationId: "org", userId: "user" },
						)
						yield* store.get(heldKey).pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: (state) => state.status === "cancelled",
							}),
							Effect.timeout("20 seconds"),
						)
						const [usage] = yield* sql<{
							readonly status: string
							readonly reserved: number
							readonly estimate: number
							readonly charged: boolean
						}>`select status, reserved_micros::int as reserved, estimated_micros::int as estimate, charged from openbot_usage_events where execution_id = ${held.executionId}`
						assert.deepStrictEqual(usage, {
							status: "unknown",
							// Keep the hold and estimate until a receipt confirms the cost.
							reserved: 1000,
							estimate: 1000,
							charged: false,
						})
						// A decision saved after the owner dies must reach the new owner.
						const restored = yield* spawn(heldRows[0]?.runner ?? firstRunner)
						const remaining = heldOwner === replacement ? survivor : replacement
						const unknown = yield* store.submit(
							"cluster-test",
							Execution.CommandKey.make("unknown"),
							{
								workflow: "test-unknown-write",
								resource: { kind: "Chat", id: "unknown-chat" },
								identity: {
									owner: { organizationId: "org", userId: "user" },
									actor: {
										kind: "member",
										organizationId: "org",
										userId: "user",
									},
								},
								input: null,
							},
						)
						const unknownKey = {
							namespace: "cluster-test",
							id: unknown.executionId,
						}
						const pendingCalls = yield* store.calls(unknownKey).pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: (calls) => calls[0]?.status === "outcome_unknown",
							}),
							Effect.timeout("20 seconds"),
						)
						const unknownCall = pendingCalls[0]
						assert.isDefined(unknownCall)
						if (unknownCall === undefined) return
						yield* store.decision(unknownKey, unknownCall.id).pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: Option.isSome,
							}),
							Effect.timeout("10 seconds"),
						)
						const [write] = yield* sql<{
							readonly runner: number
							readonly count: number
						}>`select runner, count from execution_test_steps where execution_id = ${unknownKey.id} and step = 'write'`
						assert.equal(write?.count, 1)
						yield* (
							write?.runner === heldRows[0]?.runner ? restored : remaining
						).kill({ killSignal: "SIGKILL" })
						yield* store.decide(
							unknownKey,
							Execution.CommandKey.make("retry-unknown"),
							unknownCall.id,
							"retry",
							{ kind: "member", organizationId: "org", userId: "user" },
						)
						yield* store.get(unknownKey).pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: (record) => record.status === "completed",
							}),
							Effect.timeout("25 seconds"),
						)
						const attempts = yield* store.calls(unknownKey)
						assert.equal(attempts.length, 2)
						assert.equal(attempts[0]?.status, "outcome_unknown")
						assert.equal(attempts[1]?.status, "completed")
						const [writes] = yield* sql<{
							readonly count: number
						}>`select count from execution_test_steps where execution_id = ${unknownKey.id} and step = 'write'`
						assert.equal(writes?.count, 2)
						const restoredCancel = yield* spawn(write?.runner ?? firstRunner)
						const otherCancel =
							write?.runner === heldRows[0]?.runner ? remaining : restored
						// A result saved by this process must wake the owner without a decision signal.
						for (const cancel of [false, true]) {
							const late = yield* store.submit(
								"cluster-test",
								Execution.CommandKey.make(`late-${cancel}`),
								{
									workflow: "test-unknown-write",
									resource: { kind: "Chat", id: `late-chat-${cancel}` },
									identity: {
										owner: { organizationId: "org", userId: "user" },
										actor: {
											kind: "member",
											organizationId: "org",
											userId: "user",
										},
									},
									input: cancel ? "hold writes" : null,
								},
							)
							const lateKey = {
								namespace: "cluster-test",
								id: late.executionId,
							}
							yield* sql`select * from execution_test_steps where execution_id = ${lateKey.id} and step = 'write'`.pipe(
								Effect.repeat({
									schedule: Schedule.spaced("50 millis"),
									until: (rows) => rows.length > 0,
								}),
								Effect.timeout("20 seconds"),
							)
							if (cancel)
								yield* store.cancel(
									lateKey,
									Execution.CommandKey.make("cancel-late"),
									{
										kind: "member",
										organizationId: "org",
										userId: "user",
									},
								)
							yield* store.get(lateKey).pipe(
								Effect.repeat({
									schedule: Schedule.spaced("50 millis"),
									until: (row) => row.status === "outcome_unknown",
								}),
								Effect.timeout("10 seconds"),
							)
							const call = Option.getOrThrow(
								Arr.head(yield* store.calls(lateKey)),
							)
							const state = yield* store.load(lateKey)
							assert.isFalse(
								yield* store.finishCall(
									{ ...lateKey, generation: state.generation },
									call.id,
									{ saved: true },
								),
							)
							const end = yield* store.get(lateKey).pipe(
								Effect.repeat({
									schedule: Schedule.spaced("50 millis"),
									until: (row) => Execution.isTerminal(row.status),
								}),
								Effect.timeout("10 seconds"),
							)
							assert.equal(end.status, cancel ? "cancelled" : "completed")
							const [writes] = yield* sql<{
								readonly count: number
							}>`select count from execution_test_steps where execution_id = ${lateKey.id} and step = 'write'`
							assert.equal(writes?.count, 1)
							assert.lengthOf(yield* store.calls(lateKey), 1)
						}
						const cancelWrite = yield* store.submit(
							"cluster-test",
							Execution.CommandKey.make("cancel-write"),
							{
								workflow: "test-unknown-write",
								resource: { kind: "Chat", id: "cancel-write-chat" },
								identity: {
									owner: { organizationId: "org", userId: "user" },
									actor: {
										kind: "member",
										organizationId: "org",
										userId: "user",
									},
								},
								input: "hold writes",
							},
						)
						const cancelWriteKey = {
							namespace: "cluster-test",
							id: cancelWrite.executionId,
						}
						const waitWrites = (count: number) =>
							sql<{ readonly runner: number; readonly count: number }>`
                        select runner, count from execution_test_steps where execution_id = ${cancelWriteKey.id} and step = 'write'`.pipe(
								Effect.repeat({
									schedule: Schedule.spaced("50 millis"),
									until: (rows) => rows[0]?.count === count,
								}),
								Effect.timeout("20 seconds"),
							)
						const stopWrite = (name: string) =>
							Effect.gen(function* () {
								yield* store.cancel(
									cancelWriteKey,
									Execution.CommandKey.make(name),
									{ kind: "member", organizationId: "org", userId: "user" },
								)
								yield* store.get(cancelWriteKey).pipe(
									Effect.repeat({
										schedule: Schedule.spaced("50 millis"),
										until: (value) => value.status === "outcome_unknown",
									}),
									Effect.timeout("20 seconds"),
								)
								const calls = yield* store.calls(cancelWriteKey)
								const call = calls[calls.length - 1]
								assert.isDefined(call)
								if (call === undefined)
									return yield* Effect.die("A stopped write has no call.")
								yield* store
									.decision(
										cancelWriteKey,
										Execution.callDecisionId(
											call.id,
											(yield* store.load(cancelWriteKey)).cancelEpoch,
										),
									)
									.pipe(
										Effect.repeat({
											schedule: Schedule.spaced("50 millis"),
											until: Option.isSome,
										}),
										Effect.timeout("10 seconds"),
									)
								return call
							})
						const [firstWrite] = yield* waitWrites(1)
						const stopped = yield* stopWrite("stop-write")
						// Cancellation must leave a live workflow which can wait on another node.
						yield* (
							firstWrite?.runner === write?.runner
								? restoredCancel
								: otherCancel
						).kill({ killSignal: "SIGKILL" })
						yield* store.decide(
							cancelWriteKey,
							Execution.CommandKey.make("retry-stopped"),
							Execution.callDecisionId(
								stopped.id,
								(yield* store.load(cancelWriteKey)).cancelEpoch,
							),
							"retry",
							{ kind: "member", organizationId: "org", userId: "user" },
						)
						yield* waitWrites(2)
						assert.equal((yield* store.get(cancelWriteKey)).status, "running")
						// Send the old outbox command again after retry. It must retain epoch 1.
						yield* sql`update openbot_execution_outbox set sent_at = null, retry_at = 0
                        where command_id in (select id from openbot_execution_commands
                            where execution_id = ${cancelWriteKey.id} and key = 'stop-write')`
						yield* sql<{
							readonly sent: boolean
						}>`select sent_at is not null as sent from openbot_execution_outbox
                        where command_id in (select id from openbot_execution_commands
                            where execution_id = ${cancelWriteKey.id} and key = 'stop-write')`.pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: (rows) => rows[0]?.sent === true,
							}),
							Effect.timeout("10 seconds"),
						)
						assert.equal((yield* store.get(cancelWriteKey)).status, "running")
						const stoppedAgain = yield* stopWrite("stop-write-again")
						assert.equal((yield* store.load(cancelWriteKey)).cancelEpoch, 2)
						yield* store.decide(
							cancelWriteKey,
							Execution.CommandKey.make("retry-stopped-again"),
							Execution.callDecisionId(
								stoppedAgain.id,
								(yield* store.load(cancelWriteKey)).cancelEpoch,
							),
							"retry",
							{ kind: "member", organizationId: "org", userId: "user" },
						)
						yield* store.get(cancelWriteKey).pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: (value) => value.status === "completed",
							}),
							Effect.timeout("25 seconds"),
						)
						yield* waitWrites(3)
						const cancelAttempts = yield* store.calls(cancelWriteKey)
						assert.deepStrictEqual(
							Arr.map(cancelAttempts, (call) => call.status),
							["outcome_unknown", "outcome_unknown", "completed"],
						)

						const failed = yield* store.submit(
							"cluster-test",
							Execution.CommandKey.make("work-failure"),
							{
								workflow: "test-release",
								resource: { kind: "Chat", id: "failed-chat" },
								identity: {
									owner: { organizationId: "org", userId: "user" },
									actor: {
										kind: "member",
										organizationId: "org",
										userId: "user",
									},
								},
								input: "fail",
							},
						)
						const failure = yield* store
							.get({ namespace: "cluster-test", id: failed.executionId })
							.pipe(
								Effect.repeat({
									schedule: Schedule.spaced("50 millis"),
									until: (value) => value.status === "failed",
								}),
								Effect.timeout("10 seconds"),
							)
						assert.isNotNull(failure.failure)
						const failedRelease =
							yield* sql`select * from execution_test_steps where execution_id = ${failed.executionId} and step = 'released'`
						assert.equal(failedRelease.length, 1)
						const activities = yield* sql<{ readonly payload: string }>`
                        select payload from openbot_cluster_messages
                        where tag = 'activity' and payload like '%work:%'`
						assert.isAbove(activities.length, 0)
						const activityResults = yield* sql<{ readonly payload: string }>`
                        select reply.payload from openbot_cluster_replies reply
                        join openbot_cluster_messages message on message.id = reply.request_id
                        where message.tag = 'activity' and message.payload like '%work:%'`
						assert.isTrue(
							Arr.some(activityResults, (row) =>
								Str.includes('"Failed"')(row.payload),
							),
						)

						const messages = yield* sql<{
							readonly payload: string | null
						}>`select payload from openbot_cluster_messages
                        union all select payload from openbot_cluster_replies`
						for (const message of messages)
							assert.isFalse(
								Str.includes("private phase failure")(message.payload ?? ""),
							)
						for (const message of messages)
							assert.isFalse(
								Str.includes("private recovery")(message.payload ?? ""),
							)
						for (const message of messages)
							assert.isFalse(
								Str.includes("this must not enter engine messages")(
									message.payload ?? "",
								),
							)
					})
					yield* run.pipe(
						Effect.provide(
							Store.layer.pipe(
								Layer.provideMerge(
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
	it.effect(
		"a new owner finishes cancellation while the old Activity closes",
		() =>
			Effect.gen(function* () {
				const database = yield* PostgresTest.start
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
				const run = Effect.gen(function* () {
					yield* DatabasePostgres.migrate
					const sql = yield* PgClient.PgClient
					const store = yield* Store.Store
					yield* sql`create table execution_test_steps (
                        execution_id text not null, step text not null,
                        count integer not null, runner integer not null,
                        primary key (execution_id, step))`
					const spawn = (runner: number) =>
						spawner.spawn(
							ChildProcess.make(
								"node",
								[
									"--disable-warning=ExperimentalWarning",
									new URL("./ExecutionNodeMain.ts", import.meta.url).pathname,
								],
								{
									extendEnv: true,
									env: {
										TEST_DATABASE_URL: `${database.url}?application_name=activity-node-${runner}`,
										TEST_RUNNER_ID: String(runner),
									},
									killSignal: "SIGKILL",
									stdout: "inherit",
									stderr: "inherit",
								},
							),
						)
					const first = yield* spawn(1)
					const second = yield* spawn(2)
					const actor = {
						kind: "member",
						organizationId: "org",
						userId: "user",
					} as const
					const receipt = yield* store.submit(
						"cluster-test",
						Execution.CommandKey.make("hold-close"),
						{
							workflow: "test-release",
							resource: { kind: "Chat", id: "held-release" },
							identity: {
								owner: { organizationId: "org", userId: "user" },
								actor,
							},
							input: "hold release",
						},
					)
					const key = { namespace: "cluster-test", id: receipt.executionId }
					const waitStep = (step: string) =>
						sql<{
							readonly runner: number
						}>`select runner from execution_test_steps
                            where execution_id = ${key.id} and step = ${step}`.pipe(
							Effect.repeat({
								schedule: Schedule.spaced("50 millis"),
								until: (rows) => rows.length > 0,
							}),
							Effect.timeout("20 seconds"),
						)
					const [acquired] = yield* waitStep("acquired")
					if (acquired === undefined)
						return yield* Effect.die("The resource has no owner.")
					yield* store.cancel(key, Execution.CommandKey.make("cancel"), actor)
					yield* waitStep("releasing")
					const before = yield* store.load(key)
					assert.equal(before.record.status, "cancelling")
					const old = acquired.runner === 1 ? first : second
					assert.equal(
						yield* spawner.exitCode(
							ChildProcess.make("kill", ["-STOP", String(old.pid)]),
						),
						0,
					)
					const disconnected = yield* sql<{
						readonly stopped: boolean
					}>`select pg_terminate_backend(pid) as stopped
                        from pg_stat_activity
                        where application_name = ${`activity-node-${acquired.runner}`}`
					assert.isAbove(disconnected.length, 0)
					assert.isTrue(Arr.every(disconnected, (row) => row.stopped))
					const after = yield* store.load(key).pipe(
						Effect.repeat({
							schedule: Schedule.spaced("100 millis"),
							until: (state) => state.record.status === "cancelled",
						}),
						// A paused TCP peer needs six ten-second health probes.
						Effect.timeout("75 seconds"),
					)
					assert.isAbove(after.generation, before.generation)
					assert.equal(
						(yield* sql`select step from execution_test_steps
                            where execution_id = ${key.id} and step = 'released'`)
							.length,
						0,
					)
					yield* sql`insert into execution_test_steps (execution_id, step, count, runner)
                        values (${key.id}, 'close', 1, 0)`
					assert.equal(
						yield* spawner.exitCode(
							ChildProcess.make("kill", ["-CONT", String(old.pid)]),
						),
						0,
					)
					yield* waitStep("released")
					yield* waitStep(`ended:${acquired.runner}`)
					const ended = yield* store.load(key)
					assert.equal(ended.record.status, "cancelled")
					assert.equal(ended.generation, after.generation)
					assert.equal(ended.record.failure, null)
				})
				yield* run.pipe(
					Effect.provide(
						Store.layer.pipe(
							Layer.provideMerge(
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
