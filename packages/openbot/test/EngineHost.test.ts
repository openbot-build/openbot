// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layer needs a function that makes a Node HTTP server.
import { createServer } from "node:http"
import {
	NodeCrypto,
	NodeHttpClient,
	NodeHttpServer,
	NodeServices,
} from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	Layer,
	Option,
	Redacted,
	Ref,
	Scope,
	String as Str,
} from "effect"
import { RunnerAddress, RunnerStorage, ShardingConfig } from "effect/cluster"
import { HttpClient, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"
import { WorkflowEngine } from "effect/workflow"
import * as Database from "../src/app/DatabasePostgres.ts"
import * as Engine from "@openbot-build/server-execution/execution/Engine"
import * as EngineHost from "@openbot-build/server-execution/execution/EngineHost"
import * as Store from "@openbot-build/server-execution/execution/Store"
import * as Workflows from "@openbot-build/server-execution/execution/Workflows"
import * as PrivateRpc from "@openbot-build/server-execution/transport/PrivateRpc"
import * as Records from "@openbot-build/server-kernel/errors/Records"
import * as Secrets from "@openbot-build/server-kernel/secrets/Secrets"
import * as PostgresTest from "./PostgresTest.ts"

const database = Layer.effectDiscard(Database.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				Database.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = Layer.mergeAll(Store.layer, Records.layer).pipe(
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	Layer.provideMerge(database),
	Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
)
const actor = { kind: "member", organizationId: "org", userId: "user" } as const
const submit = Effect.fn(function* (namespace: string, workflow: string) {
	const store = yield* Store.Store
	const receipt = yield* store.submit(
		namespace,
		Execution.CommandKey.make("start"),
		{
			workflow,
			resource: { kind: "Chat", id: namespace },
			identity: { owner: actor, actor },
			input: null,
		},
	)
	return { namespace, id: receipt.executionId }
})
const open = Workflows.Policy.Public({ authorize: () => Effect.void })

const secret = Layer.succeed(
	PrivateRpc.Secret,
	Redacted.make("test-cluster-secret"),
)
/** Short times keep the cluster tests fast. A missing type gets only 100 ms. */
const fast = {
	shardsPerGroup: 10,
	shardLockRefreshInterval: Duration.millis(250),
	shardLockExpiration: Duration.seconds(1),
	refreshAssignmentsInterval: Duration.millis(250),
	entityMessagePollInterval: Duration.millis(100),
	entityReplyPollInterval: Duration.millis(50),
	entityRegistrationTimeout: Duration.millis(100),
} as const
/** Hosts one workflow that ends at once. */
const peer = Engine.define("engine-host-peer")
const hostPeer = Layer.effectDiscard(
	Effect.flatMap(Workflows.Workflows, (workflows) =>
		workflows.contribute({
			workflow: peer,
			plugin: "test",
			journal: 1,
			run: () => Effect.void,
			policy: open,
		}),
	),
).pipe(Layer.orDie)
/**
 * Opens a cluster of one generation and one client in the current scope. The
 * RPC route of the server never gets the handler of the generation, so every
 * call to the runner answers 503 with an empty body. The client gives the
 * status of each answer it gets.
 */
const cluster = Effect.gen(function* () {
	const statuses = yield* Ref.make<ReadonlyArray<number>>([])
	const served = yield* Layer.build(
		HttpRouter.serve(EngineHost.layerRoutes, {
			disableLogger: true,
			disableListenLog: true,
		}).pipe(
			Layer.provide(EngineHost.layerRpc),
			Layer.provide(secret),
			Layer.provideMerge(
				NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }),
			),
		),
	)
	const address = Context.get(served, HttpServer.HttpServer).address
	if (address._tag === "UnixPathAddress")
		return yield* Effect.die("The runner needs a TCP address.")
	yield* Layer.build(
		EngineHost.layer.pipe(
			Layer.provide(hostPeer),
			Layer.provideMerge(Layer.merge(Workflows.layer, EngineHost.layerRpc)),
			Layer.provide(
				ShardingConfig.layer({
					runnerAddress: Option.some(
						RunnerAddress.make("127.0.0.1", address.port),
					),
					...fast,
				}),
			),
			Layer.provide(NodeHttpClient.layerUndici),
			Layer.provide(secret),
		),
	)
	const client = yield* Layer.build(
		Engine.layer.pipe(
			Layer.provide(
				ShardingConfig.layer({ runnerAddress: Option.none(), ...fast }),
			),
			Layer.provide(
				Layer.effect(
					HttpClient.HttpClient,
					Effect.map(HttpClient.HttpClient, (client) =>
						HttpClient.tap(client, (response) =>
							Ref.update(statuses, Arr.append(response.status)),
						),
					),
				).pipe(Layer.provide(NodeHttpClient.layerUndici)),
			),
			Layer.provide(secret),
		),
	)
	return {
		statuses,
		engine: Context.get(client, WorkflowEngine.WorkflowEngine),
	}
})

/** Waits on the real clock until the check gives a value. */
const until = <A, E, R>(check: Effect.Effect<Option.Option<A>, E, R>) =>
	Effect.gen(function* () {
		while (true) {
			const found = yield* check
			if (Option.isSome(found)) return found.value
			yield* Effect.sleep("50 millis")
		}
	}).pipe(Effect.timeout("10 seconds"))

// The database is a real server, so these tests use the real clock.
layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect("the outbox starts a contributed workflow", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const ran = yield* Deferred.make<string>()
			const workflow = Engine.define("engine-host-start")
			const contribute = Layer.effectDiscard(
				Effect.flatMap(Workflows.Workflows, (workflows) =>
					workflows.contribute({
						workflow,
						plugin: "test",
						journal: 1,
						run: (key) => Deferred.succeed(ran, key.id).pipe(Effect.asVoid),
						policy: open,
					}),
				),
			).pipe(Layer.orDie)
			yield* Effect.gen(function* () {
				const key = yield* submit("engine-host-start", workflow._tag)
				assert.strictEqual(
					yield* Deferred.await(ran).pipe(Effect.timeout("10 seconds")),
					key.id,
				)
				// The outbox marks the command as sent.
				yield* until(
					Effect.map(store.pending([workflow._tag]), (pending) =>
						Option.liftPredicate(pending, Arr.isArrayEmpty),
					),
				)
			}).pipe(
				Effect.provide(
					EngineHost.layerLocal.pipe(
						Layer.provideMerge(contribute),
						Layer.provideMerge(Workflows.layer),
						Layer.provideMerge(WorkflowEngine.layerMemory),
					),
				),
			)
		}),
	)

	it.effect("a command for a workflow with no policy stays in the outbox", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const name = "engine-host-missing"
			const key = yield* submit(name, name)
			yield* Effect.sleep("1500 millis").pipe(
				Effect.provide(
					EngineHost.layerLocal.pipe(
						Layer.provideMerge(Workflows.layer),
						Layer.provideMerge(WorkflowEngine.layerMemory),
					),
				),
			)
			const pending = yield* store.pending([name])
			assert.strictEqual(pending.length, 1)
			assert.strictEqual(pending[0]?.executionId, key.id)
			assert.strictEqual(pending[0]?.sentAt, null)
		}),
	)

	it.effect("a feature finalizer runs after the generation closes", () =>
		Effect.gen(function* () {
			const events = yield* Ref.make<ReadonlyArray<string>>([])
			const note = (event: string) => Ref.update(events, Arr.append(event))
			const feature = Layer.effectDiscard(
				Effect.gen(function* () {
					// It is added before the workflow, so it runs after the release of the workflow.
					yield* Effect.addFinalizer(() => note("feature closed"))
					yield* (yield* Workflows.Workflows).contribute({
						workflow: Engine.define("engine-host-order"),
						plugin: "test",
						journal: 1,
						run: () => Effect.void,
						policy: open,
					})
				}),
			).pipe(Layer.orDie)
			const generation = Layer.effectDiscard(
				Effect.addFinalizer(() => note("generation closed")),
			).pipe(Layer.provideMerge(EngineHost.layerLocal))
			const scope = yield* Scope.make()
			yield* Layer.buildWithScope(
				generation.pipe(
					Layer.provide(feature),
					Layer.provideMerge(Workflows.layer),
					Layer.provideMerge(WorkflowEngine.layerMemory),
				),
				scope,
			)
			yield* Scope.close(scope, Exit.void)
			assert.deepStrictEqual(yield* Ref.get(events), [
				"generation closed",
				"feature closed",
			])
		}),
	)

	it.effect(
		"a feature of the cluster generation closes after Sharding has stopped",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const runners = sql<{
					readonly count: string
				}>`select count(*)::text as count from openbot_cluster_runners`
				const events = yield* Ref.make<ReadonlyArray<string>>([])
				const note = (event: string) => Ref.update(events, Arr.append(event))
				const feature = Layer.effectDiscard(
					Effect.gen(function* () {
						// It is added before the workflow, so it runs after the release of the workflow.
						// That release waits for the hold of the generation.
						yield* Effect.addFinalizer(() =>
							runners.pipe(
								Effect.flatMap((rows) =>
									note(`feature closed with ${rows[0]?.count} runners`),
								),
								Effect.orDie,
							),
						)
						yield* (yield* Workflows.Workflows).contribute({
							workflow: Engine.define("engine-host-cluster-order"),
							plugin: "test",
							journal: 1,
							run: () => Effect.void,
							policy: open,
						})
					}),
				).pipe(Layer.orDie)
				// The same order as the server: the generation is given its workflows.
				const generation = EngineHost.layer.pipe(
					Layer.provide(feature),
					Layer.provideMerge(Layer.merge(Workflows.layer, EngineHost.layerRpc)),
					Layer.provide(
						ShardingConfig.layer({
							runnerAddress: Option.some(
								RunnerAddress.make("127.0.0.1", 45873),
							),
						}),
					),
					Layer.provide(NodeHttpClient.layerUndici),
					Layer.provide(secret),
				)
				const scope = yield* Scope.make()
				yield* Layer.buildWithScope(generation, scope)
				yield* until(
					Effect.map(runners, (rows) =>
						Option.liftPredicate(rows, (rows) => rows[0]?.count === "1"),
					),
				)
				// The list-only store of Directory sees the runner of the generation.
				const listed = yield* Effect.flatMap(
					RunnerStorage.RunnerStorage,
					(store) => store.getRunners,
				).pipe(
					Effect.provide(
						Engine.layerRunnerList.pipe(Layer.provide(ShardingConfig.layer())),
					),
				)
				assert.deepStrictEqual(
					Arr.map(listed, ([runner, healthy]) => [
						runner.address.host,
						runner.address.port,
						healthy,
					]),
					[["127.0.0.1", 45873, true]],
				)
				yield* note("generation open")
				yield* Scope.close(scope, Exit.void)
				assert.deepStrictEqual(yield* Ref.get(events), [
					"generation open",
					"feature closed with 0 runners",
				])
			}),
	)

	it.effect("the cluster generation waits for an unregistered type", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			const { engine } = yield* cluster
			const unhosted = Engine.define("engine-host-unhosted")
			yield* unhosted
				.execute(
					{ namespace: "unhosted", id: Execution.Id.make("unhosted") },
					{ discard: true },
				)
				.pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine))
			// A hosted run shows that the runner owns its shards and reads messages.
			yield* peer
				.execute({ namespace: "unhosted", id: Execution.Id.make("hosted") })
				.pipe(
					Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
					Effect.timeout("20 seconds"),
				)
			// The base config gives a missing type only 100 ms. Wait much longer.
			yield* Effect.sleep("2 seconds")
			const rows = yield* sql<{
				readonly processed: boolean
				readonly replies: string
			}>`select m.processed, (select count(*) from openbot_cluster_replies r where r.request_id = m.request_id)::text as replies
				from openbot_cluster_messages m where m.entity_type = ${`Workflow/${unhosted._tag}`}`
			assert.deepStrictEqual(rows, [{ processed: false, replies: "0" }])
		}).pipe(Effect.scoped),
	)

	it.effect("a peer tries again when the RPC route answers 503", () =>
		Effect.gen(function* () {
			const { engine, statuses } = yield* cluster
			const runs = yield* Ref.make(0)
			// Each run waits for its result. An empty 503 answer must not end it.
			yield* until(
				Effect.gen(function* () {
					const id = Execution.Id.make(
						`peer-${yield* Ref.getAndUpdate(runs, (n) => n + 1)}`,
					)
					yield* peer
						.execute({ namespace: "peer", id })
						.pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine))
					return Option.liftPredicate(yield* Ref.get(statuses), (all) =>
						Arr.contains(all, 503),
					)
				}),
			)
			assert.isTrue(
				Arr.every(yield* Ref.get(statuses), (status) => status === 503),
			)
		}).pipe(Effect.scoped),
	)

	it.effect(
		"a closed engine releases its runner before the next one opens",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const runners = sql<{
					readonly count: string
				}>`select count(*)::text as count from openbot_cluster_runners`
				const generation = EngineHost.layer.pipe(
					Layer.provideMerge(Layer.merge(Workflows.layer, EngineHost.layerRpc)),
					Layer.provide(
						ShardingConfig.layer({
							runnerAddress: Option.some(
								RunnerAddress.make("127.0.0.1", 45871),
							),
						}),
					),
					Layer.provide(NodeHttpClient.layerUndici),
					Layer.provide(
						Layer.succeed(
							PrivateRpc.Secret,
							Redacted.make("test-cluster-secret"),
						),
					),
				)
				for (const round of [1, 2]) {
					const current = yield* Effect.scoped(
						Effect.gen(function* () {
							const context = yield* Layer.build(generation)
							const current = Context.get(context, EngineHost.EngineRpc)
							assert.ok(
								Option.isSome(yield* Ref.get(current)),
								`round ${round} has an RPC handler`,
							)
							// The runner registers itself soon after the start.
							yield* until(
								Effect.map(runners, (rows) =>
									Option.liftPredicate(rows, (rows) => rows[0]?.count === "1"),
								),
							)
							return current
						}),
					)
					// With no open generation, the route answers 503.
					assert.ok(Option.isNone(yield* Ref.get(current)))
				}
				// A closed generation leaves no runner row behind.
				assert.deepStrictEqual(yield* runners, [{ count: "0" }])
			}),
	)
})
