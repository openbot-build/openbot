# Effect persistence

## How to think about it

`effect/persistence` is four small tools that share one idea: **the storage
engine is a Layer, the semantics are in your types**. Your code asks for a
`KeyValueStore`, a `PersistedCache`, a `PersistedQueue`, or a `RateLimiter`;
a store layer decides whether that means a `Map`, files, a SQL table, or
Redis. Tests use memory, production uses something durable, and the code in
between never changes.

Each tool trades something away, so pick by the guarantee you need:

- **KeyValueStore**: strings and bytes by key. No queries, no transactions.
  `toSchemaStore` adds JSON + Schema so values are typed.
- **PersistedCache**: a read-through cache whose entries are *Exits*: both
  successes and typed failures are stored, each with its own TTL. It is a
  cache, so losing an entry must be harmless.
- **PersistedQueue**: durable work handoff with **at-least-once** delivery.
  A crash after your handler succeeds but before the acknowledgement
  redelivers the item. Handlers must be idempotent; `offer` de-duplicates by
  id for you.
- **RateLimiter**: counters in a shared store. A limit is only global if every
  process uses the same store.

If you come from Redis clients or `localStorage`: do not scatter
`JSON.parse(await redis.get(...))` through the code. Decode with a Schema in one
place. If you come from BullMQ/SQS: there is no separate worker process model;
a worker is an Effect that loops on `queue.take` inside a scope owned by a Layer.
If you reach for "exactly once", stop: you get at-least-once plus idempotency.

## Choose

| Situation | Use | Why / when not |
| --- | --- | --- |
| Small durable config, flags, last-seen cursor | `KeyValueStore` + `toSchemaStore` | No concurrency control: `modify` is read-then-write |
| Counter, balance, anything read-modify-write | SQL transaction ([sql](../sql/guide.md)) or `Ref` in-process | KV `modify` can lose updates across processes |
| Memoize an expensive or rate-limited lookup across restarts | `PersistedCache.make` + `Persistable.Class` request | Needs `Persistence` layer; entries expire by your TTL |
| In-process memo only | `Cache` (see [state](../state/guide.md)) | No serialization cost |
| Background job that must not be lost (email, webhook, outbox) | `PersistedQueue` | At-least-once; not ordered work; not a workflow engine |
| Multi-step process with timers/signals and resume | [workflow](../workflow/guide.md) | A queue has no notion of progress |
| Facts you append and replay | [eventlog](../eventlog/guide.md) | A queue deletes work when done |
| Throttle calls to a paid API across instances | `RateLimiter` + shared store | Memory store limits one process only |
| Relational queries | [sql](../sql/guide.md) | KV has no query model |

## Recipe

### 1. Typed key-value state

Wrap the store with `KeyValueStore.prefix("settings/v1/")` and
`KeyValueStore.toSchemaStore(store, Settings)` to get `get/set/modify` over typed
values; swap `layerMemory` for `layerFileSystem(dir)`, `layerSql()` or
`layerStorage(...)` without touching the program. The full runnable version is in
[references/examples.md](examples.md).

### 2. A persisted cache that remembers failures differently

A cache key is a **request object** that knows its primary key and its
success/error schemas. That is what lets the cache serialize both outcomes.

```ts import.meta.vitest name="references/persistence/guide.md#1"
import { Duration, Effect, Exit, Schema } from "effect"
import { PersistedCache, Persistable, Persistence } from "effect/persistence"

class Rate extends Schema.Class<Rate>("Rate")({ currency: Schema.String, perUsd: Schema.Number }) {}
class UnknownCurrency extends Schema.TaggedError<UnknownCurrency>()("UnknownCurrency", {
  currency: Schema.String
}) {}

// Persistable.Class<{ payload }>()(tag, { primaryKey, success, error })
class GetRate extends Persistable.Class<{ payload: { readonly currency: string } }>()("GetRate", {
  primaryKey: (payload) => `rate/${payload.currency}`, // becomes the storage key
  success: Rate,
  error: UnknownCurrency // typed failures are cached too
}) {}

let upstreamCalls = 0
const fetchRate = (req: GetRate) => {
  upstreamCalls++
  return req.currency === "EUR"
    ? Effect.succeed(new Rate({ currency: "EUR", perUsd: 0.92 }))
    : Effect.fail(new UnknownCurrency({ currency: req.currency }))
}

const program = Effect.gen(function*() {
  const rates = yield* PersistedCache.make(fetchRate, {
    storeId: "rates", // namespaces this cache inside the Persistence backend
    // TTL is a function of the Exit: stable facts live long, "not found" is
    // short so a newly listed currency appears soon, and transient failures
    // would be shorter still (or return 0 to skip storing).
    timeToLive: (exit) => Exit.isSuccess(exit) ? Duration.hours(6) : Duration.minutes(1)
  })

  const first = yield* rates.get(new GetRate({ currency: "EUR" }))
  const again = yield* rates.get(new GetRate({ currency: "EUR" })) // no upstream call
  const missing = yield* rates.get(new GetRate({ currency: "XXX" })).pipe(Effect.flip)
  yield* rates.invalidate(new GetRate({ currency: "EUR" })) // drop from store AND memory
  return { rate: first.perUsd, same: first === again, missing: missing._tag, upstreamCalls }
}).pipe(
  Effect.scoped, // the cache's store is scoped
  // Memory here; swap for Persistence.layerSql / layerRedis / layerKvs in production.
  Effect.provide(Persistence.layerMemory)
)

const out = await Effect.runPromise(program)
out // => { rate: 0.92, same: true, missing: "UnknownCurrency", upstreamCalls: 2 }
```

`rates.get` can fail with `UnknownCurrency | PersistenceError | SchemaError`:
the first is the lookup's own error, the other two are storage faults. Map
storage faults to defects in your service so callers see only domain errors.

### 3. A durable outbox with an idempotent worker and a shared rate limit

The use case enqueues; a Layer-owned fiber delivers. The queue guarantees the
job survives a crash; the dedupe id and the handler's idempotency make
redelivery safe.

```ts import.meta.vitest name="references/persistence/guide.md#2"
import { Context, Effect, Layer, Ref, Schedule, Schema } from "effect"
import { PersistedQueue, RateLimiter } from "effect/persistence"

const EmailJob = Schema.Struct({ to: Schema.String, subject: Schema.String })
type EmailJob = typeof EmailJob.Type

export class DeliveryRejected extends Schema.TaggedError<DeliveryRejected>()("DeliveryRejected", {
  to: Schema.String
}) {}

export class Mailer extends Context.Service<Mailer, {
  send(job: EmailJob): Effect.Effect<void, DeliveryRejected>
  readonly sent: Effect.Effect<ReadonlyArray<EmailJob>>
}>()("app/Mailer") {
  // In-memory double that records what it "sent".
  static readonly layerMemory = Layer.effect(
    Mailer,
    Effect.gen(function*() {
      const sent = yield* Ref.make<ReadonlyArray<EmailJob>>([])
      return Mailer.of({ send: (job) => Ref.update(sent, (all) => [...all, job]), sent: Ref.get(sent) })
    })
  )
}

const makeQueue = PersistedQueue.make({
  name: "emails", // part of the storage key: renaming abandons queued work
  schema: EmailJob, // encoded as JSON on offer, decoded on take
  maxAttempts: 5 // then the item is marked failed (kept as the dead-letter record)
})

export class Outbox extends Context.Service<Outbox, {
  enqueue(job: EmailJob, dedupeKey: string): Effect.Effect<void>
}>()("app/Outbox") {
  static readonly layer = Layer.effect(
    Outbox,
    Effect.gen(function*() {
      const queue = yield* makeQueue
      const enqueue = Effect.fn("Outbox.enqueue")(
        function*(job: EmailJob, dedupeKey: string) {
          // Same id again is a no-op (until layerCleanup expires it), so a
          // retried HTTP request cannot send two welcome emails.
          yield* queue.offer(job, { id: dedupeKey })
        },
        Effect.orDie // storage/encoding faults are not the caller's problem
      )
      return Outbox.of({ enqueue })
    })
  )

  // The worker has no service interface: it is a background fiber owned by
  // the Layer's scope, so it is interrupted cleanly on shutdown.
  static readonly layerWorker = Layer.effectDiscard(
    Effect.gen(function*() {
      const queue = yield* makeQueue
      const mailer = yield* Mailer
      const withLimiter = yield* RateLimiter.makeWithRateLimiter

      // take() claims ONE item. If the handler fails, the item is requeued
      // with the retry schedule and take() fails with the handler's error; if it
      // succeeds the item is acknowledged. So the loop must survive failures.
      const processOne = queue.take((job, meta) =>
        Effect.logInfo("sending", job.to, `attempt ${meta.attempts}`).pipe(
          Effect.andThen(
            mailer.send(job).pipe(
              // "delay" waits instead of failing; the key is shared by every
              // worker that uses the same RateLimiterStore.
              withLimiter({ key: "mailer", limit: 10, window: "1 second", onExceeded: "delay" })
            )
          )
        )
      )
      yield* processOne.pipe(
        Effect.catch((error) => Effect.logWarning("job failed; it will be retried", error)),
        Effect.forever,
        Effect.forkScoped
      )
    })
  )
}

// Composition root: choose stores once. Replace the two memory stores with
// layerStoreSql(...) / layerStoreRedis(...) to make this durable and shared.
const Infra = Layer.mergeAll(
  PersistedQueue.layer.pipe(Layer.provide(PersistedQueue.layerStoreMemory)),
  RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))
)
const App = Layer.mergeAll(
  Outbox.layer,
  Outbox.layerWorker.pipe(Layer.provide(Mailer.layerMemory))
).pipe(Layer.provide(Infra))

const main = Effect.gen(function*() {
  const outbox = yield* Outbox
  const mailer = yield* Mailer
  yield* outbox.enqueue({ to: "ada@example.com", subject: "Welcome" }, "welcome:ada")
  yield* outbox.enqueue({ to: "ada@example.com", subject: "Welcome" }, "welcome:ada") // deduped
  // Poll until the worker has delivered, then give a duplicate time to show up.
  yield* mailer.sent.pipe(
    Effect.repeat({ until: (sent) => sent.length > 0, schedule: Schedule.spaced("5 millis") })
  )
  yield* Effect.sleep("30 millis")
  return (yield* mailer.sent).map((job) => job.to)
}).pipe(Effect.provide(Layer.mergeAll(App, Mailer.layerMemory)))

await Effect.runPromise(main) // => ["ada@example.com"]
```

Production additions: run `PersistedQueue.layerCleanup({ interval, timeToLive,
failedTimeToLive })` in *one* instance (completed ids are kept 30 days by
default so dedupe works; failed items stay forever unless `failedTimeToLive` is
set), and alert on failed items.

### 4. Key listing, prefix views, and bulk delete (4.1)

`KeyValueStore` has `keys` (a snapshot, unordered) and `clearPrefix(prefix)`.
A `prefix(...)` view sees only its own keys, with the prefix stripped, and its
`clear` removes only those keys instead of wiping the store.

```ts import.meta.vitest name="references/persistence/guide.md#3"
import { Effect } from "effect"
import { KeyValueStore } from "effect/persistence"

const program = Effect.gen(function*() {
  const kv = yield* KeyValueStore.KeyValueStore
  const sessions = KeyValueStore.prefix(kv, "sessions/")
  yield* sessions.set("ada", "token-1")
  yield* sessions.set("bob", "token-2")
  yield* kv.set("settings/theme", "dark")

  const seen = [...(yield* sessions.keys)].sort() // keys of the view, prefix removed
  yield* sessions.clear // only "sessions/*"
  const left = [...(yield* kv.keys)].sort() // the settings key survived
  yield* kv.clearPrefix("settings/") // bulk delete by prefix on the raw store
  return { seen, left, size: yield* kv.size }
})

const result = await Effect.runPromise(program.pipe(Effect.provide(KeyValueStore.layerMemory)))
result // => { seen: ["ada", "bob"], left: ["settings/theme"], size: 0 }
```

### 5. Delayed jobs

`queue.offer(value, { id?, delay? })` postpones the first delivery. The memory
store checks its clock, so `TestClock` drives it with no real waiting.

```ts import.meta.vitest name="references/persistence/guide.md#4"
import { Effect, Fiber, Layer, Schema } from "effect"
import { PersistedQueue } from "effect/persistence"
import { TestClock } from "effect/testing"

const Reminder = Schema.Struct({ text: Schema.String })

const program = Effect.gen(function*() {
  const queue = yield* PersistedQueue.make({ name: "reminders", schema: Reminder })
  yield* queue.offer({ text: "stand up" }, { delay: "10 minutes" })

  // Nothing is deliverable yet, so a worker blocked in take() stays blocked.
  const worker = yield* Effect.forkChild(queue.take((r) => Effect.succeed(r.text)))
  yield* TestClock.adjust("9 minutes")
  const early = worker.pollUnsafe() === undefined
  yield* TestClock.adjust("1 minute")
  const later = yield* Fiber.join(worker)
  return { early, later }
}).pipe(
  Effect.provide(PersistedQueue.layer.pipe(Layer.provide(PersistedQueue.layerStoreMemory))),
  Effect.provide(TestClock.layer())
)

const result = await Effect.runPromise(program)
result // => { early: true, later: "stand up" }
```

A duplicate `offer` with the same `id` ignores its `delay`; an infinite delay
stores nothing. SQL rounds delays up to whole seconds; Redis compares the
offering and polling processes' clocks.

### 6. A circuit breaker around a flaky dependency (4.0.7+, experimental)

`effect/persistence` also exports `CircuitBreaker`: one policy, many keyed
circuits, state in a `CircuitBreakerStore` (`layerStoreMemory()` in-process,
`layerStoreRedis` shared). Closed calls run; after the trip policy fires the
circuit is Open and calls fail fast with `CircuitBreakerError` (reason
`CircuitOpen`, with `retryAfter`) without running; then one probe decides.

```ts import.meta.vitest name="references/persistence/guide.md#5"
import { Data, Effect, Ref } from "effect"
import { CircuitBreaker } from "effect/persistence"

class QuoteUnavailable extends Data.TaggedError("QuoteUnavailable") {}

const program = Effect.gen(function*() {
  const breaker = yield* CircuitBreaker.make({
    tripPolicy: CircuitBreaker.consecutive(2), // two failures in a row open it
    openDuration: "30 seconds"
  })
  const calls = yield* Ref.make(0)
  const quote = Ref.update(calls, (n) => n + 1).pipe(
    Effect.andThen(Effect.fail(new QuoteUnavailable())),
    breaker.execute({ key: "quotes" })
  )

  yield* Effect.flip(quote)
  yield* Effect.flip(quote)
  const rejected = yield* Effect.flip(quote) // fails fast: the dependency is not called
  const state = yield* breaker.state("quotes")
  return { reason: rejected instanceof CircuitBreaker.CircuitBreakerError ? rejected.reason._tag : "other", state: state._tag, calls: yield* Ref.get(calls) }
}).pipe(Effect.scoped, Effect.provide(CircuitBreaker.layerStoreMemory()))

const result = await Effect.runPromise(program)
result // => { reason: "CircuitOpen", state: "Open", calls: 2 }
```

Put `Effect.retry` and `Effect.timeout` *inside* `breaker.execute` so the
breaker sees one outcome per call. It never waits: retry rejections outside it
(wait at least `retryAfter`). Use one policy per key, and cap an exponential
`openDuration` with `Schedule.upTo`.

## Anti-patterns

**Read-modify-write on the KV store.**

```ts skip
yield* kv.modify("visits", (n) => String(Number(n) + 1)) // two processes both read 41
```

Consequence: lost updates. Right: a SQL `UPDATE ... SET n = n + 1`, or an
in-process `Ref` when one process is the owner.

**Caching only what you remember to cache.** A `timeToLive` that returns the
same long duration for every `Exit` caches a transient outage for hours.
Right: branch on the exit (`Exit.isSuccess`) and keep failures short or zero.

**A non-idempotent queue handler.**

```ts skip
queue.take((job) => chargeCard(job).pipe(Effect.andThen(markPaid(job))))
```

Consequence: a crash between the two steps charges again on redelivery.
Right: derive a business idempotency key from the job (`job.orderId`) and pass
it to the provider, or make the effect a conditional write.

**Fire-and-forget worker in `main`.** `Effect.runFork(worker)` or an unscoped
`Effect.fork` leaks the fiber and ignores shutdown. Right: `Effect.forkScoped`
inside a `Layer.effectDiscard`, as in the recipe.

**A loop that dies on the first failure.** `Effect.forever(queue.take(...))`
stops when one handler fails, because `take` fails with the handler's error.
Right: `Effect.catch`/`Effect.catchCause` inside the loop and log; the queue,
not the loop, owns retries.

**Memory stores in production.** `layerStoreMemory`/`layerMemory` look
identical to the real ones and silently lose everything on restart; a memory
`RateLimiter` store enforces the limit per process, not per fleet. Right: put
the choice behind one `Infra` layer and select by `Config`.

**Unstable storage keys.** Renaming `name: "emails"` or `storeId`, or changing
the `Persistable.Class` `primaryKey` format, orphans existing data. Right:
treat names, key formats, and schemas as a versioned contract.

**Storing secrets or large blobs in KV or queue items.** Items are plain JSON
rows readable by anyone with store access. Right: store a reference or id and
load the secret through `Config`/`Redacted` at use time.

## Testing it

Use the memory layers and the test clock; both retries and TTLs are driven by
`Clock`, so no real waiting. This test (plain `effect` + `node:assert`, runs
as-is) proves a failing job is retried only after its backoff elapses.

```ts import.meta.vitest name="references/persistence/guide.md#6"
import { Effect, Fiber, Layer, Ref, Schedule, Schema } from "effect"
import { PersistedQueue } from "effect/persistence"
import { TestClock } from "effect/testing"
import assert from "node:assert/strict"

class Boom extends Schema.TaggedError<Boom>()("Boom", {}) {}
const Job = Schema.Struct({ n: Schema.Int })

const test = Effect.gen(function*() {
  const queue = yield* PersistedQueue.make({
    name: "jobs",
    schema: Job,
    maxAttempts: 3,
    retrySchedule: Schedule.spaced("10 seconds")
  })
  const attempts = yield* Ref.make(0)
  yield* queue.offer({ n: 1 })

  // Fails on attempt 1, succeeds on attempt 2. meta.attempts is 1-based.
  const handle = queue.take((job, meta) =>
    Ref.update(attempts, (n) => n + 1).pipe(
      Effect.andThen(meta.attempts < 2 ? Effect.fail(new Boom()) : Effect.succeed(job.n))
    )
  )

  const failure = yield* Effect.flip(handle)
  assert.equal(failure._tag, "Boom")

  // The retry is invisible until the delay passes on the virtual clock.
  const second = yield* Effect.forkChild(handle)
  yield* TestClock.adjust("10 seconds")
  assert.equal(yield* Fiber.join(second), 1)
  assert.equal(yield* Ref.get(attempts), 2)
}).pipe(
  Effect.provide(PersistedQueue.layer.pipe(Layer.provide(PersistedQueue.layerStoreMemory))),
  Effect.provide(TestClock.layer())
)

await Effect.runPromise(test)
```

With `@effect/vitest`, `it.effect` runs the body with `TestClock` installed, so
TTLs and retry delays are driven by `TestClock.adjust`. This is a real test
file (typechecked here, and run with `vitest`): the rate limiter admits `limit`
calls in a window, rejects the next with a typed reason, and admits again once
the window passes.

```ts
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { RateLimiter } from "effect/persistence"
import { TestClock } from "effect/testing"

const Limiter = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))

describe("RateLimiter", () => {
  it.effect("rejects past the limit and recovers after the window", () =>
    Effect.gen(function*() {
      const limiter = yield* RateLimiter.RateLimiter
      const options = { key: "api", limit: 2, window: "1 minute", algorithm: "fixed-window" } as const

      yield* limiter.consume(options)
      yield* limiter.consume(options)
      const error = yield* Effect.flip(limiter.consume(options))
      expect(error.reason._tag).toBe("RateLimitExceeded")

      yield* TestClock.adjust("1 minute")
      const again = yield* limiter.consume(options)
      expect(again.remaining).toBe(1)
    }).pipe(Effect.provide(Limiter)))
})
```

## Boundaries

- [schema](../schema/guide.md): owns the codecs. Every persisted value is a Schema; changing
  a Schema changes your on-disk format.
- [sql](../sql/guide.md): supplies the `SqlClient` for `layerSql`, `Persistence.layerSql`,
  and `PersistedQueue.layerStoreSql`; also the right tool for transactional counters.
- [services](../services/guide.md): layers, scopes, `forkScoped` workers.
- [time](../time/guide.md): `Schedule` for `retrySchedule`, `TestClock`.
- [state](../state/guide.md): in-process `Ref`/`Cache` when durability is not needed.
- [workflow](../workflow/guide.md): durable execution with timers and signals builds on these
  stores; use it instead of a hand-rolled queue state machine.
- [eventlog](../eventlog/guide.md): append-only event storage.
- [platform](../platform/guide.md): `NodeFileSystem`, `NodePath`, `NodeRedis` layers.
- [testing](../testing/guide.md): general test-layer strategy.

Errors cross at the service edge: `KeyValueStoreError`, `PersistenceError`,
`PersistedQueueError`, and `RateLimiterError` are infrastructure faults; keep
them out of domain signatures. Resources cross at the Layer: stores, Redis
clients, and workers all live in the application scope.

## Changed in 4.1

- `KeyValueStore` gained `keys` and `clearPrefix(prefix)`; `prefix(...)` views
  now implement `keys`, `size`, `isEmpty`, and a prefix-scoped `clear`
  (custom backends built with `KeyValueStore.make` get `clearPrefix` derived
  from `keys`, so supply `keys`).
- `PersistedQueue.offer` accepts `delay`; `id` in the options is optional.
- `PersistedCache` treats an undecodable stored entry (`SchemaError` on read,
  such as after a schema change) as a miss and calls the lookup again.
- New `CircuitBreaker` module (since 4.0.7, experimental) and `UserDirectories`
  (per-user config/cache/data directory paths by platform).
- `Redis` gained `reserve` (a pooled, dedicated connection for blocking
  commands such as `BLPOP`/`XREAD BLOCK`).
- `Persistence.layerSqlMultiTable` builds table names from `storeId`: avoid
  dots, case-only differences and very long ids, or use the shared-table
  `layerSql`.
- `RateLimiter` with `limit <= 0` admits nothing (`RateLimitExceeded` in fail
  mode, infinite `delay` in delay mode) instead of dividing by zero.

## References

- Typed KV store example: [references/examples.md](examples.md)
- Verified signatures, store matrix, options: [references/api.md](api.md)
- [KeyValueStore API](https://effect.website/docs/v4/api/effect/persistence/KeyValueStore)
- [PersistedCache API](https://effect.website/docs/v4/api/effect/persistence/PersistedCache)
- [PersistedQueue API](https://effect.website/docs/v4/api/effect/persistence/PersistedQueue)
- [RateLimiter API](https://effect.website/docs/v4/api/effect/persistence/RateLimiter)
- [Pinned KeyValueStore source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/persistence/KeyValueStore.ts)
- [Pinned PersistedQueue source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/persistence/PersistedQueue.ts)
- [Pinned PersistedCache source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/persistence/PersistedCache.ts)
