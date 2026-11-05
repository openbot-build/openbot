// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer needs the native server factory.
import { createServer } from "node:http"
import {
	NodeCrypto,
	NodeHttpClient,
	NodeHttpServer,
	NodeRuntime,
	NodeServices,
} from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Execution } from "@openbot-build/domain"
import {
	Config,
	Context,
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
import { DatabasePostgres } from "@openbot-build/openbot"
import * as Records from "@openbot-build/server-kernel/errors/Records"
import * as CallRecovery from "@openbot-build/server-execution/execution/CallRecovery"
import * as Calls from "@openbot-build/server-execution/execution/Calls"
import * as Engine from "@openbot-build/server-execution/execution/Engine"
import * as Workflows from "@openbot-build/server-execution/execution/Workflows"
import * as EngineHost from "@openbot-build/server-execution/execution/EngineHost"
import * as Observation from "@openbot-build/server-execution/execution/Observation"
import * as RunScope from "@openbot-build/server-execution/execution/RunScope"
import * as Store from "@openbot-build/server-execution/execution/Store"
import * as Secrets from "@openbot-build/server-kernel/secrets/Secrets"
import * as PrivateRpc from "@openbot-build/server-execution/transport/PrivateRpc"

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
		const handler = Effect.fn(function* (key: Store.Key) {
			const store = yield* Store.Store
			const calls = yield* Calls.Calls
			const settle = yield* CallRecovery.make
			const scope = yield* RunScope.RunScope
			const sql = yield* PgClient.PgClient
			const client = yield* HttpClient.HttpClient
			const loaded = yield* store.loadMember(key).pipe(Effect.orDie)
			if (Execution.isTerminal(loaded.record.status)) return
			const input = yield* Schema.decodeUnknownEffect(Input)(loaded.input).pipe(
				Effect.orDie,
			)
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
								Effect.logWarning("The test gate lost its connection.", error),
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
		})
		const register = Layer.effectDiscard(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				// Keep only these services. The run keeps its own scope.
				const context = Context.pick(
					Store.Store,
					Calls.Calls,
					RunScope.RunScope,
					PgClient.PgClient,
					HttpClient.HttpClient,
				)(
					yield* Effect.context<
						| Store.Store
						| Calls.Calls
						| RunScope.RunScope
						| PgClient.PgClient
						| HttpClient.HttpClient
					>(),
				)
				yield* (yield* Workflows.Workflows).contribute({
					workflow: work,
					plugin: "test",
					journal: 1,
					run: (key) => handler(key).pipe(Effect.provideContext(context)),
					policy: Workflows.Policy.Public({
						authorize: (key) =>
							Effect.gen(function* () {
								const denied =
									yield* sql`select execution_id from execution_external_denied where execution_id = ${key.id}`.pipe(
										Effect.mapError((cause) =>
											Execution.StorageError.make({ cause }),
										),
									)
								if (denied.length > 0)
									return yield* Execution.Forbidden.make({})
							}),
					}),
				})
			}),
		).pipe(Layer.orDie)
		/** The node says it is ready only after its engine has started. */
		const ready = Layer.effectDiscard(
			Effect.flatMap(
				PgClient.PgClient,
				(sql) => sql`insert into execution_external_nodes (runner)
					values (${runner}) on conflict do nothing`,
			).pipe(Effect.orDie),
		)
		const services = Layer.mergeAll(Store.layer, Records.layer).pipe(
			Layer.provide(
				Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
			),
			Layer.provideMerge(DatabasePostgres.layer({ databaseUrl: url })),
			// The engine generation reads the same config.
			Layer.provideMerge(
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
			Layer.mergeAll(
				EngineHost.layerRoutes,
				ready.pipe(
					Layer.provide(EngineHost.layer.pipe(Layer.provide(register))),
				),
			).pipe(
				Layer.provide(
					Layer.mergeAll(Calls.layer, RunScope.layer).pipe(
						Layer.provide(Observation.layer),
					),
				),
				Layer.provideMerge(
					Layer.mergeAll(Workflows.layer, EngineHost.layerRpc),
				),
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
		Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
	),
).pipe(NodeRuntime.runMain)
