// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer needs the native server factory.
import { createServer } from "node:http"
import {
	NodeHttpClient,
	NodeHttpServer,
	NodeRuntime,
	NodeServices,
} from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Execution } from "@openbot-build/domain"
import {
	Config,
	Duration,
	Effect,
	Layer,
	Option,
	Redacted,
	Schedule,
	Schema,
	String as Str,
} from "effect"
import { RunnerAddress, ShardingConfig } from "effect/cluster"
import { HttpClient, HttpRouter, HttpServer } from "effect/http"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Records from "../src/errors/Records.ts"
import * as CallRecovery from "../src/execution/CallRecovery.ts"
import * as Calls from "../src/execution/Calls.ts"
import * as Engine from "../src/execution/Engine.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as RunScope from "../src/execution/RunScope.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as PrivateRpc from "../src/transport/PrivateRpc.ts"

/** A real cluster node used only by ExecutionExternal.test.ts. */
const work = Engine.define("test-external-write")
const Input = Schema.Struct({
	point: Schema.Literals(["before_send", "after_reply"]),
	retry: Schema.Literals(["never", "idempotent"]),
})
const Reply = Schema.Struct({ effectId: Schema.Finite, private: Schema.String })

const app = Layer.unwrap(
	Effect.gen(function* () {
		const runner = yield* Config.Int("TEST_RUNNER_ID")
		const external = yield* Config.String("TEST_EXTERNAL_URL")
		const url = yield* Config.Redacted("TEST_DATABASE_URL")
		const address = (yield* HttpServer.HttpServer).address
		if (address._tag === "UnixPathAddress")
			return yield* Effect.die("The runner needs a TCP address.")
		const workflow = work.toLayer(
			Effect.fn(function* (key) {
				const store = yield* Store.Store
				const calls = yield* Calls.Calls
				const settle = yield* CallRecovery.make
				const scope = yield* RunScope.RunScope
				const sql = yield* PgClient.PgClient
				const client = yield* HttpClient.HttpClient
				const loaded = yield* store.loadMember(key).pipe(Effect.orDie)
				if (Execution.isTerminal(loaded.record.status)) return
				const input = yield* Schema.decodeUnknownEffect(Input)(
					loaded.input,
				).pipe(Effect.orDie)
				const fence = yield* store.takeOver(key).pipe(Effect.orDie)
				const pause = (point: typeof Input.Type.point, callId: string) =>
					Effect.gen(function* () {
						if (point !== input.point) return
						// Only the first owner stops here. The parent can kill it or pause its process.
						const rows = yield* sql`insert into execution_external_stops
							(execution_id, point, runner, generation, call_id)
							values (${key.id}, ${point}, ${runner}, ${fence.generation}, ${callId})
							on conflict (execution_id) do nothing returning runner`
						if (rows.length > 0)
							yield* sql<{ readonly released: boolean }>`select released
                                from execution_external_stops where execution_id = ${key.id}`.pipe(
								Effect.repeat({
									schedule: Schedule.spaced("50 millis"),
									until: (rows) => rows[0]?.released === true,
								}),
								// A stopped node may lose its database connection before it can read the gate.
								Effect.tapError((error) =>
									Effect.logWarning(
										"The test gate lost its connection.",
										error,
									),
								),
								Effect.retry({
									times: 5,
									schedule: Schedule.spaced("50 millis"),
								}),
							)
					})
				while (true) {
					if ((yield* settle(fence).pipe(Effect.orDie)).stop) {
						yield* store.transition(fence, "interrupted").pipe(Effect.orDie)
						return
					}
					const call = yield* store
						.writeAttempt(
							fence,
							"write",
							{ private: "private input" },
							input.retry,
						)
						.pipe(Effect.orDie)
					if (call.status === "completed") {
						yield* sql
							.withTransaction(
								Effect.gen(function* () {
									yield* store.transition(fence, "completed")
									yield* sql`insert into execution_external_ends (execution_id, runner, generation)
                                values (${key.id}, ${runner}, ${fence.generation})`
								}),
							)
							.pipe(Effect.orDie)
						return
					}
					const result = yield* scope
						.run(
							fence,
							`write:${call.id}`,
							calls
								.invoke(
									fence,
									call,
									(callId) =>
										Effect.gen(function* () {
											const response = yield* client.post(`${external}/write`, {
												headers: {
													"idempotency-key": callId,
													"execution-id": key.id,
													"retry-mode": input.retry,
												},
											})
											const reply = yield* response.json.pipe(
												Effect.flatMap(Schema.decodeUnknownEffect(Reply)),
											)
											// The provider has sent its result, but Calls has not saved it yet.
											yield* pause("after_reply", callId)
											return reply
											// This driver models a write that cannot be stopped after it is sent.
										}).pipe(Effect.uninterruptible),
									pause("before_send", call.id),
								)
								.pipe(Effect.asVoid),
						)
						.pipe(Effect.orDie)
					if (result._tag === "Failed") {
						yield* store
							.transition(fence, "failed", result.failure)
							.pipe(Effect.orDie)
						return
					}
				}
			}),
		)
		const register = Layer.effectDiscard(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				yield* (yield* Engine.Registry).register(work, (key) =>
					Effect.gen(function* () {
						const denied =
							yield* sql`select execution_id from execution_external_denied where execution_id = ${key.id}`.pipe(
								Effect.mapError((cause) =>
									Execution.StorageError.make({ cause }),
								),
							)
						if (denied.length > 0) return yield* Execution.Forbidden.make({})
					}),
				)
				yield* (yield* PgClient.PgClient)`insert into execution_external_nodes (runner)
					values (${runner}) on conflict do nothing`.pipe(Effect.orDie)
			}),
		)
		const services = Layer.mergeAll(
			Store.layer,
			Records.layer,
			Engine.layer,
		).pipe(
			Layer.provide(
				Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
			),
			Layer.provideMerge(DatabasePostgres.layer({ databaseUrl: url })),
			Layer.provide(
				ShardingConfig.layer({
					runnerAddress: Option.some(
						RunnerAddress.make("127.0.0.1", address.port),
					),
					shardsPerGroup: 10,
					shardLockRefreshInterval: Duration.millis(250),
					shardLockExpiration: Duration.seconds(1),
					refreshAssignmentsInterval: Duration.millis(250),
					runnerHealthCheckInterval: Duration.millis(250),
					entityMessagePollInterval: Duration.millis(100),
					entityReplyPollInterval: Duration.millis(50),
				}),
			),
			Layer.provideMerge(NodeHttpClient.layerUndici),
		)
		return HttpRouter.serve(
			Layer.mergeAll(Engine.layerRoutes, Engine.layerOutbox).pipe(
				Layer.provide(
					Layer.mergeAll(workflow, register).pipe(
						Layer.provide(
							Layer.mergeAll(Calls.layer, RunScope.layer).pipe(
								Layer.provide(Observation.layer),
							),
						),
					),
				),
				Layer.provideMerge(Engine.layerRegistry),
				Layer.provide(services),
			),
		).pipe(
			Layer.provide(
				Layer.succeed(PrivateRpc.Secret, Redacted.make("test-cluster-secret")),
			),
		)
	}),
)

Layer.launch(
	app.pipe(
		Layer.provide(
			NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }),
		),
		Layer.provide(NodeServices.layer),
	),
).pipe(NodeRuntime.runMain)
