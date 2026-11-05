# Durable workflows

## How to think about it

A normal Effect lives in one fiber in one process. If the process dies at step
3 of 5, steps 1-3 are lost, and nothing remembers that the customer paid. A
workflow is an Effect whose **progress is recorded by an engine**, so that after
a crash, a deploy, or a three-day wait it can continue where it left off.

The engine does this by **replay**: when a workflow resumes it runs your body
again from the top. Work that already completed is not redone, because each
completed `Activity` result and each fired `DurableDeferred` / `DurableClock`
is stored and returned instantly on replay. The first unfinished step actually
runs (or suspends the workflow again). Everything in the mental model follows
from that one fact:

1. **The workflow body must be deterministic.** It is replayed, so it may
   run many times. Reading the clock, generating ids, calling HTTP, or writing
   to a database directly in the body is a bug. All side effects and all
   non-determinism go inside an `Activity`, whose result is recorded once.
2. **Activities are at-least-once.** If the process dies after the side effect
   but before the result is stored, the activity runs again. Give the external
   system an idempotency key (`Activity.idempotencyKey`).
3. **Waiting is a value.** `DurableDeferred.await` and `DurableClock.sleep`
   suspend the workflow (free its fiber entirely) and are resumed by a token or
   a timer, even from another process.
4. **Identity is the idempotency key.** `execute` derives the execution id from
   the workflow tag plus your key; starting the same key twice joins the same
   execution instead of running twice.

If you come from Temporal/Step Functions: same model, expressed as typed
Effects with Schema-encoded payloads and results. If you come from "a queue plus
a state column": the workflow replaces the state machine you would hand-write.
It is not a task queue (see [persistence](../persistence/guide.md)) and not a saga framework by
itself (compensation is explicit).

## Choose

| Situation | Use | Why / when not |
| --- | --- | --- |
| One side effect inside a workflow | `Activity.make({ name, success, error, execute })` | Result recorded; replays skip it |
| Transient failure of an activity | `Activity.retry({ times, while })` around the activity | Typed failures only; defects are not retried |
| Wait for a person, webhook, or other system | `DurableDeferred.make` + `await`, complete with `succeed`/`fail`/`done` + token | Survives restarts; the signal is typed |
| Wait minutes to days | `DurableClock.sleep({ name, duration })` | `Effect.sleep` is lost on restart; durations <= 60 s (default `inMemoryThreshold`) run in memory |
| Hand work to a worker pool and await its result | `DurableQueue.make` + `process` (in workflow) + `worker` (layer) | Built on `PersistedQueue`; handler failures are results, not retries |
| Race two durable events (approve vs timeout) | `Activity.raceAll` / `DurableDeferred.raceAll` | Plain `Effect.race` does not record which side won, so a replay may pick differently (`raceAll` persists the winner) |
| Undo earlier steps if the workflow fails | `Workflow.withCompensation` on a top-level step | Not for nested activities |
| Expose start/poll over RPC or HTTP | `WorkflowProxy.toRpcGroup` / `toHttpApiGroup` | Server side: `WorkflowProxyServer` |
| Short job, losing it on crash is fine | plain Effect + `Effect.retry` | A workflow costs storage and replay discipline |
| Fire-and-forget durable job, no steps | `PersistedQueue` ([persistence](../persistence/guide.md)) | Simpler |
| Long-lived stateful object with its own mailbox | Entity ([cluster](../cluster/guide.md)) | Workflows are one-shot runs |

## Recipe

### The pitfall: durability by hope

```ts import.meta.vitest name="references/workflow/guide.md#1"
import { Effect, Ref } from "effect"

// Wrong: the wait, the approval, and the fact that stock was reserved all live
// in this fiber's memory. A deploy mid-wait loses the order; a retry of the HTTP
// request starts a second copy and charges twice. (10 ms stands in for 24 hours.)
const fulfil = (orderId: string, charges: Ref.Ref<ReadonlyArray<string>>) =>
  Effect.gen(function*() {
    yield* Effect.sleep("10 millis")
    yield* Ref.update(charges, (all) => [...all, orderId]) // "chargeCard"
  })

const program = Effect.gen(function*() {
  const charges = yield* Ref.make<ReadonlyArray<string>>([])
  // The client times out and retries: nothing recognises the second request.
  yield* Effect.all([fulfil("o-1", charges), fulfil("o-1", charges)], { concurrency: "unbounded" })
  return yield* Ref.get(charges)
})

const charged = await Effect.runPromise(program)
charged // => ["o-1", "o-1"]
```

### The idiomatic version

One runnable file: definition, handler, engine, and a driver that plays the part
of "the outside world" (start, approve, let a day pass). It uses the in-memory
engine and `TestClock` so it finishes instantly; the workflow code itself does
not change for a durable engine.

```ts import.meta.vitest name="references/workflow/guide.md#2"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Activity, DurableClock, DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow"
import assert from "node:assert/strict"

// --- Domain errors: outcomes a caller of the workflow can branch on -----------
export class PaymentDeclined extends Schema.TaggedError<PaymentDeclined>()("PaymentDeclined", {
  orderId: Schema.String
}) {}
export class ApprovalRejected extends Schema.TaggedError<ApprovalRejected>()("ApprovalRejected", {
  reason: Schema.String
}) {}

// --- The external world, as a service so it is testable -----------------------
export class Warehouse extends Context.Service<Warehouse, {
  reserve(orderId: string): Effect.Effect<string>
  release(reservation: string): Effect.Effect<void>
}>()("app/Warehouse") {}

export class Payments extends Context.Service<Payments, {
  // The key makes a repeated call (after a crash) a no-op at the provider.
  charge(orderId: string, cents: number, idempotencyKey: string): Effect.Effect<string, PaymentDeclined>
}>()("app/Payments") {}

// --- Signal definition: what the outside world can send -----------------------
export const Approval = DurableDeferred.make("Approval", {
  success: Schema.Struct({ approvedBy: Schema.String }),
  error: ApprovalRejected // a rejection is a typed failure of the wait
})

// --- Workflow definition: the contract, independent of the implementation -----
export const Fulfilment = Workflow.make("Fulfilment", {
  payload: { orderId: Schema.String, cents: Schema.Int }, // must be Schema-encodable
  // Execution id = hash(tag, key). Same order => same execution => no double start.
  idempotencyKey: ({ orderId }) => orderId,
  success: Schema.Struct({ chargeId: Schema.String }),
  error: Schema.Union([PaymentDeclined, ApprovalRejected])
})

// --- Implementation: replayed from the top on every resume --------------------
export const FulfilmentLive = Fulfilment.toLayer(
  Effect.fn(function*(payload) {
    const warehouse = yield* Warehouse
    const payments = yield* Payments

    // Step 1: side effect in an Activity (recorded once). If the workflow later
    // fails, the compensation releases the reservation.
    const reservation = yield* Activity.make({
      name: "reserve-stock", // stable name: part of the stored history
      success: Schema.String,
      execute: warehouse.reserve(payload.orderId)
    }).pipe(Fulfilment.withCompensation((id) => warehouse.release(id)))

    // Step 2: suspend until a person decides. No fiber is held while waiting.
    yield* DurableDeferred.await(Approval)

    // Step 3: durable timer (24 h > 60 s threshold, so it is persisted).
    yield* DurableClock.sleep({ name: "cooling-off", duration: "24 hours" })

    // Step 4: the money movement. The key is stable across replays and crashes.
    const chargeId = yield* Activity.make({
      name: "charge-card",
      success: Schema.String,
      error: PaymentDeclined,
      execute: Effect.gen(function*() {
        const key = yield* Activity.idempotencyKey("charge-card")
        return yield* payments.charge(payload.orderId, payload.cents, key)
      })
    })

    yield* Effect.log(`order ${payload.orderId} fulfilled with reservation ${reservation}`)
    return { chargeId }
  })
)

// --- In-memory doubles --------------------------------------------------------
const WarehouseMemory = Layer.succeed(Warehouse, Warehouse.of({
  reserve: (orderId) => Effect.succeed(`res-${orderId}`),
  release: () => Effect.void
}))
const PaymentsMemory = Layer.succeed(Payments, Payments.of({
  charge: (orderId, _cents, key) => Effect.succeed(`ch-${orderId}-${key.slice(0, 6)}`)
}))

// Composition root: provide the engine ONCE; handler requirements are provided
// to the handler layer. Replace layerMemory with a cluster-backed engine to be durable.
const App = FulfilmentLive.pipe(
  Layer.provide(Layer.mergeAll(WarehouseMemory, PaymentsMemory)),
  Layer.provideMerge(WorkflowEngine.layerMemory)
)

// --- The outside world --------------------------------------------------------
const program = Effect.gen(function*() {
  const input = { orderId: "o-1", cents: 4200 }
  const executionId = yield* Fulfilment.executionId(input)

  // discard: true returns the execution id immediately instead of waiting.
  yield* Fulfilment.execute(input, { discard: true })
  yield* Fulfilment.execute(input, { discard: true }) // same key: joins, does not restart

  // Approving needs only a token derived from the execution id (so a webhook
  // handler in another process can do it).
  const token = DurableDeferred.tokenFromExecutionId(Approval, { workflow: Fulfilment, executionId })
  yield* DurableDeferred.succeed(Approval, { token, value: { approvedBy: "ada" } })

  // Engine fibers need real scheduler turns: each round moves virtual time (so
  // the durable clock fires once it exists), yields a few live ms, and polls.
  const result = yield* TestClock.adjust("24 hours").pipe(
    Effect.andThen(Effect.sleep("5 millis").pipe(TestClock.withLive)),
    Effect.andThen(Fulfilment.poll(executionId)),
    Effect.repeat({ until: (r) => Option.isSome(r) && r.value._tag === "Complete" })
  )
  return Option.isSome(result) ? result.value._tag : "missing"
}).pipe(Effect.provide(App), Effect.provide(TestClock.layer()))

const status = await Effect.runPromise(program)
status // => "Complete"
```

What to notice:

- `Fulfilment.execute` has `WorkflowEngine` in `R`, and the handler's `R`
  (`Warehouse | Payments`) appears on `toLayer`, not on `execute`. Callers
  need only the engine, so the caller side stays free of infrastructure.
- Business failures (`PaymentDeclined`, `ApprovalRejected`) are part of the
  workflow's error schema and are recorded; infrastructure failures are defects.
- Compensation must be idempotent. Observed with the memory engine: a
  second `execute` of the same key while the first is suspended re-runs the
  body and registers the compensation again, so it fired twice when the
  workflow later failed. `warehouse.release` here is safe to repeat.
- The engine owns scopes: do not `Effect.provide` the engine inside the body.

## Anti-patterns

**Non-determinism in the body.**

```ts skip
const id = crypto.randomUUID()          // different on every replay
const now = Date.now()                  // different on every replay
const user = yield* http.get(url)       // repeated on every replay
```

Consequence: the replayed body takes a different branch than the recorded one.
Right: do it inside `Activity.make({ ..., execute })` and use the activity's result.

**Side effects outside an Activity.** A bare `yield* sendEmail(...)` in the body
runs again on every resume (a wait, a timer, or a crash all resume). Right:
wrap it in an Activity, and make the activity idempotent
(`Activity.idempotencyKey("send-email")` as the provider's idempotency key).

**Assuming exactly-once activities.** The engine records the result *after* the
effect. A crash between them reruns it. Right: pass a stable key to the
external API, or make the write conditional.

**Unstable identity.** Renaming the workflow tag, an activity `name`, or a
deferred `name` orphans in-flight executions (their history no longer matches).
A constant `idempotencyKey` makes every execution collide; a random one makes
retries start duplicates. Right: tags and names are a versioned contract; the
key is the business identity (`orderId`), nothing else.

**`Effect.sleep` for long waits.** It lives in the fiber, not the engine.
Right: `DurableClock.sleep({ name, duration })`; remember durations at or under
`inMemoryThreshold` (60 s default) are not persisted.

**Retrying with `Effect.retry` around a step in the body.** The retry state is
not recorded, and a defect is not retried anyway. Right: wrap the activity in
`Activity.retry({ times: 5, while: (e) => ... })`, which tracks
`Activity.CurrentAttempt`; keep the retried error typed.

**Swallowing the suspension.** A workflow suspends by interrupting its own
fiber (`Workflow.suspend`). `Effect.catchCause(() => ...)` or `Effect.ignore`
around a `DurableDeferred.await` can turn the suspension into "continue".
Right: catch specific tags (`Effect.catchTag("ApprovalRejected", ...)`).

**The memory engine in production.** `WorkflowEngine.layerMemory` forgets
everything on restart. Right: `ClusterWorkflowEngine.layer` from `effect/cluster`
with SQL-backed storage (see `references/api.md`).

**Big payloads and secrets in the payload or results.** They are stored and
re-decoded on every replay. Right: pass ids and load data in an activity.

## Testing it

Replay is the property to test: the body runs many times, each activity once.
This self-contained test (memory engine, `TestClock`, `node:assert`) counts
both.

```ts import.meta.vitest name="references/workflow/guide.md#4"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Activity, DurableClock, Workflow, WorkflowEngine } from "effect/workflow"
import assert from "node:assert/strict"

const bodyRuns = Ref.makeUnsafe(0)
const sideEffects = Ref.makeUnsafe(0)

const Report = Workflow.make("Report", {
  payload: { id: Schema.String },
  idempotencyKey: ({ id }) => id,
  success: Schema.Int
})

const ReportLive = Report.toLayer(
  Effect.fn(function*() {
    yield* Ref.update(bodyRuns, (n) => n + 1) // runs on EVERY replay (test-only probe)
    const total = yield* Activity.make({
      name: "compute",
      success: Schema.Int,
      execute: Ref.updateAndGet(sideEffects, (n) => n + 1) // runs once
    })
    yield* DurableClock.sleep({ name: "settle", duration: "1 hour" })
    return total
  })
)

const test = Effect.gen(function*() {
  const first = yield* Report.execute({ id: "r1" }, { discard: true })
  const second = yield* Report.execute({ id: "r1" }, { discard: true })
  assert.equal(first, second) // idempotency key => same execution id

  const result = yield* TestClock.adjust("1 hour").pipe(
    Effect.andThen(Effect.sleep("5 millis").pipe(TestClock.withLive)),
    Effect.andThen(Report.poll(first)),
    Effect.repeat({ until: (r) => Option.isSome(r) && r.value._tag === "Complete" })
  )
  assert.equal(Option.isSome(result) && result.value._tag, "Complete")
  assert.equal(yield* Ref.get(sideEffects), 1) // activity not repeated by replay
  assert.ok((yield* Ref.get(bodyRuns)) >= 2) // body replayed after the timer
  return { total: Option.isSome(result) && result.value._tag === "Complete" ? result.value.exit._tag : "?" }
}).pipe(
  Effect.provide(ReportLive.pipe(Layer.provideMerge(WorkflowEngine.layerMemory))),
  Effect.provide(TestClock.layer())
)

const out = await Effect.runPromise(test)
out // => { total: "Success" }
```

Test failure paths the same way: complete the deferred with
`DurableDeferred.fail(Approval, { token, error })` and assert the compensation
ran; make an activity fail with its typed error and `Effect.exit(Fulfilment.execute(...))`
(without `discard`) to observe the workflow's failure.

With `@effect/vitest`, `it.effect` installs `TestClock`, so the same test reads
as a normal test file (typechecked here and run with `vitest`). Here a typed
activity failure surfaces as the workflow's error, and `Activity.retry` re-runs
the activity until it succeeds:

```ts
import { expect, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import { Activity, Workflow, WorkflowEngine } from "effect/workflow"

class Flaky extends Schema.TaggedError<Flaky>()("Flaky", { attempt: Schema.Int }) {}

const Sync = Workflow.make("Sync", {
  payload: { id: Schema.String },
  idempotencyKey: ({ id }) => id,
  success: Schema.Int,
  error: Flaky
})

const calls = Ref.makeUnsafe(0)

const SyncLive = Sync.toLayer(
  Effect.fn(function*() {
    return yield* Activity.make({
      name: "pull",
      success: Schema.Int,
      error: Flaky,
      execute: Effect.gen(function*() {
        const attempt = yield* Ref.updateAndGet(calls, (n) => n + 1)
        return attempt < 3 ? yield* new Flaky({ attempt }) : attempt
      })
    }).pipe(Activity.retry({ times: 5 }))
  })
)

it.effect("retries the activity and returns its result", () =>
  Effect.gen(function*() {
    expect(yield* Sync.execute({ id: "s1" })).toBe(3)
  }).pipe(Effect.provide(SyncLive.pipe(Layer.provideMerge(WorkflowEngine.layerMemory)))))
```

## Boundaries

- [schema](../schema/guide.md): payload, success, error, deferred and activity results are
  all Schemas and are stored encoded; a Schema change is a data migration.
- [services](../services/guide.md): workflow handlers get dependencies from layers
  (`toLayer`); the engine is a service in `R` at the edges.
- [persistence](../persistence/guide.md): `DurableQueue` is built on `PersistedQueue`; a plain
  durable job with no steps belongs there.
- [cluster](../cluster/guide.md): the durable engine (`ClusterWorkflowEngine`) runs on
  sharding and message storage; entities are the stateful-actor alternative.
- [sql](../sql/guide.md): supplies the storage for the cluster engine; keep SQL
  transactions inside a single activity.
- [rpc](../rpc/guide.md) / [http-api](../http-api/guide.md): `WorkflowProxy` derives start/poll/resume
  endpoints from workflows.
- [time](../time/guide.md): `Schedule` for activity retries, `TestClock`.
- [eventlog](../eventlog/guide.md): append-only facts rather than step-by-step progress.
- [testing](../testing/guide.md): general test-layer strategy.

Errors cross at the workflow definition: only the `error` schema is recoverable
by callers; everything else is a defect recorded in the result. Resources cross
at the engine: handler scopes are closed when the execution completes
(`Workflow.scope`, `Workflow.addFinalizer`).

## Changed in 4.1

- `Fulfilment.execute(payload, { discard: true, detached: true })` starts a
  child workflow that does not wake or get interrupted with its parent; an
  awaited child that is interrupted now fails the parent with a defect
  (`Effect.catchDefect`), not an interrupt. See [api.md](api.md).
- `poll` can return `Suspended { failed: true }` when your own
  `SuspendOnFailure` suspended the run: it needs an explicit `resume` or
  `interrupt` and is not woken automatically.
- Parallel branches parked on `DurableDeferred`s no longer suspend the run
  early while another branch is still recording its result.
- The engine lets external `execute` callers wake as soon as the result is
  observed (`awaitComplete`) instead of only polling `suspendedRetrySchedule`.
- Execution ids are unchanged (SHA-256, first 16 bytes), computed through
  `effect/crypto`.

## References

- API cheat sheet, engines, proxies, DurableQueue: [references/api.md](api.md)
- [Workflow API](https://effect.website/docs/v4/api/effect/workflow/Workflow)
- [Activity API](https://effect.website/docs/v4/api/effect/workflow/Activity)
- [DurableDeferred API](https://effect.website/docs/v4/api/effect/workflow/DurableDeferred)
- [DurableClock API](https://effect.website/docs/v4/api/effect/workflow/DurableClock)
- [Pinned Workflow source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/workflow/Workflow.ts)
- [Pinned Activity source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/workflow/Activity.ts)
- [Pinned ClusterWorkflowEngine source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/cluster/ClusterWorkflowEngine.ts)
