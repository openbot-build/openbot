# Effect Cluster: entities, shards and runners

## How to think about it

A cluster solves one problem: **many processes, one owner per key.** You have
millions of logical things (accounts, carts, chat rooms) and several
processes. Without coordination, two processes can both load "account 42",
both apply a withdrawal and both write back. Cluster fixes this by hashing
every entity ID to a *shard*, assigning each shard to exactly one *runner*
(a process), and routing every message for that entity to the runner that
owns its shard. The entity is then a single-threaded actor: its handlers
run one at a time by default, so the state inside it needs no locks.

Three ideas carry everything else:

- An **Entity** is a typed *protocol* (a list of `Rpc` definitions) plus a
  *behaviour* (handlers you register as a `Layer`). The same RPC schemas that
  would describe an HTTP endpoint describe the messages. The client is
  `entity.client`, which gives you `(entityId) => typed rpc client`. There is
  no "connection": you address by ID and Sharding finds the owner.
- **Ownership moves.** When a runner joins, leaves or crashes, shards are
  reassigned and active entities are interrupted and recreated elsewhere,
  with fresh memory. A handler's in-memory `Ref` is a cache of the current
  activation, not the source of truth. Anything that must survive goes to a
  database (or is rebuilt by replaying persisted messages).
- **Delivery is a contract you choose per RPC.** By default a message is
  *volatile*: sent over the network, answered or failed, never stored. Annotate
  an RPC with `ClusterSchema.Persisted` and it is written to `MessageStorage`
  first, redelivered after a crash or reassignment, and its reply is cached.
  Persisted plus a `primaryKey` gives you idempotent delivery: the second
  send of the same key returns the first reply instead of re-running.

If you come from Express/Redis-lock/BullMQ: do not build "load, lock,
mutate, save" loops. Do not run a `setInterval` on every instance and hope
a lock election works; use a singleton. And do not treat the entity
as a distributed object that is always alive: it is created on first message,
passivated after `maxIdleTime`, and may restart at any time.

Cluster is in the unstable `effect/cluster` entry point. Pin the version and
expect API movement between releases.

## Choose

| Situation | Use | Why |
| --- | --- | --- |
| Many keyed, stateful things; each must be mutated by one owner at a time | `Entity.make` + `toLayer` | single-writer actor per ID, no locks |
| A stateless request/response API | `effect/rpc` or `effect/http-api` ([rpc](../rpc/guide.md), [http-api](../http-api/guide.md)) | no owner needed; cluster adds storage and shard coordination for nothing |
| A message must survive restarts and reassignment | `Rpc.annotate(ClusterSchema.Persisted, true)` | stored in `MessageStorage`, redelivered |
| A retried client call must not run twice | `Persisted` + `primaryKey` on the RPC | same key returns the cached reply |
| Fire and forget | `client.method(payload, { discard: true })` | do not wait for the reply |
| Exactly one background loop in the whole cluster | `Singleton.make(name, effect)` | runs on one runner, moves on failure |
| A recurring job owned by the cluster | `ClusterCron.make({ name, cron, execute })` | persisted per-run messages, skip-if-stale |
| A multi-step durable execution with retries and sleeps | [workflow](../workflow/guide.md) (cluster is its engine, `ClusterWorkflowEngine.layer`) | workflows add activities and compensation; cluster only places owners |
| One process, just want durable entities | `SingleRunner.layer` (SQL) | cluster model without runner networking |
| Unit-testing handler logic | `Entity.makeTestClient` | no sharding, no storage, no network |
| Testing routing, persistence, singletons, passivation | `TestRunner.layer` | in-memory sharding and storage |
| Shared mutable state in one process | `Ref`/`SynchronizedRef` ([state](../state/guide.md)) | cluster is for cross-process ownership |

Do not reach for a cluster to get "a queue". Persisted entity messages are
a mailbox per ID with ordering per entity, not a general broker.

## Recipe

### 1. The protocol: messages are schemas, failures are typed

Design the messages first. Everything here is serialized, so payloads and
errors are `Schema`s. Domain failures that callers branch on belong in the
RPC's `error` schema; the cluster adds its own transport errors separately.

```ts import.meta.vitest name="references/cluster/guide.md#1"
import { Schema } from "effect"
import { ClusterSchema, Entity } from "effect/cluster"
import { Rpc } from "effect/rpc"

// A domain failure the caller can act on. It is a Schema so it crosses the wire.
export class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()(
  "InsufficientFunds",
  { balance: Schema.Number }
) {}

// Withdraw mutates money, so it must survive a runner crash (Persisted) and
// must not apply twice when a client retries (primaryKey). The key is a
// request id the *caller* generates once per intent, never per attempt.
export const Withdraw = Rpc.make("Withdraw", {
  payload: { requestId: Schema.String, amount: Schema.Number },
  primaryKey: ({ requestId }) => requestId,
  success: Schema.Number,
  error: InsufficientFunds
}).annotate(ClusterSchema.Persisted, true)

// A read. Volatile is fine: if it is lost, the caller just asks again.
export const Balance = Rpc.make("Balance", { success: Schema.Number })

// The entity type name is part of the storage address. Renaming it later
// orphans stored messages, so treat it like a table name.
export const Account = Entity.make("Account", [Withdraw, Balance])
```

### 2. The behaviour: a Layer that registers handlers

`toLayer` takes an Effect that runs **once per activation** (per entity ID,
each time it is created). Acquire per-entity state there. Services it needs
become requirements of the resulting layer, so dependencies are ordinary
`R`, and tests provide fakes.

```ts import.meta.vitest name="references/cluster/guide.md#2"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { ClusterSchema, Entity } from "effect/cluster"
import { Rpc } from "effect/rpc"

class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()(
  "InsufficientFunds",
  { balance: Schema.Number }
) {}

const Withdraw = Rpc.make("Withdraw", {
  payload: { requestId: Schema.String, amount: Schema.Number },
  primaryKey: ({ requestId }) => requestId,
  success: Schema.Number,
  error: InsufficientFunds
}).annotate(ClusterSchema.Persisted, true)
const Balance = Rpc.make("Balance", { success: Schema.Number })
export const Account = Entity.make("Account", [Withdraw, Balance])

// The durable truth lives behind a service. The entity is the single writer
// in front of it, which is what makes read-modify-write safe.
export class Ledger extends Context.Service<Ledger, {
  load(accountId: string): Effect.Effect<number>
  save(accountId: string, balance: number): Effect.Effect<void>
}>()("app/Ledger") {
  static readonly layerMemory = Layer.effect(
    Ledger,
    Effect.gen(function*() {
      const rows = yield* Ref.make(new Map<string, number>())
      return Ledger.of({
        load: (id) => Ref.get(rows).pipe(Effect.map((m) => m.get(id) ?? 100)),
        save: (id, balance) => Ref.update(rows, (m) => new Map(m).set(id, balance))
      })
    })
  )
}

export const AccountLayer = Account.toLayer(
  Effect.gen(function*() {
    // Runs on activation. CurrentAddress is provided by the runtime, so it is
    // not added to the layer's requirements.
    const ledger = yield* Ledger
    const { entityId } = yield* Entity.CurrentAddress
    const balance = yield* Ref.make(yield* ledger.load(entityId))

    return Account.of({
      // Handlers of one entity run one at a time, so this read-then-write
      // cannot interleave with another Withdraw for the same account.
      Withdraw: Effect.fnUntraced(function*({ payload }) {
        const current = yield* Ref.get(balance)
        if (current < payload.amount) {
          return yield* new InsufficientFunds({ balance: current })
        }
        const next = current - payload.amount
        yield* ledger.save(entityId, next)
        yield* Ref.set(balance, next)
        return next
      }),
      // Rpc.fork opts this read out of the one-at-a-time queue so it does not
      // wait behind slow writes. Only do that for handlers that are safe to
      // overlap with others.
      Balance: () => Ref.get(balance).pipe(Rpc.fork)
    })
  }),
  // Passivation: stop the activation after 5 idle minutes. State in the Ref is
  // gone then; the next message re-runs the Effect above and reloads it.
  { maxIdleTime: "5 minutes" }
)
```

The type of `AccountLayer` is `Layer<never, never, Ledger | Sharding>`: it
produces nothing (it only *registers*), and it needs `Ledger` and `Sharding`.
That is the R story. Providing `Ledger` is your job; `Sharding` comes from
the cluster layer at the deployment boundary.

### 3. The caller: hide the client behind a domain service

Application code should not know it is talking to a cluster. Wrap the client
in a service and decide what each cluster error means for *your* callers.
The client's error type is the RPC's `error` plus four transport errors:
`MailboxFull`, `AlreadyProcessingMessage`, `PersistenceError` and
`EntityNotAssignedToRunner`. Sharding retries
`EntityNotAssignedToRunner` internally during reassignment (it surfaces mainly
during shutdown); treat what leaks out as infrastructure
and die, keeping `InsufficientFunds` typed.

```ts import.meta.vitest name="references/cluster/guide.md#3"
import { Context, Effect, Layer, Schema } from "effect"
import { ClusterSchema, Entity } from "effect/cluster"
import { Rpc } from "effect/rpc"

class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()(
  "InsufficientFunds",
  { balance: Schema.Number }
) {}
const Withdraw = Rpc.make("Withdraw", {
  payload: { requestId: Schema.String, amount: Schema.Number },
  primaryKey: ({ requestId }) => requestId,
  success: Schema.Number,
  error: InsufficientFunds
}).annotate(ClusterSchema.Persisted, true)
const Balance = Rpc.make("Balance", { success: Schema.Number })
const Account = Entity.make("Account", [Withdraw, Balance])

export class Accounts extends Context.Service<Accounts, {
  withdraw(accountId: string, amount: number, requestId: string): Effect.Effect<number, InsufficientFunds>
  balance(accountId: string): Effect.Effect<number>
}>()("app/Accounts") {
  // R of this layer is Sharding (because Account.client needs it).
  static readonly layer = Layer.effect(
    Accounts,
    Effect.gen(function*() {
      const clientFor = yield* Account.client
      // Transport errors are infrastructure, not domain. Map each to a defect
      // so the typed error channel only carries what a caller can act on.
      return Accounts.of({
        withdraw: (accountId, amount, requestId) =>
          clientFor(accountId).Withdraw({ requestId, amount }).pipe(
            Effect.catchTags({
              MailboxFull: (e) => Effect.die(e),
              AlreadyProcessingMessage: (e) => Effect.die(e),
              PersistenceError: (e) => Effect.die(e),
              EntityNotAssignedToRunner: (e) => Effect.die(e)
            }),
            Effect.withSpan("Accounts.withdraw")
          ),
        balance: (accountId) =>
          clientFor(accountId).Balance().pipe(Effect.orDie)
      })
    })
  )
}
```

### 4. Singletons and cron: one runner, not every runner

```ts import.meta.vitest name="references/cluster/guide.md#4"
import { Duration, Effect, Schedule } from "effect"
import { Singleton } from "effect/cluster"

// Registered on every runner, but only the runner that owns the singleton's
// shard runs it. If that runner dies it starts elsewhere.
// The effect is wrapped in orDie and kept alive after it returns, so a failure
// inside is a defect: retry inside the body instead of letting it escape.
export const Sweeper = Singleton.make(
  "expired-cart-sweeper",
  Effect.gen(function*() {
    yield* Effect.log("sweeping carts")
  }).pipe(
    Effect.repeat(Schedule.spaced(Duration.minutes(1))),
    Effect.retry(Schedule.exponential("1 second")),
    Effect.asVoid
  )
)
```

A singleton is *at most one active runner at a time*, not exactly-once
execution: during a handover the same iteration can run twice, so each
iteration must be idempotent. For wall-clock schedules use
`ClusterCron.make({ name, cron, execute })`; it persists one message per run.
Inside `execute`, `ClusterCron.CurrentScheduledTime` is the time the run was
*scheduled* for (not "now"), which is what an idempotent job should key on.
This fence only builds the layer (a cron fires on wall-clock time), so it is
typechecked, not executed.

```ts
import { Cron, DateTime, Effect } from "effect"
import { ClusterCron } from "effect/cluster"

// Every night at 03:00 UTC. `calculateNextRunFromPrevious: true` makes one
// entity process the runs in order, so a slow run never overlaps the next and
// missed runs are caught up (a failing run blocks later ones until it succeeds
// or is older than `skipIfOlderThan`).
export const NightlyReport = ClusterCron.make({
  name: "nightly-report",
  cron: Cron.parseUnsafe("0 3 * * *", "UTC"),
  calculateNextRunFromPrevious: true,
  execute: Effect.gen(function*() {
    const scheduledFor = yield* ClusterCron.CurrentScheduledTime
    // Key the report on the scheduled day so a replayed run overwrites itself.
    yield* Effect.log(`building report for ${DateTime.formatIso(scheduledFor).slice(0, 10)}`)
  })
})
```

### 5. Composition root and in-process test

Merge all entity layers, provide your own dependencies, then provide *one*
cluster layer. The same entity layers run on `TestRunner.layer` in tests
(in-memory shard assignment and storage, no sockets) and on a real transport
in production.

```ts import.meta.vitest name="references/cluster/guide.md#5"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { ClusterSchema, Entity, TestRunner } from "effect/cluster"
import { Rpc } from "effect/rpc"

class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()(
  "InsufficientFunds",
  { balance: Schema.Number }
) {}
const Withdraw = Rpc.make("Withdraw", {
  payload: { requestId: Schema.String, amount: Schema.Number },
  primaryKey: ({ requestId }) => requestId,
  success: Schema.Number,
  error: InsufficientFunds
}).annotate(ClusterSchema.Persisted, true)
const Balance = Rpc.make("Balance", { success: Schema.Number })
const Account = Entity.make("Account", [Withdraw, Balance])

class Audit extends Context.Service<Audit, {
  record(entry: string): Effect.Effect<void>
}>()("app/Audit") {
  static readonly layerMemory = Layer.effect(
    Audit,
    Effect.gen(function*() {
      const entries = yield* Ref.make<ReadonlyArray<string>>([])
      return Audit.of({ record: (e) => Ref.update(entries, (all) => [...all, e]) })
    })
  )
}

const AccountLayer = Account.toLayer(
  Effect.gen(function*() {
    const audit = yield* Audit
    const balance = yield* Ref.make(100)
    return Account.of({
      Withdraw: Effect.fnUntraced(function*({ payload }) {
        const current = yield* Ref.get(balance)
        if (current < payload.amount) return yield* new InsufficientFunds({ balance: current })
        yield* audit.record(payload.requestId)
        return yield* Ref.updateAndGet(balance, (n) => n - payload.amount)
      }),
      Balance: () => Ref.get(balance).pipe(Rpc.fork)
    })
  })
)

// Production would be:
//   AccountLayer.pipe(Layer.provide(Audit.layerLive), Layer.provide(ClusterLayer))
//   Layer.launch(thatLayer).pipe(NodeRuntime.runMain)
// where ClusterLayer is NodeClusterSocket.layer({ storage: "sql" }) and
// needs a SqlClient. See references/deployment.md.
const TestLayer = AccountLayer.pipe(
  Layer.provide(Audit.layerMemory),
  Layer.provideMerge(TestRunner.layer)
)

const program = Effect.gen(function*() {
  const client = (yield* Account.client)("acct-1")

  const first = yield* client.Withdraw({ requestId: "r1", amount: 30 })
  // Same primaryKey: persisted delivery returns the first reply, the handler
  // does not run again. This is what makes client retries safe.
  const again = yield* client.Withdraw({ requestId: "r1", amount: 30 })

  // The domain error is typed on the client and round-trips as a class.
  const error = yield* client.Withdraw({ requestId: "r2", amount: 500 }).pipe(Effect.flip)

  return { first, again, error: error instanceof InsufficientFunds ? [error._tag, error.balance] : error._tag, balance: yield* client.Balance() }
})

const result = await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
result // => { first: 70, again: 70, error: ["InsufficientFunds", 70], balance: 70 }
```

## Anti-patterns

**Treating handler memory as durable.** The activation can end at any moment
(idle timeout, rebalance, deploy), and the `Ref` goes with it.

```ts skip
// WRONG: balance exists only in this activation; a rebalance resets it to 0
Account.toLayer(Effect.gen(function*() {
  const balance = yield* Ref.make(0)
  /* ... */
}))
```

Right: load the initial value from a service in the `toLayer` effect (recipe
step 2) and write through to it on every change.

**A non-idempotent persisted RPC with no `primaryKey`.** Persisted messages
are redelivered after a crash; without a key, a client retry creates a second
message and the charge runs twice.

```ts skip
// WRONG: two sends = two withdrawals
Rpc.make("Withdraw", { payload: { amount: Schema.Number }, success: Schema.Number })
  .annotate(ClusterSchema.Persisted, true)
```

Right: put a caller-generated request id in the payload and
`primaryKey: ({ requestId }) => requestId`. Generate the id once per user
intent, outside any retry loop.

**Generating the request id inside the retried effect.** A fresh key per
attempt defeats deduplication.

```ts skip
// WRONG: every retry gets a new key
Effect.suspend(() => client.Withdraw({ requestId: crypto.randomUUID(), amount: 5 })).pipe(
  Effect.retry({ times: 3 })
)
```

Right: `const requestId = crypto.randomUUID()` (or an `Effect.sync` evaluated
once) before the retried effect.

**Calling the client from inside the entity's own handler and waiting.**
Handlers run one at a time, so an entity that awaits a message to itself
deadlocks.

```ts skip
// WRONG: Withdraw waits for Balance on the same entity id
Withdraw: ({ payload }) => selfClient.Balance().pipe(Effect.flatMap(/* ... */))
```

Right: read the local `Ref`/state directly, or mark the read handler
`Rpc.fork`, or send with `{ discard: true }`.

**Leaking cluster errors into domain signatures.** `MailboxFull` or
`PersistenceError` in your use case's `E` forces every caller to handle
infrastructure.

```ts skip
// WRONG: Effect<number, InsufficientFunds | MailboxFull | PersistenceError | ...>
const withdraw = (id: string) => clientFor(id).Withdraw({ requestId: "r", amount: 1 })
```

Right: wrap the client in a service (recipe step 3) and map transport errors
to defects or to one domain error of your own.

**Long blocking work in a handler.** Because handlers are serialized, a
slow handler delays every later message for that ID and fills the mailbox
(`MailboxFull` for volatile sends).

```ts skip
// WRONG: 30 s of work inside the handler blocks the entity
Export: () => Effect.sleep("30 seconds").pipe(Effect.as("done"))
```

Right: acknowledge quickly and do the long work with [workflow](../workflow/guide.md), or
set `concurrency` on `toLayer` and use `Rpc.fork` only on handlers that are
safe to overlap.

**Expecting a singleton to be exactly-once.** Handover can re-run an
iteration, and a failing body is turned into a defect.

```ts skip
// WRONG: not idempotent, and a failure kills the singleton
Singleton.make("billing", chargeEveryone)
```

Right: make the body idempotent (keyed writes), put `Effect.retry` inside it
(recipe step 4), and use `ClusterCron` for scheduled work.

**Using real networking and time in unit tests.** It makes tests slow and
flaky and tests transport, not logic.

Right: test handler logic with `Entity.makeTestClient`, routing and
persistence with `TestRunner.layer` (next section).

## Testing it

Pick the smallest tool that covers the behaviour (`effect@4.1.2`):

- **`Entity.makeTestClient(entity, layer)`** returns
  `(entityId) => Effect<client>`. It registers your entity layer against a
  fake Sharding and wires client to server with no serialization and no
  storage. It needs `Scope` and `ShardingConfig`, so wrap in `Effect.scoped`
  and provide `ShardingConfig.layerDefaults`. Use it for handler logic and
  typed errors. It does not exercise persistence, `primaryKey` dedup, shard
  ownership or singletons.
- **`TestRunner.layer`** is a full in-memory Sharding with in-memory
  `MessageStorage` and `RunnerStorage` and no network. Use
  `Layer.provideMerge(TestRunner.layer)` so tests can also reach `Sharding`
  and `MessageStorage`. Use it for persisted messages, dedup (recipe step 5),
  singletons and `Account.client`.
- Fake your own dependencies (`Ledger.layerMemory`) with ordinary layers.

```ts import.meta.vitest name="references/cluster/guide.md#13"
import { Effect, Ref, Schema } from "effect"
import { Entity, ShardingConfig } from "effect/cluster"
import { Rpc } from "effect/rpc"

const Add = Rpc.make("Add", { payload: { n: Schema.Number }, success: Schema.Number })
const Total = Entity.make("Total", [Add])

const TotalLayer = Total.toLayer(
  Effect.gen(function*() {
    const sum = yield* Ref.make(0)
    return Total.of({
      Add: ({ payload }) => Ref.updateAndGet(sum, (s) => s + payload.n)
    })
  })
)

const test = Effect.scoped(
  Effect.gen(function*() {
    const makeClient = yield* Entity.makeTestClient(Total, TotalLayer)
    const a = yield* makeClient("a")
    const b = yield* makeClient("b")
    return [
      yield* a.Add({ n: 2 }),
      yield* a.Add({ n: 3 }),
      // Entities are isolated per id.
      yield* b.Add({ n: 1 })
    ]
  })
).pipe(Effect.provide(ShardingConfig.layerDefaults))

const sums = await Effect.runPromise(test)
sums // => [2, 5, 1]
```

### With `@effect/vitest`

`@effect/vitest` (same version as `effect`) runs these programs as tests.
`it.effect` provides `TestClock`, which is right for `Entity.makeTestClient`
(no sharding, no background fibers) but **stalls `TestRunner.layer`**: Sharding's
polling and shard-lock fibers sleep on the test clock and never wake. Run
sharding tests with `it.live` and the real clock, and keep them free of long
sleeps (passivation and cron windows are minutes, so test those by logic, not
by waiting).

```ts
import { it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import { ClusterSchema, Entity, ShardingConfig, TestRunner } from "effect/cluster"
import { Rpc } from "effect/rpc"
import { assert, describe } from "vitest"

const Add = Rpc.make("Add", {
  payload: { requestId: Schema.String, n: Schema.Number },
  primaryKey: ({ requestId }) => requestId,
  success: Schema.Number
}).annotate(ClusterSchema.Persisted, true)
const Total = Entity.make("Total", [Add])

const TotalLayer = Total.toLayer(
  Effect.gen(function*() {
    const sum = yield* Ref.make(0)
    return Total.of({ Add: ({ payload }) => Ref.updateAndGet(sum, (s) => s + payload.n) })
  })
)

describe("Total", () => {
  // Handler logic: no sharding, so the test clock is fine.
  it.effect("adds per entity id", () =>
    Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(Total, TotalLayer)
      const a = yield* makeClient("a")
      yield* a.Add({ requestId: "1", n: 2 })
      assert.strictEqual(yield* a.Add({ requestId: "2", n: 3 }), 5)
    }).pipe(Effect.scoped, Effect.provide(ShardingConfig.layerDefaults)))

  // Routing and persistence: full in-memory sharding, real clock.
  it.live("dedups a retried persisted message", () =>
    Effect.gen(function*() {
      const client = (yield* Total.client)("a")
      yield* client.Add({ requestId: "1", n: 2 })
      assert.strictEqual(yield* client.Add({ requestId: "1", n: 2 }), 2)
    }).pipe(Effect.provide(TotalLayer.pipe(Layer.provideMerge(TestRunner.layer)))))
})
```

Time-based behaviour (`maxIdleTime`, cron) depends on `Clock`; with
`TestRunner` it cannot be driven by `TestClock`, so put the schedule-sensitive
decision in a plain function and unit-test that instead.

## Boundaries

- [rpc](../rpc/guide.md) owns `Rpc.make`, `RpcGroup` and transport serialization.
  An entity protocol is an RPC group with cluster annotations; learn payload,
  error and stream schemas there.
- [workflow](../workflow/guide.md) owns durable multi-step executions (activities, sleeps,
  compensation). It runs on top of cluster through `ClusterWorkflowEngine`;
  cluster alone only decides which runner owns a message.
- [sql](../sql/guide.md) owns the `SqlClient` that `SqlMessageStorage` and
  `SqlRunnerStorage` use, and the database where entity state should be
  persisted.
- [persistence](../persistence/guide.md) owns caches and key-value stores; entity memory is not
  a cache you can rely on.
- [services](../services/guide.md) owns `Context.Service` and `Layer` composition used
  throughout the recipe; [schema](../schema/guide.md) owns the payload and error schemas.
- Errors cross the boundary in two lanes: the RPC `error` schema (domain,
  typed, serialized) and cluster transport errors (`MailboxFull`,
  `PersistenceError`, ...). Resources: per-activation scope closes on
  passivation; use `EntityResource` when a handle must survive restarts.

## Changed in 4.1

- `ClusterCron.CurrentScheduledTime` (a `DateTime.Utc` service) is available
  inside `execute`, and `calculateNextRunFromPrevious: true` runs the job
  through one ordered entity (no overlap, catch-up after downtime).
- New `ClusterSchema.InterruptOnTermination` annotation for long-lived
  requests that should be interrupted when the entity starts terminating;
  persisted ones resume on the next owner.
- Mailbox metrics: `mailboxMetrics` option on `toLayer`/`toLayerQueue` and
  `ShardingConfig.entityMailboxMetrics` (gauge `effect_cluster_entity_mailbox_size`).
- `ShardingConfig.runnerJoinDebounce` delays shard assignment to runners that
  joined late, to ride out rolling deploys.
- `SingleRunner.layer` and SQL message storage need a `Digest` from
  `effect/crypto` (`NodeCrypto.layerDigest`) instead of the old `Crypto` service.
- Persisted sends made inside a message-storage transaction are notified after
  commit, and reply delivery for stored requests was reworked; no API change.

## References

- [references/deployment.md](deployment.md): runner layers
  (socket, HTTP, SQL, single runner), `ShardingConfig` fields, shard groups,
  annotations and cluster errors, verified against 4.1.2.
- [Entity API](https://effect.website/docs/v4/api/effect/cluster/Entity)
- [Sharding API](https://effect.website/docs/v4/api/effect/cluster/Sharding)
- [ClusterSchema API](https://effect.website/docs/v4/api/effect/cluster/ClusterSchema)
- [Pinned Entity source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/cluster/Entity.ts)
- [Pinned upstream example](https://github.com/Effect-TS/effect/blob/effect%404.1.2/ai-docs/src/80_cluster/10_entities.ts)
