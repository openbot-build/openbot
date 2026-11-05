# ScopedRef, RcRef, RcMap, TxRef and MutableRef (effect@4.1.2)

All snippets run as written.

## ScopedRef: a resource that can be replaced

Use `ScopedRef` when the value needs releasing and may change at runtime. `set`
acquires the new one first and releases the old one, so readers never hold a
closed client.

```ts import.meta.vitest name="references/state/rc-and-transactions.md#1"
import { Effect, ScopedRef } from "effect"

const closed: Array<string> = []

const client = (version: string) =>
  Effect.acquireRelease(
    Effect.sync(() => ({ version })),
    (c) => Effect.sync(() => void closed.push(c.version))
  )

const program = Effect.scoped(
  Effect.gen(function*() {
    const current = yield* ScopedRef.fromAcquire(client("v1"))
    yield* ScopedRef.set(current, client("v2")) // closes v1
    return (yield* ScopedRef.get(current)).version
  }) // leaving the scope closes v2
)

await Effect.runPromise(program) // => "v2"
closed // => ["v1", "v2"]
```

## RcRef: share one resource, release when idle

`RcRef` is "an `acquireRelease` that many users share". The first `RcRef.get`
acquires; later gets reuse; when the last user's scope closes, the resource is
released after `idleTimeToLive`. Use it for a connection every request wants but
that should close when traffic stops. The user's scope is what holds the reference,
so use `Effect.scoped` (or a request scope) around the code that uses the value.

```ts import.meta.vitest name="references/state/rc-and-transactions.md#2"
import { Effect, RcRef } from "effect"
import { TestClock } from "effect/testing"

const program = Effect.scoped(
  Effect.gen(function*() {
    const log: Array<string> = []
    const shared = yield* RcRef.make({
      acquire: Effect.acquireRelease(
        Effect.sync(() => {
          log.push("open")
          return 42
        }),
        () => Effect.sync(() => void log.push("close"))
      ),
      idleTimeToLive: "1 minute"
    })

    // Two sequential users: one open.
    yield* Effect.scoped(RcRef.get(shared))
    yield* Effect.scoped(RcRef.get(shared))
    log.push("users done")

    yield* TestClock.adjust("2 minutes") // idle time elapses -> close
    return log
  })
).pipe(Effect.provide(TestClock.layer()))

await Effect.runPromise(program) // => ["open", "users done", "close"]
```

`RcMap.make({ lookup: (key) => acquire, idleTimeToLive })` is the keyed version:
one resource per tenant, each released independently when idle. `RcMap.get(map, key)`
needs a `Scope`, like `RcRef.get`.

## TxRef: atomic updates across several values

Use a transaction when two or more independent cells must change together or a
fiber must wait until a condition over them holds. Inside `Effect.tx`, reads and
writes go to a journal and commit only if nothing they touched changed; on a
conflict the transaction re-runs. `Effect.txRetry` says "my precondition is not
met: re-run when something I read changes", which is a blocking wait with no
polling.

```ts import.meta.vitest name="references/state/rc-and-transactions.md#3"
import { Effect, Fiber, TxRef } from "effect"

const program = Effect.gen(function*() {
  const from = yield* TxRef.make(100)
  const to = yield* TxRef.make(0)

  const transfer = (amount: number) =>
    Effect.tx(
      Effect.gen(function*() {
        const balance = yield* TxRef.get(from)
        // Not enough money: block until `from` changes, then retry the whole body.
        if (balance < amount) return yield* Effect.txRetry
        yield* TxRef.set(from, balance - amount)
        yield* TxRef.update(to, (n) => n + amount)
      })
    )

  const waiting = yield* Effect.forkChild(transfer(150), { startImmediately: true })
  yield* TxRef.update(from, (n) => n + 100) // a deposit wakes the transfer
  yield* Fiber.join(waiting)
  return { from: yield* TxRef.get(from), to: yield* TxRef.get(to) }
})

await Effect.runPromise(program) // => { from: 50, to: 150 }
```

Guidance: if the values belong to the same invariant, put them in **one**
`Ref<{ from: number; to: number }>` and use `Ref.modify`; that is simpler and
faster. Reach for Tx when the values live in different services, or when you
need `txRetry` blocking semantics (`TxQueue`, `TxSemaphore`, `TxHashMap` are built
this way). Transactions retry their body, so keep the body free of side effects
other than Tx operations.

## MutableRef: synchronous, no Effect

```ts import.meta.vitest name="references/state/rc-and-transactions.md#4"
import { MutableRef } from "effect"

// Allocation-free counter for a hot synchronous path (for example a logger sink).
const counter = MutableRef.make(0)
const next = (): number => MutableRef.incrementAndGet(counter)

next() // => 1
next() // => 2
```

It is not a coordination tool. Two fibers can still interleave between a
`MutableRef.get` and a `set` if you `yield*` in the middle. Use it only inside
one synchronous function.
