# effect/workflow: verified reference

Checked against `node_modules/effect/src/workflow/*.ts` and
`src/cluster/ClusterWorkflowEngine.ts` (effect@4.1.2). Everything is
`@stability unstable`.

```ts import.meta.vitest name="references/workflow/api.md#1"
import { Activity, DurableClock, DurableDeferred, DurableQueue, Workflow, WorkflowEngine, WorkflowProxy, WorkflowProxyServer } from "effect/workflow"
```

## Workflow

`Workflow.make(tag, { payload, idempotencyKey, success?, error?, suspendedRetrySchedule?, annotations? })`

- `payload`: a fields object (becomes `Schema.Struct`) or a struct schema.
- `success` defaults to `Schema.Void`, `error` to `Schema.Never`.
- `idempotencyKey(payload) => string`: execution id = hash of `tag` and key.

Members of the returned workflow:

| Member | Result |
| --- | --- |
| `execute(payload, { discard?, detached? })` | `Effect<Success, Error, WorkflowEngine>`; with `discard: true`, `Effect<string>` (the execution id) returning at once. `detached: true` (4.1, requires `discard: true`) starts a child workflow that neither wakes nor is interrupted with its parent |
| `executionId(payload)` | `Effect<string>`, deterministic |
| `poll(executionId)` | `Effect<Option<Workflow.Result>>`; result is `Complete { exit }` or `Suspended { cause?, failed? }` (`failed: true` when the run suspended through `SuspendOnFailure`, 4.1) |
| `interrupt(executionId)` / `resume(executionId)` | `Effect<void, never, WorkflowEngine>` |
| `toLayer((payload, executionId) => Effect)` | `Layer<never, never, WorkflowEngine | R>`: registers the handler. Handler `R` may include `WorkflowEngine`, `WorkflowInstance`, `Workflow.Execution<Tag>`, `Scope` (all provided by the engine) |
| `withCompensation(f)` | wraps a top-level step; `f(value, cause)` runs if the workflow ends in failure; keep it idempotent |
| `annotate`, `annotateMerge` | attach `Context` annotations |

Module functions: `Workflow.scope`, `Workflow.provideScope`,
`Workflow.addFinalizer((exit) => Effect)` (scope closes when the execution
completes), `Workflow.suspend(instance)`, `Workflow.intoResult`,
`Workflow.wrapActivityResult`.
References that are read from the *workflow's annotations*, not from the
handler's context (so `Effect.provideService` inside the body has no effect):
`Workflow.CaptureDefects` (default `true`: defects are captured into the
result) and `Workflow.SuspendOnFailure` (default `false`: when `true`, an error
suspends the execution so you can fix and `resume(executionId)`). Set them with
`Workflow.make(..., { annotations: Context.make(Workflow.SuspendOnFailure, true) })`
or `MyWorkflow.annotate(Workflow.SuspendOnFailure, true)`.

## Activity

`Activity.make({ name, success?, error?, execute, interruptRetryPolicy?, annotations? })`

- An `Activity` is itself an `Effect` (`yield* activity`) requiring
  `WorkflowEngine | WorkflowInstance`; `activity.execute` is the same with
  `Scope` too.
- Only completed results are memoized. If the body suspends (child workflow,
  durable clock) it re-runs on replay.
- Interruptions are retried (default: exponential 400 ms x1.5, capped at
  10 s spacing, 10 attempts); this is `interruptRetryPolicy`.
- `Activity.retry({ times?, while?, until? })`: `Effect.retry` that sets
  `Activity.CurrentAttempt` (starts at 1). Typed failures only: a defect
  (`Effect.die`) is not retried (verified). If retries exhaust, the last typed
  error is the activity's error, so declare it in `error`.
- `Activity.idempotencyKey(name, { includeAttempt? })`: stable hash of
  execution id (+ attempt) + name, for external idempotency keys.
- `Activity.raceAll(name, [activities])`: durable race, first completion wins.

Result schemas must be JSON-codec encodable (`Schema.toCodecJson` is applied).

## DurableDeferred

- `DurableDeferred.make(name, { success?, error? })`
- `DurableDeferred.await(deferred)`: suspends the workflow until completed;
  yields the success or fails with the typed error.
- Completing from outside (needs `WorkflowEngine`): `succeed(deferred, { token, value })`,
  `fail(deferred, { token, error })`, `failCause(deferred, { token, cause })`,
  `done(deferred, { token, exit })`.
- Tokens: `token(deferred)` (inside the workflow; `Effect<Token>`),
  `tokenFromExecutionId(deferred, { workflow, executionId })` (plain value, not
  an Effect), `tokenFromPayload(deferred, { workflow, payload })` (Effect).
  `Token` is a branded string you can hand to a webhook or email link.
- `DurableDeferred.into(effect, deferred)`: run an effect and record its exit
  as the deferred's completion. `DurableDeferred.raceAll({ name, success, error, effects })`.
- `deferred.withActivityAttempt`: per-attempt deferred name for activities
  that retry.

## DurableClock

`DurableClock.sleep({ name, duration, inMemoryThreshold? })`. Durations at or
below `inMemoryThreshold` (default 60 seconds) run as an in-memory activity
(not durable across restart); longer ones are scheduled with the engine.
Zero duration returns at once. `DurableClock.make({ name, duration })` builds
the clock value only.

## DurableQueue

```ts import.meta.vitest name="references/workflow/api.md#2"
import { Effect, Layer, Schema } from "effect"
import { PersistedQueue } from "effect/persistence"
import { DurableQueue, Workflow, WorkflowEngine } from "effect/workflow"

const Resize = DurableQueue.make({
  name: "resize",
  payload: { imageId: Schema.String },
  idempotencyKey: ({ imageId }) => imageId,
  success: Schema.Struct({ bytes: Schema.Int })
  // error: SomeSchema   (optional typed failure of the worker)
})

const Thumbnail = Workflow.make("Thumbnail", {
  payload: { imageId: Schema.String },
  idempotencyKey: ({ imageId }) => imageId,
  success: Schema.Struct({ bytes: Schema.Int })
})

// Inside a workflow handler: offer to the PersistedQueue and await the result durably.
const ThumbnailLive = Thumbnail.toLayer(
  Effect.fn(function*({ imageId }) {
    return yield* DurableQueue.process(Resize, { imageId })
  })
)

// Worker side, as a Layer (forks a scoped fiber); `concurrency` defaults to 1.
const ResizeWorker = DurableQueue.worker(
  Resize,
  ({ imageId }) => Effect.succeed({ bytes: imageId.length * 100 }),
  { concurrency: 4 }
)

const Live = Layer.mergeAll(ThumbnailLive, ResizeWorker).pipe(
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(PersistedQueue.layer.pipe(Layer.provide(PersistedQueue.layerStoreMemory)))
)

const result = await Effect.runPromise(Thumbnail.execute({ imageId: "cat.png" }).pipe(Effect.provide(Live)))
result // => { bytes: 700 }
```

`DurableQueue.process(queue, payload, { retrySchedule? })`: the schedule retries
only the *offer* to the queue (default: exponential 500 ms x1.5, capped at 1
minute spacing).

Requires `WorkflowEngine` and `PersistedQueueFactory` (see [persistence](../persistence/guide.md)).
The worker's handler exit (success or typed failure) completes the
workflow's deferred; there is no retry of handler failures through the
queue. Verified with the memory engine and `PersistedQueue.layerStoreMemory`.
`DurableQueue.makeWorker` is the same as an Effect that never returns.

## Engines

| Engine | Layer | Notes |
| --- | --- | --- |
| In-memory | `WorkflowEngine.layerMemory` | Tests and local dev; state lost on restart |
| Cluster | `ClusterWorkflowEngine.layer` (from `effect/cluster`): `Layer<WorkflowEngine, never, Sharding | MessageStorage>` | Persists executions, activities, deferreds and clocks as cluster messages |

Test the cluster engine in one process:
`ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))` (in-memory
storage; verified to run the same workflow as `layerMemory`).

Durable deployment shape (typechecked, not run against a database):

```ts
import { NodeClusterSocket, NodeRuntime } from "@effect/platform-node"
import { PgliteClient } from "@effect/sql-pglite"
import { Layer } from "effect"
import { ClusterWorkflowEngine } from "effect/cluster"

// NodeClusterSocket.layer() with default storage needs a SqlClient and provides
// Sharding + SQL-backed MessageStorage; pass { storage: "local" } for in-memory.
// Swap PgliteClient for your production adapter (e.g. @effect/sql-pg).
const Engine = ClusterWorkflowEngine.layer.pipe(
  Layer.provideMerge(NodeClusterSocket.layer()),
  Layer.provide(PgliteClient.layer({}))
)

// Merge your workflow handler layers on top of Engine, then:
Layer.launch(Engine).pipe(NodeRuntime.runMain)
```

All runner processes must register the same workflow handlers (same tags,
activity names and payload shapes). If the same tag is registered twice in one process with a different payload
shape, the cluster engine logs a warning and ignores the duplicate definition.

## Exposing workflows

- `WorkflowProxy.toRpcGroup(workflows, { prefix? })` and
  `WorkflowProxy.toHttpApiGroup(name, workflows)` derive, per workflow, a
  start endpoint, a `...Discard` start that returns the execution id, and a
  `...Resume` endpoint.
- `WorkflowProxyServer.layerRpcHandlers(...)` / `layerHttpApi(api, groupName, workflows)`
  implement them against the engine. See [rpc](../rpc/guide.md) and [http-api](../http-api/guide.md).

## Reading the types

- `Execution<Tag>`, `WorkflowInstance`, `Scope` in a handler's `R` are
  excluded from `toLayer`'s requirements; the engine supplies them.
- `Workflow.execute`'s `R` is `WorkflowEngine | <encoding/decoding services>`.
  If you see extra services there, a Schema in the payload or result needs
  them.
- A workflow handler can only fail with the declared `error` type; make
  activity errors a subset of it (use `Schema.Union([...])`) or map them in
  the body.

## Changed in 4.1 (workflow)

- `execute(..., { discard: true, detached: true })`; otherwise a child workflow
  stays linked to its parent. An awaited child that is *interrupted* now fails
  the parent with a defect (catch with `Effect.catchDefect` / `Effect.exit`)
  instead of interrupting it. Do not await a detached execution later.
- `Suspended` has an optional `failed` flag: your own `SuspendOnFailure`
  suspensions require an explicit `resume`/`interrupt`; inherited child
  failures do not set it.
- `WorkflowEngine` gained an optional `awaitComplete` hook: external callers of
  `execute` are woken as soon as the engine observes the result and fall back to
  `suspendedRetrySchedule` otherwise (the cluster engine wakes only callers on
  the runner that owns the execution).
- `DurableDeferred.into` / `raceAll` bodies count as one in-flight activity, so
  parallel branches parked on durable waits no longer suspend the run before the
  recorded exit is written. Concurrent awaits of one deferred are counted.
- Execution ids and idempotency keys are still the first 16 bytes of SHA-256 as
  32 hex chars, now computed through `effect/crypto` (values are unchanged).
