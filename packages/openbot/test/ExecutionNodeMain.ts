import { Delegations } from "@openbot-build/conversation-contract/bots/Delegations"
import * as PrivateRpc from "@openbot-build/server-execution/transport/PrivateRpc"
import * as Observation from "@openbot-build/server-execution/execution/Observation"
/** This entry point is run in two separate processes by ExecutionCluster.test.ts. */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer needs the native server factory.
import { createServer } from "node:http"
import {
	NodeCrypto,
	NodeHttpClient,
	NodeHttpServer,
	NodeRuntime,
	NodeServices,
} from "@effect/platform-node"
import { Execution, ServiceId } from "@openbot-build/domain"
import { Billing } from "@openbot-build/server-billing/billing/Billing"
import * as BillingPostgres from "@openbot-build/server-billing/billing/BillingPostgres"
import { PgClient } from "@effect/sql-pg"
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
	type Scope,
	String as Str,
} from "effect"
import { ClusterSchema, RunnerAddress, ShardingConfig } from "effect/cluster"
import { HttpRouter, HttpServer } from "effect/http"
import {
	Activity,
	DurableClock,
	DurableDeferred,
	type WorkflowEngine,
} from "effect/workflow"
import * as Runner from "@openbot-build/server-execution/execution/Runner"
import * as RunScope from "@openbot-build/server-execution/execution/RunScope"
import * as Calls from "@openbot-build/server-execution/execution/Calls"
import * as CallRecovery from "@openbot-build/server-execution/execution/CallRecovery"
import * as Records from "@openbot-build/server-kernel/errors/Records"
import * as Engine from "@openbot-build/server-execution/execution/Engine"
import * as Workflows from "@openbot-build/server-execution/execution/Workflows"
import * as EngineHost from "@openbot-build/server-execution/execution/EngineHost"
import * as Store from "@openbot-build/server-execution/execution/Store"
import * as Secrets from "@openbot-build/server-kernel/secrets/Secrets"
import * as DatabasePostgres from "../src/app/DatabasePostgres.ts"

import * as TurnClusterFixture from "./TurnClusterFixture.ts"

const work = Engine.define("test-durable")
const serviceWork = Engine.define("test-service")
const serviceId = ServiceId.make("test-service")
const approval = Engine.define("test-decision")
const release = Engine.define("test-release")
const heldUsage = Engine.define("test-held-usage")
const unknownWrite = Engine.define("test-unknown-write")

const app = Layer.unwrap(
	Effect.gen(function* () {
		const runner = yield* Config.Int("TEST_RUNNER_ID")
		// Bind port zero before publishing the actual address. A port probe has a race.
		const address = (yield* HttpServer.HttpServer).address
		if (address._tag === "UnixPathAddress")
			return yield* Effect.die("The runner needs a TCP address")
		const url = yield* Config.Redacted("TEST_DATABASE_URL")
		const durable = (definition: ReturnType<typeof Engine.define>) =>
			Effect.fn(function* (key: Store.Key) {
				const owner = yield* Store.Store
				if (definition._tag === serviceWork._tag)
					yield* owner.loadService(key, serviceId).pipe(Effect.orDie)
				else yield* owner.loadMember(key).pipe(Effect.orDie)
				if (
					Execution.isTerminal(
						(yield* owner.get(key).pipe(Effect.orDie)).status,
					)
				)
					return
				const fence = yield* owner.takeOver(key).pipe(Effect.orDie)
				const scope = yield* RunScope.RunScope
				const outcome = yield* scope
					.run(
						fence,
						"main",
						Effect.gen(function* () {
							yield* (yield* Calls.Calls).authorize(fence).pipe(Effect.orDie)
							const sql = yield* PgClient.PgClient
							const step = (name: string) =>
								Activity.make({
									name,
									success: Schema.Void,
									execute:
										sql`insert into execution_test_steps (execution_id, step, count, runner)
				values (${key.id}, ${name}, 1, ${runner})
				on conflict (execution_id, step) do update set count = execution_test_steps.count + 1`.pipe(
											Effect.asVoid,
											Effect.orDie,
										),
								}).annotate(ClusterSchema.WithTransaction, true)
							yield* step("first")
							yield* DurableClock.sleep({
								name: "pause",
								duration: "4 seconds",
								inMemoryThreshold: 0,
							})
							if (definition._tag === serviceWork._tag)
								yield* DurableDeferred.await(Engine.signal("continue"))
							yield* step("second")
						}),
					)
					.pipe(Effect.orDie)

				if (outcome._tag === "Cancelled")
					yield* owner
						.finishCancellation(fence, outcome.epoch)
						.pipe(Effect.orDie)
				else if (
					!Execution.isTerminal(
						(yield* owner.get(key).pipe(Effect.orDie)).status,
					)
				)
					yield* owner
						.transition(
							fence,
							outcome._tag === "Failed" ? "failed" : "completed",
							outcome._tag === "Failed" ? outcome.failure : undefined,
						)
						.pipe(Effect.orDie)
			})
		const heldUsageWorkflow = Effect.fn(function* (key: Store.Key) {
			const owner = yield* Store.Store
			const executionRunner = yield* Runner.Runner
			return yield* executionRunner
				.run(
					key,
					(fence) =>
						Effect.gen(function* () {
							const scope = yield* RunScope.RunScope
							const outcome = yield* scope
								.run(
									fence,
									"main",
									Effect.gen(function* () {
										const billing = yield* Billing
										const sql = yield* PgClient.PgClient
										const call = yield* owner.readAttempt(
											fence,
											"held-model",
											null,
										)
										yield* owner.sending(fence, call.id)
										yield* billing
											.reserve(
												{
													organizationId: "org",
													providerId: "provider",
													providerOwner: "organization",
													modelId: "model",
												},
												{ source: "turn" },
												{
													inputUncached: 1000,
													inputCacheRead: 0,
													inputCacheWrite: 0,
													outputText: 0,
													outputReasoning: 0,
												},
												{
													id: call.id,
													generation: fence.generation,
													executionId: key.id,
												},
											)
											.pipe(Effect.orDie)
										yield* sql`insert into execution_test_steps (execution_id, step, count, runner) values (${key.id}, 'reserved', 1, ${runner}) on conflict do nothing`.pipe(
											Effect.orDie,
										)
										yield* DurableClock.sleep({
											name: "wait",
											duration: "60 seconds",
											inMemoryThreshold: 0,
										})
									}),
								)
								.pipe(Effect.orDie)

							if (outcome._tag === "Cancelled")
								yield* owner
									.finishCancellation(fence, outcome.epoch)
									.pipe(Effect.orDie)
							else if (
								!Execution.isTerminal(
									(yield* owner.get(key).pipe(Effect.orDie)).status,
								)
							)
								yield* owner
									.transition(
										fence,
										outcome._tag === "Failed" ? "failed" : "completed",
										outcome._tag === "Failed" ? outcome.failure : undefined,
									)
									.pipe(Effect.orDie)
						}),
					(fence, failure) => owner.transition(fence, "failed", failure),
				)
				.pipe(Effect.orDie)
		})
		const decisionWorkflow = Effect.fn(function* (key: Store.Key) {
			const owner = yield* Store.Store
			if (
				Execution.isTerminal((yield* owner.get(key).pipe(Effect.orDie)).status)
			)
				return
			const fence = yield* owner.takeOver(key).pipe(Effect.orDie)
			const scope = yield* RunScope.RunScope
			const outcome = yield* scope
				.run(
					fence,
					"main",
					Effect.gen(function* () {
						const store = yield* Store.Store
						yield* store
							.requestDecision(fence, "approval", ["allow", "deny"])
							.pipe(Effect.orDie)
						if ((yield* store.get(key).pipe(Effect.orDie)).status === "running")
							yield* store.transition(fence, "waiting").pipe(Effect.orDie)
						yield* DurableDeferred.await(Engine.signal("approval"))
						const answer = yield* store
							.decision(key, "approval")
							.pipe(Effect.orDie)
						if (Option.isNone(answer) || answer.value.answer === null)
							return yield* Effect.die("A signal has no saved answer.")
						yield* store.transition(fence, "running").pipe(Effect.orDie)
						yield* store
							.transition(
								fence,
								answer.value.answer.answer === "allow" ? "completed" : "failed",
							)
							.pipe(Effect.orDie)
					}),
				)
				.pipe(Effect.orDie)

			if (outcome._tag === "Cancelled")
				yield* owner.finishCancellation(fence, outcome.epoch).pipe(Effect.orDie)
			else if (
				!Execution.isTerminal((yield* owner.get(key).pipe(Effect.orDie)).status)
			)
				yield* owner
					.transition(
						fence,
						outcome._tag === "Failed" ? "failed" : "completed",
						outcome._tag === "Failed" ? outcome.failure : undefined,
					)
					.pipe(Effect.orDie)
		})
		const releaseWorkflow = Effect.fn(
			function* (key: Store.Key) {
				const owner = yield* Store.Store
				if (
					Execution.isTerminal(
						(yield* owner.get(key).pipe(Effect.orDie)).status,
					)
				)
					return
				const fence = yield* owner.takeOver(key).pipe(Effect.orDie)
				const scope = yield* RunScope.RunScope
				const outcome = yield* scope
					.run(
						fence,
						"main",
						Effect.gen(function* () {
							const sql = yield* PgClient.PgClient
							const saved = yield* owner.load(key).pipe(Effect.orDie)
							const mark = (name: string) =>
								sql`insert into execution_test_steps (execution_id, step, count, runner)
				values (${key.id}, ${name}, 1, ${runner}) on conflict do nothing`.pipe(
									Effect.orDie,
								)
							yield* Effect.acquireUseRelease(
								mark("acquired"),
								() =>
									saved.input === "fail"
										? Effect.fail("private phase failure")
										: saved.input === "hold release"
											? Effect.never
											: Effect.sleep("1 second"),
								() =>
									Effect.gen(function* () {
										yield* mark("releasing")
										if (saved.input === "hold release")
											yield* sql`select step from execution_test_steps
                                            where execution_id = ${key.id} and step = 'close'`.pipe(
												Effect.retry(Schedule.spaced("50 millis")),
												Effect.repeat({
													schedule: Schedule.spaced("50 millis"),
													until: (rows) => rows.length > 0,
												}),
												Effect.orDie,
											)
										else yield* Effect.sleep("2 seconds")
										yield* mark("released")
									}),
							)
						}),
					)
					.pipe(Effect.orDie)

				if (outcome._tag === "Cancelled")
					yield* owner
						.finishCancellation(fence, outcome.epoch)
						.pipe(Effect.orDie)
				else if (
					!Execution.isTerminal(
						(yield* owner.get(key).pipe(Effect.orDie)).status,
					)
				)
					yield* owner
						.transition(
							fence,
							outcome._tag === "Failed" ? "failed" : "completed",
							outcome._tag === "Failed" ? outcome.failure : undefined,
						)
						.pipe(Effect.orDie)
			},
			(effect, key: Store.Key) =>
				effect.pipe(
					Effect.onExit((exit) =>
						Effect.gen(function* () {
							const sql = yield* PgClient.PgClient
							yield* sql`insert into execution_test_steps (execution_id, step, count, runner)
                    select ${key.id}, ${`ended:${runner}`}, ${exit._tag === "Failure" ? 1 : 0}, ${runner}
                    where exists (select 1 from execution_test_steps where execution_id = ${key.id}
                        and step = 'released' and runner = ${runner})
                    on conflict do nothing`.pipe(Effect.orDie)
						}),
					),
				),
		)

		const unknownWorkflow = Effect.fn(function* (key: Store.Key) {
			const store = yield* Store.Store
			const calls = yield* Calls.Calls
			const settle = yield* CallRecovery.make
			const scope = yield* RunScope.RunScope
			const sql = yield* PgClient.PgClient
			const loaded = yield* store.load(key).pipe(Effect.orDie)
			if (Execution.isTerminal(loaded.record.status)) return
			const holdWrites = loaded.input === "hold writes"
			const fence = yield* store.takeOver(key).pipe(Effect.orDie)
			while (true) {
				if ((yield* settle(fence).pipe(Effect.orDie)).stop) {
					yield* store.transition(fence, "interrupted").pipe(Effect.orDie)
					return
				}
				const state = yield* store.load(key).pipe(Effect.orDie)
				if (state.record.status === "cancelling") {
					const end = yield* store
						.finishCancellation(fence, state.cancelEpoch)
						.pipe(Effect.orDie)
					if (Execution.isTerminal(end)) return
					continue
				}
				const call = yield* store
					.writeAttempt(fence, "write", { private: "private recovery input" })
					.pipe(Effect.orDie)

				if (call.status === "completed") {
					yield* store.transition(fence, "completed").pipe(Effect.orDie)
					return
				}
				// The call log holds the private output. The engine sees only a safe phase result.
				const result = yield* scope
					.run(
						fence,
						`write:${call.id}`,
						calls
							.invoke(fence, call, () =>
								Effect.gen(function* () {
									yield* sql`insert into execution_test_steps (execution_id, step, count, runner)
                            values (${key.id}, 'write', 1, ${runner})
                            on conflict (execution_id, step) do update set count = execution_test_steps.count + 1, runner = excluded.runner`
									if (holdWrites && call.attempt < 2) return yield* Effect.never
									if (call.attempt === 0)
										return yield* Effect.fail("The reply was lost")
									return { private: "private recovery result" }
								}),
							)
							.pipe(Effect.asVoid),
					)
					.pipe(Effect.orDie)
				if (result._tag === "Failed") return yield* Effect.fail(result.failure)
			}
		})

		/** Each test workflow takes its services here, when it is added. */
		const contributions = Layer.effectDiscard(
			Effect.gen(function* () {
				const workflows = yield* Workflows.Workflows
				const store = yield* Store.Store
				// Keep only these services. The run keeps its own scope.
				const context = Context.pick(
					Store.Store,
					RunScope.RunScope,
					Calls.Calls,
					PgClient.PgClient,
					Runner.Runner,
					Billing,
				)(
					yield* Effect.context<
						| Store.Store
						| RunScope.RunScope
						| Calls.Calls
						| PgClient.PgClient
						| Runner.Runner
						| Billing
					>(),
				)
				const add = (
					definition: ReturnType<typeof Engine.define>,
					run: (
						key: Store.Key,
					) => Effect.Effect<
						void,
						Execution.Failure,
						| Store.Store
						| RunScope.RunScope
						| Calls.Calls
						| PgClient.PgClient
						| Runner.Runner
						| Billing
						| WorkflowEngine.WorkflowEngine
						| WorkflowEngine.WorkflowInstance
						| Scope.Scope
					>,
					policy: Workflows.Policy,
				) =>
					workflows.contribute({
						workflow: definition,
						plugin: "test",
						journal: 1,
						run: (key) => run(key).pipe(Effect.provideContext(context)),
						policy,
					})
				const open = Workflows.Policy.Public({ authorize: () => Effect.void })
				yield* add(
					serviceWork,
					durable(serviceWork),
					Workflows.Policy.Service({
						serviceId,
						authorize: (key) =>
							Effect.asVoid(store.loadService(key, serviceId)),
					}),
				)
				yield* add(work, durable(work), open)
				yield* add(unknownWrite, unknownWorkflow, open)
				yield* add(approval, decisionWorkflow, open)
				yield* add(release, releaseWorkflow, open)
				yield* add(heldUsage, heldUsageWorkflow, open)
			}),
		).pipe(Layer.orDie)

		const features = Layer.mergeAll(
			TurnClusterFixture.layer.pipe(Layer.provide(Layer.mock(Delegations, {}))),
			contributions,
		)
		const services = Layer.mergeAll(
			Store.layer,
			BillingPostgres.layer,
			Records.layer,
		).pipe(
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
					entityMessagePollInterval: Duration.millis(100),
					entityReplyPollInterval: Duration.millis(50),
				}),
			),
			Layer.provide(NodeHttpClient.layerUndici),
		)
		return HttpRouter.serve(
			Layer.mergeAll(
				EngineHost.layerRoutes,
				EngineHost.layer.pipe(
					Layer.provide(NodeHttpClient.layerUndici),
					Layer.provide(Layer.orDie(features)),
				),
			).pipe(
				Layer.provide(
					Layer.mergeAll(Calls.layer, RunScope.layer, Runner.layer).pipe(
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
