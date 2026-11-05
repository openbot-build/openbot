# Fiber lifetimes, interruption, Pool and PubSub (effect@4.1.2)

Read this when a background fiber "disappears", "never stops", or a cleanup does
not run. Every snippet is runnable.

## Who ends a fiber?

| Fork | Ended by |
| --- | --- |
| `Effect.forkChild` | its own completion, or the end of the **forking fiber** (not the enclosing `Effect.gen` block), or an explicit `Fiber.interrupt` |
| `Effect.forkScoped` | its own completion or the closing of the current `Scope` |
| `Effect.forkIn(scope)` | its own completion or the closing of `scope` |
| `Effect.forkDetach` | its own completion or an explicit interrupt; nothing else |

The classic bug is expecting `forkChild` inside a helper function to be cleaned
up when the helper returns. It is not: the helper runs in the caller's fiber. To
give a region its own lifetime, open a scope around it.

```ts import.meta.vitest name="references/concurrency/lifetimes-and-interruption.md#1"
import { Effect } from "effect"

const events: Array<string> = []

const region = Effect.scoped(
  Effect.gen(function*() {
    yield* Effect.forkScoped(
      Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void events.push("worker interrupted")))),
      // Without startImmediately the fork may not have begun when the scope closes,
      // and a fiber interrupted before it starts runs none of its code.
      { startImmediately: true }
    )
    events.push("region body finished")
  })
)

await Effect.runPromise(region)
events // => ["region body finished", "worker interrupted"]
```

## Interruption is a normal, typed-away outcome

Interrupting a fiber does not throw into your code. The runtime stops the fiber
at its next suspension point, runs finalizers (`acquireRelease` release,
`Effect.ensuring`, `Effect.onExit`, `Effect.onInterrupt`, scope finalizers) and
completes the fiber with an interrupt `Cause`. `Fiber.interrupt` returns only after
those finalizers have run.

Code that must not be split is wrapped in `Effect.uninterruptible`. When part of it
is a long wait that should stay cancellable, use `uninterruptibleMask`:

```ts import.meta.vitest name="references/concurrency/lifetimes-and-interruption.md#2"
import { Effect, Fiber } from "effect"

const program = Effect.gen(function*() {
  const events: Array<string> = []
  const fiber = yield* Effect.forkChild(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        events.push("commit start")
        yield* Effect.sleep("20 millis") // atomic section: interrupt waits for it
        events.push("commit end")
        yield* restore(Effect.sleep("1 hour")) // cancellable again
        events.push("unreachable")
      })
    ),
    { startImmediately: true }
  )
  yield* Effect.sleep("5 millis")
  yield* Fiber.interrupt(fiber) // returns after "commit end"
  return events
})

await Effect.runPromise(program) // => ["commit start", "commit end"]
```

`Effect.acquireRelease` already makes its acquire step uninterruptible and
guarantees release; prefer it over hand-built masks.

Consequences for design:

- Do not write `try { await ... } catch { /* ignore */ }` equivalents: catching
  *every* `Cause` (`Effect.catchCause`, `Effect.exit` without inspection) also
  catches interruption and makes a fiber hard to stop. Handle `E` with `catchTag`.
- The loser of `Effect.race`, the body of `Effect.timeout`, siblings of a failed
  `forEach`, and the previous fiber in a `FiberHandle`/`FiberMap` are all
  interrupted. Make their side effects idempotent or transactional.
- A caller waiting on a `Deferred` that gets interrupted cancels only the wait.
  If the job should be cancelled too, put the job fiber in a `FiberMap` keyed by
  job id and interrupt that.

## Handling "queue ended"

A `Queue<A, Cause.Done>` fails `take` with `Done` once it was ended **and
drained**. Three ways to consume it:

```ts import.meta.vitest name="references/concurrency/lifetimes-and-interruption.md#3"
import { Cause, Effect, Queue } from "effect"

const program = Effect.gen(function*() {
  const queue = yield* Queue.bounded<number, Cause.Done>(8)
  yield* Queue.offerAll(queue, [1, 2, 3])
  yield* Queue.end(queue)

  // 1. Loop until Done and swallow only Done.
  const seen: Array<number> = []
  yield* Queue.take(queue).pipe(
    Effect.tap((n) => Effect.sync(() => void seen.push(n))),
    Effect.forever,
    Effect.catchTag("Done", () => Effect.void)
  )

  // 2. Or gather everything until Done in one call (on a fresh queue).
  const other = yield* Queue.bounded<number, Cause.Done>(8)
  yield* Queue.offerAll(other, [4, 5])
  yield* Queue.end(other)
  const rest = yield* Queue.collect(other)

  return { seen, rest }
})

await Effect.runPromise(program) // => { seen: [1, 2, 3], rest: [4, 5] }
// 3. For pipelines, convert with Stream.fromQueue (see ../streams/guide.md).
```

`Queue.shutdown` is different: it discards buffered messages and interrupts
waiting takers. Use `end` for graceful, `shutdown` for abort.

## Pool

A `Pool` owns reusable resources (connections, workers). Construction needs a
`Scope`; the pool's items are released when that scope closes. `Pool.use` borrows
one for the duration of an effect and returns it afterwards, even on failure or
interruption.

```ts import.meta.vitest name="references/concurrency/lifetimes-and-interruption.md#4"
import { Effect, Pool } from "effect"

const program = Effect.scoped(
  Effect.gen(function*() {
    let opened = 0
    const pool = yield* Pool.make({
      // acquireRelease: the pool runs `release` when it retires the item.
      acquire: Effect.acquireRelease(
        Effect.sync(() => ({ id: ++opened })),
        () => Effect.void
      ),
      size: 2 // fixed number of items; use makeWithTTL for min/max and idle expiry
    })
    const ids = yield* Effect.forEach(
      [1, 2, 3, 4],
      () => Pool.use(pool, (connection) => Effect.sleep("5 millis").pipe(Effect.as(connection.id))),
      { concurrency: 4 } // four callers share two items
    )
    const stats = yield* Pool.stats(pool) // 4.1: point-in-time counts, handy for gauges
    return { ids, opened, idle: stats.idle, pending: stats.pending }
  })
)

const result = await Effect.runPromise(program)
result.opened // => 2
result.idle // => 2
result.pending // => 0
```

When an item is known to be bad, `Pool.invalidate(pool, item)` retires it so the
next borrower gets a fresh one. A pool bounds *items*; to bound *callers*, add a
`Semaphore` or an explicit queue. Pool has no acquisition timeout option:
`Pool.use(pool, f).pipe(Effect.timeout("5 seconds"))`.

## Holding permits for a scope

`sem.withPermits(n)(eff)` holds permits for one effect. When the permits should live
as long as a *scope* (a leased resource, a request-scoped section), use
`takeScoped` (new in 4.1): taking the permits and registering their release happen in
one uninterruptible step, so they are always returned when the scope closes.

```ts import.meta.vitest name="references/concurrency/lifetimes-and-interruption.md#6"
import { Effect, Semaphore } from "effect"

const program = Effect.gen(function*() {
  const sem = yield* Semaphore.make(2)
  const during = yield* Effect.scoped(
    Effect.gen(function*() {
      yield* sem.takeScoped(2)
      // Both permits are held: nothing else can enter until this scope closes.
      return yield* sem.withPermitsIfAvailable(1)(Effect.succeed("entered"))
    })
  )
  const after = yield* sem.withPermitsIfAvailable(1)(Effect.succeed("entered"))
  return { during, after }
})

const result = await Effect.runPromise(program)
result.during._tag // => "None"
result.after._tag // => "Some"
```

## PubSub with replay

`PubSub` broadcasts to subscribers that exist at publish time. A `replay` window
lets late subscribers receive the last N messages first.

```ts import.meta.vitest name="references/concurrency/lifetimes-and-interruption.md#5"
import { Effect, PubSub } from "effect"

const program = Effect.scoped(
  Effect.gen(function*() {
    const events = yield* PubSub.bounded<number>({ capacity: 8, replay: 2 })
    yield* PubSub.publishAll(events, [1, 2, 3])

    // Subscription needs a Scope: leaving it unsubscribes.
    const subscription = yield* PubSub.subscribe(events)
    const replayed = yield* PubSub.takeAll(subscription)
    yield* PubSub.publish(events, 4)
    const live = yield* PubSub.take(subscription)
    return { replayed, live }
  })
)

await Effect.runPromise(program) // => { replayed: [2, 3], live: 4 }
```

Strategy matters: `bounded` makes `publish` wait for the slowest subscriber
(backpressure), `dropping` discards new messages when full, `sliding` evicts the
oldest. Choose per event type, and never use PubSub as a durable log. As a
service, expose `publish` and a `subscribe: Stream` (see the upstream example in
`node_modules/effect/ai-docs/src/01_effect/07_pubsub/10_pubsub.ts`) and shut the
PubSub down in a layer finalizer.
