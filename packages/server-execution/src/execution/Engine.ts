import { type Caller, Execution } from "@openbot-build/domain"
import { Array as Arr, Duration, Effect, Layer, Schema } from "effect"
import {
	ClusterError,
	ClusterWorkflowEngine,
	HttpRunner,
	RunnerHealth,
	RunnerStorage,
	Runners,
	Sharding,
	ShardingConfig,
	SqlMessageStorage,
	SqlRunnerStorage,
} from "effect/cluster"
import { SqlClient } from "effect/sql"
import { RpcSerialization } from "effect/rpc"
import { DurableDeferred, Workflow } from "effect/workflow"
import type { Key } from "./Store.ts"
import * as PrivateRpc from "../transport/PrivateRpc.ts"

export const path = "/internal/executions/rpc"

const protocol = HttpRunner.layerClientProtocolHttp({ path }).pipe(
	Layer.provide(PrivateRpc.layerClient),
)
const storage = Layer.mergeAll(
	SqlMessageStorage.layerStorage({ prefix: "openbot_cluster" }),
	SqlRunnerStorage.layerStorage({ prefix: "openbot_cluster" }),
)
const runners = Runners.layerRpc.pipe(
	Layer.provide(protocol),
	Layer.provideMerge(storage),
)
const sharding = Sharding.layer.pipe(
	Layer.provideMerge(RunnerHealth.layerPing.pipe(Layer.provideMerge(runners))),
)

/** Both one-node and many-node servers use SQL storage and authenticated HTTP RPC. */
export const layer = ClusterWorkflowEngine.layer.pipe(
	Layer.provideMerge(sharding),
	Layer.provide(RpcSerialization.layerNdjson),
)

/**
 * A runner store that can only list the runners. Directory uses it for that.
 * The SQL runner store of the cluster takes a pool connection for shard locks
 * when it is built, and keeps it for its whole life. This store takes none. It
 * runs the same runner query on the shared pool. Only the engine generation
 * changes runners and shard locks, so every other operation here is a defect.
 */
export const layerRunnerList = Layer.effect(
	RunnerStorage.RunnerStorage,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const config = yield* ShardingConfig.ShardingConfig
		const seconds = Math.ceil(
			Duration.toSeconds(Duration.fromInputUnsafe(config.shardLockExpiration)),
		)
		const listOnly = Effect.die("This runner store can only list the runners.")
		return RunnerStorage.makeEncoded({
			getRunners: sql<{
				readonly runner: string
				readonly healthy: boolean
			}>`SELECT runner, healthy FROM openbot_cluster_runners WHERE last_heartbeat > NOW() - make_interval(secs => ${seconds})`.pipe(
				Effect.map(Arr.map((row) => [row.runner, row.healthy] as const)),
				Effect.mapError((cause) =>
					ClusterError.PersistenceError.make({ cause }),
				),
			),
			register: () => listOnly,
			unregister: () => listOnly,
			setRunnerHealth: () => listOnly,
			acquire: () => listOnly,
			refresh: () => listOnly,
			release: () => listOnly,
			releaseAll: () => listOnly,
		})
	}),
)

/** Engine messages hold references. A feature opens its sealed input from Store. */
export const define = <const Name extends string>(name: Name) =>
	Workflow.make(name, {
		payload: { namespace: Schema.String, id: Execution.Id },
		success: Schema.Void,
		error: Execution.Failure,
		idempotencyKey: ({ namespace, id }) =>
			`${namespace.length}:${namespace}${id}`,
	})

/** Signals hold no data. The workflow reads sealed records. Keep their stored names stable. */
export const signal = (id: string) => DurableDeferred.make(`decision:${id}`)

export const cancelSignal = (epoch: number) =>
	DurableDeferred.make(`cancel:${epoch}`)

export type Access = "read" | "cancel" | "decide" | "advance" | "replay"
export type Authorize = (
	key: Key,
	actor: Caller,
	access: Access,
) => Effect.Effect<
	void,
	Execution.Forbidden | Execution.NotFound | Execution.StorageError
>
/** A feature can commit its own records when a public decision is accepted. */
export interface DecisionCommand {
	readonly commandKey: Execution.CommandKey
	readonly decisionId: string
	readonly answer: Execution.Answer
}
export type Decide = (
	key: Key,
	actor: Caller,
	input: DecisionCommand,
) => Effect.Effect<
	Execution.Receipt,
	| Execution.Forbidden
	| Execution.NotFound
	| Execution.Conflict
	| Execution.KeyConflict
	| Execution.StorageError
>
/** Sends engine commands for one workflow. It reads the engine from context. */
export const transport = (workflow: ReturnType<typeof define>) => ({
	start: (key: Key) =>
		workflow
			.execute(key, { discard: true, detached: true })
			.pipe(Effect.asVoid),
	// Delivery stores only a signal. The workflow owns release and the final state.
	cancel: (key: Key, epoch: number) =>
		Effect.gen(function* () {
			const executionId = yield* workflow.execute(key, {
				discard: true,
				detached: true,
			})
			const named = cancelSignal(epoch)
			yield* DurableDeferred.succeed(named, {
				token: DurableDeferred.tokenFromExecutionId(named, {
					workflow,
					executionId,
				}),
				value: undefined,
			})
		}),
	signal: (key: Key, id: string) =>
		Effect.gen(function* () {
			const executionId = yield* workflow.execute(key, {
				discard: true,
				detached: true,
			})
			const named = signal(id)
			yield* DurableDeferred.succeed(named, {
				token: DurableDeferred.tokenFromExecutionId(named, {
					workflow,
					executionId,
				}),
				value: undefined,
			})
		}),
})
