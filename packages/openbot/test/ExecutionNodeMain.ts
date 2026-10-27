import { Delegations } from "../src/bots/Delegations.ts"
import * as PrivateRpc from "../src/transport/PrivateRpc.ts"
import * as Observation from "../src/execution/Observation.ts"
/** This entry point is run in two separate processes by ExecutionCluster.test.ts. */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer needs the native server factory.
import { createServer } from "node:http"
import {
	NodeHttpClient,
	NodeHttpServer,
	NodeRuntime,
	NodeServices,
} from "@effect/platform-node"
import { Execution, ServiceId } from "@openbot-build/domain"
import { Billing } from "../src/billing/Billing.ts"
import * as BillingPostgres from "../src/billing/BillingPostgres.ts"
import { PgClient } from "@effect/sql-pg"
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
import { ClusterSchema, RunnerAddress, ShardingConfig } from "effect/cluster"
import { HttpRouter, HttpServer } from "effect/http"
import { Activity, DurableClock, DurableDeferred } from "effect/workflow"
import * as Runner from "../src/execution/Runner.ts"
import * as RunScope from "../src/execution/RunScope.ts"
import * as Calls from "../src/execution/Calls.ts"
import * as CallRecovery from "../src/execution/CallRecovery.ts"
import * as Records from "../src/errors/Records.ts"
import * as Engine from "../src/execution/Engine.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"

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
		const workflow = (definition: ReturnType<typeof Engine.define>) =>
			definition.toLayer(
				Effect.fn(function* (key) {
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
				}),
			)
		const register = Layer.effectDiscard(
			Effect.gen(function* () {
				const registry = yield* Engine.Registry
				const store = yield* Store.Store
				yield* registry.registerService(serviceWork, serviceId, (key) =>
					Effect.asVoid(store.loadService(key, serviceId)),
				)
				for (const workflow of [
					unknownWrite,
					work,
					approval,
					release,
					heldUsage,
				])
					yield* registry.register(workflow, () => Effect.void)
			}),
		)
		const heldUsageWorkflow = heldUsage.toLayer(
			Effect.fn(function* (key) {
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
			}),
		)
		const decisionWorkflow = approval.toLayer(
			Effect.fn(function* (key) {
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
							const store = yield* Store.Store
							yield* store
								.requestDecision(fence, "approval", ["allow", "deny"])
								.pipe(Effect.orDie)
							if (
								(yield* store.get(key).pipe(Effect.orDie)).status === "running"
							)
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
									answer.value.answer.answer === "allow"
										? "completed"
										: "failed",
								)
								.pipe(Effect.orDie)
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
		)
		const releaseWorkflow = release.toLayer(
			Effect.fn(
				function* (key) {
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
				(effect, key) =>
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
			),
		)

		const unknownWorkflow = unknownWrite.toLayer(
			Effect.fn(function* (key) {
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
										if (holdWrites && call.attempt < 2)
											return yield* Effect.never
										if (call.attempt === 0)
											return yield* Effect.fail("The reply was lost")
										return { private: "private recovery result" }
									}),
								)
								.pipe(Effect.asVoid),
						)
						.pipe(Effect.orDie)
					if (result._tag === "Failed")
						return yield* Effect.fail(result.failure)
				}
			}),
		)

		const features = Layer.mergeAll(
			TurnClusterFixture.layer.pipe(Layer.provide(Layer.mock(Delegations, {}))),
			unknownWorkflow,
			workflow(work),
			workflow(serviceWork),
			heldUsageWorkflow,
			decisionWorkflow,
			releaseWorkflow,
			register,
		)
		const services = Layer.mergeAll(
			Store.layer,
			BillingPostgres.layer,
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
					entityMessagePollInterval: Duration.millis(100),
					entityReplyPollInterval: Duration.millis(50),
				}),
			),
			Layer.provide(NodeHttpClient.layerUndici),
		)
		return HttpRouter.serve(
			Layer.mergeAll(Engine.layerRoutes, Engine.layerOutbox).pipe(
				Layer.provide(
					features.pipe(
						Layer.provide(
							Layer.mergeAll(Calls.layer, RunScope.layer, Runner.layer).pipe(
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
