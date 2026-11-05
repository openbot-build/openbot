# Cluster deployment, configuration and cheat sheet

Everything here was checked against `effect@4.1.2` sources and
`@effect/platform-node@4.1.2` declarations.

## Which cluster layer where

| Environment | Layer | Needs | Notes |
| --- | --- | --- | --- |
| Unit/integration test | `TestRunner.layer` (`effect/cluster`) | nothing | provides `Sharding`, `Runners`, `MessageStorage`, `MemoryDriver`; in-memory |
| One process, durable | `SingleRunner.layer({ runnerStorage? })` | `SqlClient`, `Digest` (`effect/crypto`; `NodeCrypto.layerDigest` on Node) | message storage is always SQL; no runner networking |
| Multi-runner over TCP | `NodeClusterSocket.layer(options)` (`@effect/platform-node`) | `SqlClient` unless `storage` is `"local"` or `"byo"` | `serialization: "binary" \| "ndjson"` |
| Multi-runner over HTTP/WebSocket | `NodeClusterHttp.layer({ transport: "http" \| "websocket", ... })` | same | |
| Client-only process (sends, owns nothing) | same layers with `clientOnly: true` | same | `ShardingConfig.runnerAddress` is `None` in this mode |

`storage` is `"local" | "sql" | "byo"`. Omitted means SQL (the layer
then requires `SqlClient`). `"local"` uses in-memory runner storage and the
**no-op** `MessageStorage`, so persisted messages are not stored (a persisted
send defects); use it only when nothing is `Persisted`. `"byo"` leaves
`MessageStorage` and `RunnerStorage` as requirements for you to provide.
`runnerHealth` is `"ping"` or `"k8s"`. Pass
`shardingConfig: { ... }` to override any `ShardingConfig` field.

## A durable single runner you can run in a test

`SingleRunner.layer` is the cluster model without runner networking: one
process owns every shard, and persisted messages live in SQL. With the
embedded PGlite database it needs no server, so the persisted-delivery
contract can be exercised for real. The second send of the same
`primaryKey` returns the first reply from SQL storage instead of running the
handler again.

```ts import.meta.vitest name="references/cluster/deployment.md#1"
import { NodeCrypto } from "@effect/platform-node"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Layer, Ref, Schema } from "effect"
import { ClusterSchema, Entity, SingleRunner } from "effect/cluster"
import { Rpc } from "effect/rpc"

const Charge = Rpc.make("Charge", {
  payload: { requestId: Schema.String, cents: Schema.Number },
  primaryKey: ({ requestId }) => requestId,
  success: Schema.Number
}).annotate(ClusterSchema.Persisted, true)
const Billing = Entity.make("Billing", [Charge])

const program = Effect.gen(function*() {
  const runs = yield* Ref.make(0)
  const BillingLayer = Billing.toLayer({
    Charge: ({ payload }) => Ref.updateAndGet(runs, (n) => n + 1).pipe(Effect.as(payload.cents))
  })

  return yield* Effect.gen(function*() {
    const client = (yield* Billing.client)("customer-1")
    const first = yield* client.Charge({ requestId: "r1", cents: 500 })
    const again = yield* client.Charge({ requestId: "r1", cents: 500 })
    return { first, again, handlerRuns: yield* Ref.get(runs) }
  }).pipe(
    Effect.provide(BillingLayer.pipe(
      Layer.provideMerge(
        // SQL message storage (PGlite in memory) + in-memory runner storage.
        SingleRunner.layer({ runnerStorage: "memory" }).pipe(
          Layer.provide(PgliteClient.layer({})),
          Layer.provide(NodeCrypto.layerDigest)
        )
      )
    ))
  )
})

const result = await Effect.runPromise(program)
result // => { first: 500, again: 500, handlerRuns: 1 }
```

Swap `PgliteClient.layer` for your real driver layer in production
([sql](../sql/guide.md)).

## A production root

```ts
import { NodeClusterSocket, NodeRuntime } from "@effect/platform-node"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Layer, Schema } from "effect"
import { ClusterSchema, Entity } from "effect/cluster"
import { Rpc } from "effect/rpc"

const Ping = Rpc.make("Ping", { success: Schema.String })
  .annotate(ClusterSchema.Persisted, false)
const Echo = Entity.make("Echo", [Ping])
const EchoLayer = Echo.toLayer({ Ping: () => Effect.succeed("pong") })

// The SQL driver is the application's choice (see [sql](../sql/guide.md)).
// PGlite keeps this file self-contained; use your Postgres/MySQL layer in
// production.
const SqlLayer = PgliteClient.layer({})

// Runner transport + SQL-backed storage. Every runner process runs this.
const ClusterLayer = NodeClusterSocket.layer({
  storage: "sql",
  shardingConfig: { shardsPerGroup: 300 }
}).pipe(Layer.provide(SqlLayer))

// Entities register themselves; Layer.launch keeps the process alive and
// closes the runner (unregistering it) on SIGINT/SIGTERM through runMain.
const Main = EchoLayer.pipe(Layer.provide(ClusterLayer))

Layer.launch(Main).pipe(NodeRuntime.runMain)
```

Rules that follow from the types: `EchoLayer` needs `Sharding`;
`ClusterLayer` provides it; the SQL client is the only thing left, and you
provide it once at the root.

## ShardingConfig fields (defaults)

Load with `ShardingConfig.layerFromEnv(overrides?)` (reads env/config keys
such as `host`, `port`, `shardsPerGroup`, `entityMaxIdleTime`), or build
with `ShardingConfig.layer(partial)` / `ShardingConfig.layerDefaults`.

| Field | Default | Meaning |
| --- | --- | --- |
| `runnerAddress` | `Some(localhost:34431)` | how other runners reach this one; `None` = client only |
| `runnerListenAddress` | `None` | bind address if different from `runnerAddress` |
| `runnerShardWeight` | `1` | relative share of shards |
| `availableShardGroups` / `assignedShardGroups` | `["default"]` | groups in the cluster / groups this runner owns |
| `shardsPerGroup` | `300` | must be identical on every runner |
| `shardLockRefreshInterval` / `shardLockExpiration` | 10 s / 35 s | shard lock lease |
| `entityMailboxCapacity` | `4096` | queue per entity before `MailboxFull` |
| `entityMailboxMetrics` | `false` | report each resident entity's mailbox size as the `effect_cluster_entity_mailbox_size` gauge (4.1; `toLayer` option `mailboxMetrics` overrides per entity) |
| `runnerJoinDebounce` | `0` | how long the healthy runner set must stay unchanged before runners that joined later are given shards; `0` publishes immediately, a few seconds absorbs rolling deploys (4.1) |
| `maxResidentEntities` | `10_000` | active entities per runner |
| `entityMaxIdleTime` | 1 minute | default passivation (overridden by `toLayer` option `maxIdleTime`) |
| `entityRegistrationTimeout` | 1 minute | message fails if the entity never registers |
| `entityTerminationTimeout` | 15 seconds | time allowed for an entity to stop on shutdown |
| `entityMessagePollInterval` | 10 s | storage poll for unprocessed messages |
| `refreshAssignmentsInterval` | 3 s | shard assignment refresh |
| `simulateRemoteSerialization` | `true` | local sends still encode/decode, so serialization bugs show up in tests |

## `Entity.toLayer` options

`maxIdleTime`, `concurrency` (default 1: handlers run one at a time;
`"unbounded"` or a number to overlap), `mailboxCapacity`, `mailboxMetrics`,
`disableFatalDefects`, `defectRetryPolicy` (a `Schedule` used when the
entity dies with a defect), `spanAttributes`. `Entity.toLayerQueue` hands you
the mailbox `Queue.Dequeue` and a `Replier` (`succeed`, `fail`,
`failCause`, `complete`) when you need to process messages in your own loop.

## Annotations (`ClusterSchema`)

Apply with `rpc.annotate(Key, value)`, `entity.annotateRpcs(Key, value)`
(every RPC defined above this point) or `entity.annotate(Key, value)`.

| Key | Default | Use |
| --- | --- | --- |
| `Persisted` | `false` | store in `MessageStorage`, redeliver, cache reply |
| `Uninterruptible` | `false` | `true`, `"client"` or `"server"`: ignore interruption on that side |
| `WithTransaction` | `false` | wrap server writes in the storage transaction (only if the storage implements it) |
| `InterruptOnTermination` | `false` | interrupt a long-lived request as soon as the entity starts terminating instead of waiting out `entityTerminationTimeout`; persisted requests resume on the next owner (4.1) |
| `ShardGroup` | `() => "default"` | `entity.annotate(ClusterSchema.ShardGroup, (id) => ...)` to route ids to a shard group |
| `ClientTracingEnabled` | `true` | per-request client spans |

## Errors on the client

`ClusterError` exports `EntityNotAssignedToRunner`, `MalformedMessage`,
`PersistenceError`, `RunnerNotRegistered`, `RunnerUnavailable`,
`MailboxFull` and `AlreadyProcessingMessage`, each with a static `is`. The
entity client's error type is your RPC error plus `MailboxFull |
AlreadyProcessingMessage | PersistenceError | EntityNotAssignedToRunner`.
A persisted send is retried by Sharding when the mailbox is full or the
entity moved; a volatile send fails immediately with `MailboxFull`.

## Other pieces

- `Entity.keepAlive(true)` / `EntityResource.make({ acquire, idleTimeToLive })`:
  keep an entity (or a resource tied to it) alive while work is outstanding.
- `EntityProxy.toRpcGroup(entity)` + `EntityProxyServer.layerRpcHandlers(entity)`:
  expose an entity over `RpcServer`; `EntityProxy.toHttpApiGroup` does the same
  for `effect/http-api`.
- `ClusterCron.make({ name, cron, execute, shardGroup?, skipIfOlderThan?, calculateNextRunFromPrevious? })`:
  `skipIfOlderThan` defaults to one day. With `calculateNextRunFromPrevious: true`
  one entity per job processes the runs in order, so runs never overlap and
  missed runs are caught up; a failing run is retried in place and blocks later
  runs until it succeeds or is too old. Inside `execute`, the
  `ClusterCron.CurrentScheduledTime` service gives the run's scheduled
  `DateTime.Utc` (4.1).
- `Singleton.make(name, effect, { shardGroup? })`: the effect is `orDie`d and
  kept alive after it completes; registering the same name twice is a defect.
- `ClusterWorkflowEngine.layer` provides `WorkflowEngine` on top of
  `Sharding` and `MessageStorage` (see [workflow](../workflow/guide.md)).
