# Effect state

## How to think about it

Concurrent code does not fail because two things run at the same time. It fails
because a program **reads, decides, and writes in separate steps**, and another
fiber gets in between. Effect fibers interleave at every `yield*`, so
`const n = yield* Ref.get(r); yield* Ref.set(r, n + 1)` loses updates exactly like
a database read-modify-write without a transaction.

The Effect answer is to stop thinking of state as a variable and think of it as
a **cell with atomic transitions**. You hand the cell a *pure function* from
the old state to `[result, newState]`; the cell applies it indivisibly and gives
back the result. Everything you want to decide ("is there enough stock?")
happens *inside* that function, on a consistent snapshot, and anything with side
effects (failing, logging, I/O) happens *after*, using the result.

Two consequences shape every design:

- **State is owned by a service, never global.** The `Ref` is created inside a
  `Layer`, kept private, and exposed only through intention-revealing methods
  (`reserve`, `markReady`), so invariants live in one place and tests get a fresh
  state per layer.
- **Pick the primitive by what the transition needs.** Pure transition: `Ref`.
  Transition that must run an Effect (I/O, a clock read): `SynchronizedRef`. Others
  must observe changes: `SubscriptionRef`. The value is a resource with a
  lifecycle: `ScopedRef` / `RcRef`. Several values change together: `TxRef`.

Coming from JS: a `let` or a `Map` in module scope "works" until two requests
interleave, and it silently survives between tests. A `Ref` makes the cell
explicit and the interleaving points visible.

## Choose

| Situation | Use | Why / when not |
| --- | --- | --- |
| Counter, flag, small in-memory store; transition is pure | `Ref` + `Ref.modify` / `Ref.update` | Default. Atomic, cheap. Do the decision inside `modify` |
| Transition needs an Effect (call an API, read the clock, load a file) | `SynchronizedRef` + `modifyEffect` / `updateEffect` | Calls are serialized, so concurrent callers wait. Never nest another operation on the same ref inside (deadlock) |
| Single-flight refresh/initialisation (token, config) | `SynchronizedRef<Option<A>>` | Exactly one fiber loads; the rest reuse the result |
| Others must react to changes; "wait until X" | `SubscriptionRef` + `changes` (a `Stream`) | `changes` emits the current value first, then each update |
| A client/connection that may be swapped at runtime (config reload) | `ScopedRef` | `set` acquires the new value and releases the old one |
| One shared resource, acquired on first use, released when unused | `RcRef` (`idleTimeToLive`) | Reference counted across scopes. Keyed: `RcMap` |
| Update several values atomically, or block until a condition on them | `TxRef` + `Effect.tx` + `Effect.txRetry` | New in v4; use only if two `Ref`s cannot be merged into one |
| Synchronous hot path, no Effect around | `MutableRef` and `MutableHashMap` | No fiber safety beyond JS single-threading; never across a `yield*` |
| Memoize one effect's result | `Effect.cached` / `Effect.cachedWithTTL` | Not a `Ref` problem |
| Broadcast events, queue work | not this skill: [concurrency](../concurrency/guide.md) | A `SubscriptionRef` is state with history of one, not an event bus |

Merge related fields into **one** `Ref` holding an immutable record before you
reach for transactions: one cell is atomic for free.

## Recipe

### The pitfall: read, then write

```ts skip
// WRONG: another fiber can run between the two yields. 100 concurrent callers can
// end with a count of 1, and a "reserve" check can pass twice for the last item.
const reserve = (stock: Ref.Ref<number>, qty: number) =>
  Effect.gen(function*() {
    const have = yield* Ref.get(stock)
    if (have < qty) return yield* Effect.fail("out of stock")
    yield* Ref.set(stock, have - qty)
  })
```

### The idiom: decide inside `modify`, fail outside

`Ref.modify` takes `(current) => [result, next]`. The check and the update are
one indivisible step; the failure is raised afterwards from the *result*. The
state is an immutable record that is copied, never mutated in place.

```ts import.meta.vitest name="references/state/guide.md#2"
import { Context, Effect, Layer, Ref, Schema } from "effect"

export class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {
  sku: Schema.String,
  requested: Schema.Int,
  available: Schema.Int
}) {}

// The service interface exposes behaviour, not the Ref.
export class Inventory extends Context.Service<Inventory, {
  reserve(sku: string, quantity: number): Effect.Effect<void, OutOfStock>
  available(sku: string): Effect.Effect<number>
}>()("app/Inventory") {
  static readonly layerMemory = (initial: Readonly<Record<string, number>>) =>
    Layer.effect(
      Inventory,
      Effect.gen(function*() {
        // Created per layer build: every test gets its own state.
        const stock = yield* Ref.make<Readonly<Record<string, number>>>(initial)

        return Inventory.of({
          reserve: Effect.fn("Inventory.reserve")(function*(sku, quantity) {
            const outcome = yield* Ref.modify(stock, (current): readonly [
              { readonly ok: true } | { readonly ok: false; readonly available: number },
              Readonly<Record<string, number>>
            ] => {
              // Pure: decide and compute the next state from one snapshot.
              const available = current[sku] ?? 0
              return available >= quantity
                ? [{ ok: true }, { ...current, [sku]: available - quantity }]
                : [{ ok: false, available }, current]
            })
            // Side effects (here: failing) come after the atomic step.
            if (!outcome.ok) {
              return yield* new OutOfStock({ sku, requested: quantity, available: outcome.available })
            }
          }),
          available: (sku) => Ref.get(stock).pipe(Effect.map((current) => current[sku] ?? 0))
        })
      })
    )
}

// Five concurrent buyers, three items: exactly three succeed, never a fourth.
export const demo = Effect.gen(function*() {
  const inventory = yield* Inventory
  const results = yield* Effect.forEach(
    Array.from({ length: 5 }),
    () => Effect.exit(inventory.reserve("sku-1", 1)),
    { concurrency: "unbounded" }
  )
  return results.filter((exit) => exit._tag === "Success").length
}).pipe(Effect.provide(Inventory.layerMemory({ "sku-1": 3 })))

await Effect.runPromise(demo) // => 3
```

### Effectful transition: single-flight token refresh

The refresh calls the network and reads the clock, so a plain `Ref` cannot
express it. `SynchronizedRef.modifyEffect` runs the whole Effect while holding
the cell, so ten concurrent callers cause **one** login and share its result.
The price is that they all wait, which is the point here.

```ts import.meta.vitest name="references/state/guide.md#3"
import { Clock, Context, Effect, Layer, Option, Schema, SynchronizedRef } from "effect"

export class AuthFailed extends Schema.TaggedError<AuthFailed>()("AuthFailed", {
  reason: Schema.String
}) {}

interface Token {
  readonly value: string
  readonly expiresAt: number
}

export class Auth extends Context.Service<Auth, {
  readonly token: Effect.Effect<string, AuthFailed>
}>()("app/Auth") {
  static readonly layer = (login: Effect.Effect<Token, AuthFailed>) =>
    Layer.effect(
      Auth,
      Effect.gen(function*() {
        const cached = yield* SynchronizedRef.make(Option.none<Token>())
        const token = SynchronizedRef.modifyEffect(cached, (current) =>
          Effect.gen(function*() {
            // Clock, not Date.now: TestClock can expire the token in a test.
            const now = yield* Clock.currentTimeMillis
            if (Option.isSome(current) && current.value.expiresAt > now) {
              return [current.value.value, current] as const
            }
            // A failure here leaves the old state untouched and is typed AuthFailed.
            const fresh = yield* login
            return [fresh.value, Option.some(fresh)] as const
          })
        )
        return Auth.of({ token })
      })
    )
}

let logins = 0
const login = Effect.gen(function*() {
  logins++
  yield* Effect.sleep("20 millis")
  return { value: `token-${logins}`, expiresAt: (yield* Clock.currentTimeMillis) + 60_000 }
})

export const demo = Effect.gen(function*() {
  const auth = yield* Auth
  const tokens = yield* Effect.forEach(Array.from({ length: 10 }), () => auth.token, { concurrency: "unbounded" })
  return { distinct: new Set(tokens).size, logins }
}).pipe(Effect.provide(Auth.layer(login)))

await Effect.runPromise(demo) // => { distinct: 1, logins: 1 }
```

### Observable state: wait for a condition

`SubscriptionRef` is a `Ref` whose updates are also published. `changes` is a
`Stream` that starts with the current value, so a late subscriber never misses
the state it joined in. Expose the stream and the operations, not the ref.

```ts import.meta.vitest name="references/state/guide.md#4"
import assert from "node:assert/strict"
import { Context, Effect, Fiber, Layer, Stream, SubscriptionRef } from "effect"

export type Status = "starting" | "ready" | "degraded"

export class Health extends Context.Service<Health, {
  readonly changes: Stream.Stream<Status>
  set(status: Status): Effect.Effect<void>
  readonly untilReady: Effect.Effect<void>
}>()("app/Health") {
  static readonly layer = Layer.effect(
    Health,
    Effect.gen(function*() {
      const status = yield* SubscriptionRef.make<Status>("starting")
      return Health.of({
        changes: SubscriptionRef.changes(status),
        set: (next) => SubscriptionRef.set(status, next),
        // No polling: suspend until the stream produces "ready".
        untilReady: SubscriptionRef.changes(status).pipe(
          Stream.filter((s) => s === "ready"),
          Stream.take(1),
          Stream.runDrain
        )
      })
    })
  )
}

const test = Effect.gen(function*() {
  const health = yield* Health
  // Subscribe before changing state; startImmediately makes the subscription deterministic.
  const seen = yield* Effect.forkChild(Stream.runCollect(Stream.take(health.changes, 3)), { startImmediately: true })
  const waiter = yield* Effect.forkChild(health.untilReady, { startImmediately: true })
  yield* health.set("ready")
  yield* health.set("degraded")
  yield* Fiber.join(waiter)
  assert.deepEqual(yield* Fiber.join(seen), ["starting", "ready", "degraded"])
}).pipe(Effect.provide(Health.layer))

await Effect.runPromise(test)
```

### A resource that can be replaced

When the value needs releasing and may change at runtime (config reload), hold it in
a `ScopedRef`: `ScopedRef.set` acquires the new value first, then releases the old one,
so readers never see a closed client. Runnable example in
[references/rc-and-transactions.md](rc-and-transactions.md).

## Anti-patterns

**1. Read then write.** `yield* Ref.get` followed by `yield* Ref.set`. Right:
`Ref.modify` / `Ref.update`. Consequence: lost updates and double-spends under
load that never show in single-fiber tests.

**2. Mutating inside the Ref.**

```ts skip
yield* Ref.get(cache).pipe(Effect.tap((map) => Effect.sync(() => map.set(k, v)))) // in-place mutation
```
Right: store immutable values and replace them: `Ref.update(cache, (m) => new Map(m).set(k, v))`
(or a `HashMap` from `effect`). Consequence: the mutation bypasses atomicity and
observers (`SubscriptionRef`), and callers holding the old value see it change.

**3. Side effects inside `update`/`modify`.**

```ts skip
Ref.update(ref, (n) => { console.log(n); void fetch("/x"); return n + 1 })
```
Right: keep the function pure; return what you need and act afterwards, or use
`SynchronizedRef.updateEffect` when the step itself is effectful. Consequence:
effects hidden from `E`/`R`, untestable, and no cancellation.

**4. Global state.** `export const counter = Ref.makeUnsafe(0)` at module scope.
Right: create the ref inside `Layer.effect` and expose methods. Consequence: state
leaks across tests and requests, and `R` no longer tells you who touches it.

**5. Exposing the `Ref` in the service interface.** Callers can then write any
state, bypassing invariants. Right: expose operations (`reserve`, `markReady`).
Consequence: invariants are enforced by convention, not by the type.

**6. Nesting operations on one `SynchronizedRef`.** Calling `SynchronizedRef.update(r, ...)`
inside `SynchronizedRef.updateEffect(r, ...)` waits for a lock the same fiber
holds, and hangs forever. Right: compute everything in one `modifyEffect`, or move
the inner step outside. Also keep slow I/O out of the lock when callers should
not queue behind it: fetch first, then do a short `Ref.modify` with a re-check.

**7. Replacing a resource held in a `Ref`.** `Ref.set(clientRef, newClient)` never
closes the old client. Right: `ScopedRef.set`, which releases it. Consequence:
leaked connections after every reload.

**8. Reaching for transactions or an event bus too early.** `TxRef` for a counter,
`SubscriptionRef` as a message bus. Right: one `Ref` holding a record; `PubSub` /
`Queue` ([concurrency](../concurrency/guide.md)) for events. Consequence: needless complexity; a
`SubscriptionRef` replays only the latest value to late joiners and buffers
every update for slow ones without bound.

## Testing it

State bugs only appear under interleaving, so test with many concurrent fibers
and assert the **invariant** (exactly N successes, no duplicates), not a
particular order. A per-test layer gives each test a clean slate. For time-based
state (token expiry, TTL) provide `TestClock.layer()` and `TestClock.adjust`.

```ts import.meta.vitest name="references/state/guide.md#7"
import assert from "node:assert/strict"
import { Clock, Effect, Option, Ref, SynchronizedRef } from "effect"
import { TestClock } from "effect/testing"

// The Auth idea from above, reduced to a function so the test is self-contained.
const makeToken = Effect.gen(function*() {
  const logins = yield* Ref.make(0)
  const cached = yield* SynchronizedRef.make(Option.none<{ value: number; expiresAt: number }>())
  const token = SynchronizedRef.modifyEffect(cached, (current) =>
    Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      if (Option.isSome(current) && current.value.expiresAt > now) return [current.value.value, current] as const
      const value = yield* Ref.updateAndGet(logins, (n) => n + 1)
      return [value, Option.some({ value, expiresAt: now + 60_000 })] as const
    }))
  return { token, logins }
})

const test = Effect.gen(function*() {
  // 1. The invariant holds under 1000 concurrent updates.
  const hits = yield* Ref.make(0)
  yield* Effect.forEach(Array.from({ length: 1000 }), () => Ref.update(hits, (n) => n + 1), {
    concurrency: "unbounded",
    discard: true
  })
  assert.equal(yield* Ref.get(hits), 1000)

  // 2. Single-flight: ten concurrent callers cause one login.
  const { logins, token } = yield* makeToken
  yield* Effect.forEach(Array.from({ length: 10 }), () => token, { concurrency: "unbounded", discard: true })
  assert.equal(yield* Ref.get(logins), 1)

  // 3. Expiry is driven by the TestClock, not by sleeping.
  yield* TestClock.adjust("59 seconds")
  yield* token
  assert.equal(yield* Ref.get(logins), 1)
  yield* TestClock.adjust("2 seconds")
  yield* token
  assert.equal(yield* Ref.get(logins), 2)
}).pipe(Effect.provide(TestClock.layer()))

await Effect.runPromise(test)
```

The `@effect/vitest` form of check 1 above (typechecked here; put it in a `*.test.ts`):

```ts
import { expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"

it.effect("1000 concurrent updates lose nothing", () =>
  Effect.gen(function*() {
    const hits = yield* Ref.make(0)
    yield* Effect.forEach(Array.from({ length: 1000 }), () => Ref.update(hits, (n) => n + 1), {
      concurrency: "unbounded",
      discard: true
    })
    expect(yield* Ref.get(hits)).toBe(1000)
  }))
```

In such a suite, the body of each `Effect.gen` above goes into
`it.effect("...", () => ...)` and the layer under test is attached with
`Effect.provide(Inventory.layerMemory({ ... }))`. The in-memory layer **is** the
test double: keep one `layerMemory` per stateful service next to the real layer.
To prove a negative ("the naive version loses updates"), run the pitfall with
`Effect.yieldNow` between the read and the write under `concurrency: "unbounded"`
and assert the count is below the target.

## Boundaries

- Queues, `PubSub`, `Semaphore`, `Latch`, fibers: [concurrency](../concurrency/guide.md). A
  semaphore limits parallelism; it does not make a read-modify-write atomic.
- Scopes, `acquireRelease`, layer construction, who closes what: [services](../services/guide.md).
  `ScopedRef`, `RcRef` and `RcMap` all need a `Scope` and release through it.
- `Stream` operators on `SubscriptionRef.changes`: [streams](../streams/guide.md).
- Time sources (`Clock`, `TestClock`) and expiry policies: [time](../time/guide.md).
- Durable or shared-across-processes state (database, cache servers, cluster
  entities): [sql](../sql/guide.md), [persistence](../persistence/guide.md) and [cluster](../cluster/guide.md). Everything
  here is lost when the process exits.

## References

- [API families and naming rules](api-cheatsheet.md)
- [RcRef, RcMap, transactions and MutableRef, with runnable examples](rc-and-transactions.md)
- [Effect API: Ref](https://effect.website/docs/v4/api/effect/Ref)
- [Effect API: SynchronizedRef](https://effect.website/docs/v4/api/effect/SynchronizedRef)
- [Effect API: SubscriptionRef](https://effect.website/docs/v4/api/effect/SubscriptionRef)
- [Effect API: ScopedRef](https://effect.website/docs/v4/api/effect/ScopedRef)
- [Effect API: TxRef](https://effect.website/docs/v4/api/effect/TxRef)
- [Pinned Ref source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Ref.ts)
- [Pinned SynchronizedRef source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/SynchronizedRef.ts)
