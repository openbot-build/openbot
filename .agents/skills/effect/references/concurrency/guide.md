# Effect concurrency

## How to think about it

A fiber is Effect's unit of concurrent execution: a cheap, interruptible,
cooperatively scheduled "thread" that runs one `Effect`. The point is not
speed. The point is that concurrent work has the same three properties as
sequential Effect code: its failures are typed, its requirements (`R`) are
tracked, and its resources are released, **including when it is cancelled**.
`Promise` gives you none of that: you cannot cancel a promise, a rejected
promise nobody awaits is a crash or a silent loss, and `Promise.all` leaves the
losers running.

Two ideas carry almost everything:

1. **Declare concurrency, do not spawn it.** Most programs never touch a fiber.
   You write `Effect.forEach(items, work, { concurrency: 8 })`,
   `Effect.race(a, b)` or `effect.pipe(Effect.timeout("2 seconds"))`, and the
   runtime forks, joins and interrupts for you. Failure of one branch
   interrupts its siblings, and every branch's finalizers run. Reach for an
   explicit fork only when work must outlive the call that started it.
2. **Every fiber has an owner.** A fiber is either joined by someone, or tied
   to a parent fiber, or tied to a `Scope`. "Fire and forget" has no place in
   the vocabulary: you say *what ends it*. `Effect.forkScoped` inside a Layer
   means "this lives as long as the service". `Effect.forkChild` means "this
   dies when the forking fiber ends". `Effect.forkDetach` means "nobody owns
   this", which is a leak unless you hold the handle.

Coordination primitives (`Queue`, `Deferred`, `Semaphore`, `Latch`, `PubSub`)
suspend a *fiber*, not a thread, so waiting is free and there is never a reason
to poll or sleep in a loop. Choosing a primitive is choosing a loss policy:
what happens when the producer is faster than the consumer (block, drop,
slide) and who is allowed to see a message (one consumer, all subscribers).

Coming from Promise/async: there is no `await` race to "forget", but there is a
new failure mode, the **lifetime bug**. A fiber forked in the wrong place lives
too long (leaked work) or dies too soon (interrupted mid-job). Most of this
skill is about picking the right owner.

## Choose

| Situation | Use | Why / when not |
| --- | --- | --- |
| Run N effects at once, wait for all | `Effect.forEach(xs, f, { concurrency: n })` / `Effect.all` | Bounded, ordered results, first failure interrupts the rest. Never `"unbounded"` over input you do not control |
| Same, but collect failures instead of aborting | `Effect.partition`, `Effect.all(..., { mode: "result" })`, or `f(x).pipe(Effect.result)` | Failures become values; you decide what a partial result means |
| Give up after a time | `Effect.timeout(d)` (adds `TimeoutError` to `E`), `timeoutOption`, `timeoutOrElse` | The work is interrupted, not abandoned |
| First of several alternatives | `Effect.race` (first *success*), `Effect.raceAll`, `Effect.raceFirst` (first *completion*) | Losers are interrupted: they must be interruptible and idempotent |
| Work that outlives the caller, inside a service | `Effect.forkScoped` in `Layer.effect` | Interrupted when the layer's scope closes |
| Helper fiber that must not outlive this fiber | `Effect.forkChild` + `Fiber.join` / `Fiber.interrupt` | Lifetime is the whole forking fiber, not the enclosing block |
| Many dynamic background fibers | `FiberSet.make` / `FiberSet.run` | Scope-owned set; `FiberSet.join` surfaces the first failure |
| One task per key; new request replaces/dedupes | `FiberMap.run(map, key, eff)` | Same key interrupts the old fiber (or `onlyIfMissing`) |
| "Latest wins" (search-as-you-type) | `FiberHandle.run` | Single slot; replacing interrupts the previous fiber |
| Hand one result to a waiting fiber, or signal "ready" | `Deferred` | Completes once; many waiters; carries a typed error |
| Gate that many fibers wait on and that can reopen | `Latch` (`Latch.make`, `open`, `whenOpen`) | Not one-shot like Deferred |
| Each message to exactly one consumer (work queue) | `Queue.bounded` / `dropping` / `sliding` | Pick the overflow policy on purpose. `Queue.unbounded` is a memory leak waiting for a spike |
| Each message to every subscriber (events) | `PubSub.bounded` (+ `replay`) | Subscribers only see messages after subscribing (unless `replay`). Not a work queue, not durable |
| Limit concurrent use of a scarce thing | `Semaphore.make(n)` + `sem.withPermits(1)(eff)` | Permits are released on failure and interruption |
| Reusable expensive resources (connections) | `Pool.make({ acquire, size })` + `Pool.use` | Pool owns lifecycle, needs a Scope |
| Atomic shared state across fibers | not this skill: [state](../state/guide.md) | |
| Stream processing with concurrency | not this skill: [streams](../streams/guide.md) | |

## Recipe

### The pitfall: fire-and-forget with a callback

```ts skip
// WRONG: the service forks work with no owner and no result channel.
const requestThumbnail = (id: string) => {
  void renderThumbnail(id).then((url) => cache.set(id, url)) // failure vanishes
  return "queued"                                            // caller cannot await or cancel
}
// Under load, nothing bounds how many renders run; at shutdown nothing waits for them.
```

### The idiom: a worker service with a bounded queue and a result per job

Design decisions, in order: the queue is **bounded and dropping** so overload
becomes a typed rejection the caller can handle instead of memory growth; each
job carries a `Deferred` so the caller gets a typed result (or failure) back;
workers are `forkScoped` so they belong to the layer; the layer's finalizer
**ends** the queue and waits for workers, so shutdown drains accepted work.

```ts import.meta.vitest name="references/concurrency/guide.md#2"
import { Cause, Context, Deferred, Effect, Fiber, Layer, Queue, Schema } from "effect"

// Expected failures are tagged data the caller can branch on.
export class ThumbnailFailed extends Schema.TaggedError<ThumbnailFailed>()("ThumbnailFailed", {
  imageId: Schema.String
}) {}
export class Overloaded extends Schema.TaggedError<Overloaded>()("Overloaded", {}) {}

// A job pairs the input with the place its result goes.
interface Pending {
  readonly imageId: string
  readonly result: Deferred.Deferred<string, ThumbnailFailed>
}

export class Thumbnails extends Context.Service<Thumbnails, {
  request(imageId: string): Effect.Effect<string, ThumbnailFailed | Overloaded>
}>()("app/Thumbnails") {
  // The renderer is a parameter so tests can pass a fake; in an app it would be
  // another service obtained with `yield*` inside the layer.
  static readonly layer = (options: {
    readonly workers: number
    readonly capacity: number
    readonly render: (imageId: string) => Effect.Effect<string, ThumbnailFailed>
  }) =>
    Layer.effect(
      Thumbnails,
      Effect.gen(function*() {
        // `Cause.Done` in the error channel is how a Queue says "no more input".
        const queue = yield* Queue.dropping<Pending, Cause.Done>(options.capacity)

        // Run one job and ship its Exit (success OR failure) to the waiting caller.
        // Capturing the Exit means a failing job never kills the worker.
        const runJob = (job: Pending) =>
          Effect.exit(options.render(job.imageId)).pipe(
            Effect.flatMap((exit) => Deferred.done(job.result, exit))
          )

        // take suspends the fiber (no polling). When the queue is ended and
        // drained, take fails with Done; that is the loop's normal exit.
        const worker = Queue.take(queue).pipe(
          Effect.flatMap(runJob),
          Effect.forever,
          Effect.catchTag("Done", () => Effect.void)
        )

        // forkScoped: owned by this layer's scope, interrupted if it closes.
        const fibers = yield* Effect.forEach(
          Array.from({ length: options.workers }),
          () => Effect.forkScoped(worker)
        )

        // Graceful shutdown: stop intake, let workers finish what was accepted.
        yield* Effect.addFinalizer(() => Queue.end(queue).pipe(Effect.andThen(Fiber.awaitAll(fibers))))

        return Thumbnails.of({
          request: Effect.fn("Thumbnails.request")(function*(imageId) {
            const result = yield* Deferred.make<string, ThumbnailFailed>()
            // A dropping queue answers `false` when full or ended.
            const accepted = yield* Queue.offer(queue, { imageId, result })
            if (!accepted) return yield* new Overloaded()
            // If the caller is interrupted here, only the wait is cancelled; the
            // job still runs. Decide whether that is acceptable for your domain.
            return yield* Deferred.await(result)
          })
        })
      })
    )
}

// A caller sees one clean signature: no queue, no fibers, E and R explicit.
export const renderAll = (ids: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const thumbnails = yield* Thumbnails
    // Concurrency here is the *submission* fan-out; the worker count is the real limit.
    return yield* Effect.forEach(ids, (id) => thumbnails.request(id), { concurrency: 16 })
  })

export const main = renderAll(["a", "b", "c"]).pipe(
  Effect.provide(
    Thumbnails.layer({
      workers: 2,
      capacity: 100,
      render: (id) => Effect.sleep("10 millis").pipe(Effect.as(`${id}.png`))
    })
  )
)

await Effect.runPromise(main) // => ["a.png", "b.png", "c.png"]
```

### Bounded fan-out with a timeout and a best-effort mode

```ts import.meta.vitest name="references/concurrency/guide.md#3"
import { Effect, Result, Schema } from "effect"

class FetchFailed extends Schema.TaggedError<FetchFailed>()("FetchFailed", { url: Schema.String }) {}

// Stand-in for an HttpClient call. Real code would depend on a service here.
const fetchPage = (url: string) =>
  Effect.sleep("20 millis").pipe(
    Effect.andThen(url.includes("bad") ? Effect.fail(new FetchFailed({ url })) : Effect.succeed(`<html>${url}</html>`)),
    // Per-item budget. `E` gains `TimeoutError`; the slow request is interrupted, not abandoned.
    Effect.timeout("2 seconds")
  )

// All-or-nothing: the first failure interrupts the in-flight siblings.
export const fetchAll = (urls: ReadonlyArray<string>) =>
  Effect.forEach(urls, fetchPage, { concurrency: 8 })

// Best effort: failures become values, so nothing is interrupted. [pages, failures]
export const fetchBestEffort = (urls: ReadonlyArray<string>) =>
  Effect.partition(urls, fetchPage, { concurrency: 8 })

// Per-item Result keeps positions aligned with the input.
export const fetchKeepOrder = (urls: ReadonlyArray<string>) =>
  Effect.forEach(urls, (url) => Effect.result(fetchPage(url)), { concurrency: 8 }).pipe(
    Effect.map((results) => results.filter(Result.isSuccess).length)
  )

// Hedged request: if the primary has not answered in 200ms, race a backup.
// The loser is interrupted, so both calls must be safe to cancel.
export const hedged = (url: string) =>
  Effect.race(fetchPage(url), fetchPage(`${url}?mirror`).pipe(Effect.delay("200 millis")))

const [pages, failures] = await Effect.runPromise(fetchBestEffort(["a", "bad", "c"]))
pages // => ["<html>a</html>", "<html>c</html>"]
failures.map((e) => e._tag) // => ["FetchFailed"]
await Effect.runPromise(fetchKeepOrder(["a", "bad", "c"])) // => 2
```

### Latest wins and per-key tasks

```ts import.meta.vitest name="references/concurrency/guide.md#4"
import { Effect, FiberHandle, FiberMap } from "effect"

const program = Effect.scoped(
  Effect.gen(function*() {
    // One slot. Running a new effect interrupts the previous one.
    const latest = yield* FiberHandle.make<string>()
    const search = (query: string) =>
      FiberHandle.run(latest, Effect.sleep("20 millis").pipe(Effect.as(query)))
    yield* search("e")
    yield* search("ef")
    yield* search("eff") // only this one completes
    yield* FiberHandle.awaitEmpty(latest)

    // One fiber per key; same key replaces. `onlyIfMissing` dedupes instead.
    const exports = yield* FiberMap.make<string>()
    yield* FiberMap.run(exports, "tenant-1", Effect.sleep("50 millis"), { onlyIfMissing: true })
    yield* FiberMap.run(exports, "tenant-1", Effect.sleep("50 millis"), { onlyIfMissing: true })
    return yield* FiberMap.size(exports)
  })
) // scope exit interrupts every remaining fiber

await Effect.runPromise(program) // => 1
```

## Anti-patterns

**1. Forking from inside a service with `runFork` or `void promise`.**

```ts skip
const start = () => { Effect.runFork(pollForever) }   // no owner, no scope, no layer R
```
Right: `yield* Effect.forkScoped(pollForever)` inside the `Layer.effect` that owns
it. Consequence: the fiber ignores shutdown and escapes the layers you provided.

**2. `concurrency: "unbounded"` over caller-sized input.**

```ts skip
Effect.forEach(userIds, loadProfile, { concurrency: "unbounded" })
```
Right: `{ concurrency: 10 }`, a number you chose. Consequence: ten thousand ids
means ten thousand simultaneous requests and a self-inflicted outage.

**3. Assuming `forkChild` is scoped to the enclosing `Effect.gen` block.** The child
lives until the *fiber* that forked it ends, which may be the whole program.
Right: wrap the region in `Effect.scoped` and use `Effect.forkScoped`, or keep the
handle and `Fiber.interrupt` it. Consequence: helper fibers pile up in a
long-lived fiber.

**4. `Effect.forkDetach` without keeping the handle.** Nothing interrupts it and
nobody observes its failure. Right: `forkScoped`, or a `FiberSet`. Consequence: work
that continues after shutdown and fails silently.

**5. Polling for readiness.**

```ts skip
while (!(yield* Ref.get(ready))) yield* Effect.sleep("10 millis")
```
Right: `Deferred.await(ready)` (one-shot) or `latch.await` / `latch.whenOpen(eff)`.
Consequence: latency, wasted wakeups, and a loop that TestClock cannot drive
deterministically.

**6. `Queue.unbounded` as the default.** Right: `Queue.bounded(n)` for backpressure
(producers wait) or `Queue.dropping(n)` / `Queue.sliding(n)` when loss is acceptable
and documented. Consequence: a slow consumer turns traffic spikes into OOM.

**7. Manual permits and `fork` followed immediately by `join`.**

```ts skip
yield* sem.take(1); yield* work; yield* sem.release(1)        // leaks the permit on failure
const f = yield* Effect.forkChild(work); yield* Fiber.join(f) // concurrency in name only
```
Right: `sem.withPermits(1)(work)` and just `yield* work`. Consequence: one failure
deadlocks the pool of permits; the fork is pure overhead.

**8. Broadcasting with a `Queue` or load-balancing with a `PubSub`.** Queue delivers
each message to one taker; PubSub delivers each to every current subscriber.
Right: Queue for work, PubSub for events. Consequence: events that reach one
random listener, or jobs executed N times.

**9. v3 names.** `Effect.fork` is `Effect.forkChild`, `Effect.forkDaemon` is
`Effect.forkDetach`, `Effect.makeSemaphore` is `Semaphore.make`, `Effect.makeLatch` is
`Latch.make`. Consequence: compile errors that tempt you to cast.

## Testing it

Never sleep for real. Provide `TestClock.layer()` (from `effect/testing`), fork
the workload, move virtual time with `TestClock.adjust`, then join. Assert the
*bound* (peak concurrency), not timing. With `@effect/vitest` the same body goes
in `it.effect("...", () => Effect.gen(...))`, which supplies the TestClock for
you; the first version below uses `node:assert` so it runs as a plain doctest; the
`@effect/vitest` form follows it.

```ts import.meta.vitest name="references/concurrency/guide.md#9"
import assert from "node:assert/strict"
import { Effect, Fiber, Ref, Semaphore } from "effect"
import { TestClock } from "effect/testing"

const test = Effect.gen(function*() {
  const sem = yield* Semaphore.make(2)
  const active = yield* Ref.make(0)
  const peak = yield* Ref.make(0)
  const job = sem.withPermits(1)(
    Effect.gen(function*() {
      const now = yield* Ref.updateAndGet(active, (n) => n + 1)
      yield* Ref.update(peak, (p) => Math.max(p, now))
      yield* Effect.sleep("1 second")
      yield* Ref.update(active, (n) => n - 1)
    })
  )
  const all = yield* Effect.forkChild(
    Effect.forEach([1, 2, 3, 4, 5], () => job, { concurrency: "unbounded", discard: true })
  )
  // Three rounds of two, then one: advance time in steps.
  yield* TestClock.adjust("1 second")
  yield* TestClock.adjust("1 second")
  yield* TestClock.adjust("1 second")
  yield* Fiber.join(all)
  assert.equal(yield* Ref.get(peak), 2)
}).pipe(Effect.provide(TestClock.layer()))

await Effect.runPromise(test)
```

The same test as a real `@effect/vitest` suite (`it.effect` provides `TestClock`
and runs the body for you; this is typechecked here and belongs in a `*.test.ts`):

```ts
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Ref, Semaphore } from "effect"
import { TestClock } from "effect/testing"

describe("semaphore bound", () => {
  it.effect("never runs more than 2 jobs at once", () =>
    Effect.gen(function*() {
      const sem = yield* Semaphore.make(2)
      const active = yield* Ref.make(0)
      const peak = yield* Ref.make(0)
      const job = sem.withPermits(1)(
        Effect.gen(function*() {
          const now = yield* Ref.updateAndGet(active, (n) => n + 1)
          yield* Ref.update(peak, (p) => Math.max(p, now))
          yield* Effect.sleep("1 second")
          yield* Ref.update(active, (n) => n - 1)
        })
      )
      const all = yield* Effect.forkChild(
        Effect.forEach([1, 2, 3, 4, 5], () => job, { concurrency: "unbounded", discard: true })
      )
      yield* TestClock.adjust("3 seconds")
      yield* Fiber.join(all)
      expect(yield* Ref.get(peak)).toBe(2)
    }))
})
```

Also test: shutdown (leave the scope with queued work and assert the results
arrived: the Thumbnails finalizer drains), rejection (fill a `dropping` queue
and assert `Overloaded`), and cancellation (interrupt the caller and assert a
finalizer ran, using `Effect.onInterrupt`). Use a fake `render` service rather
than real I/O. See [references/api-cheatsheet.md](api-cheatsheet.md)
for the full test of the worker service.

## Changed in 4.1

- `sem.takeScoped(n)` holds permits until the current `Scope` closes (see
  [lifetimes](lifetimes-and-interruption.md#holding-permits-for-a-scope)); no
  manual `release` needed.
- `Pool.stats(pool)` returns `{ idle, used, pending, min, max }` for metrics.
- `FiberMap` now tracks replaced fibers that are still interrupting, so closing the
  map's scope waits for them too (no API change).
- Semaphore waiters that fit in the free permits may overtake a larger request
  queued ahead of them (documented on `take`); do not rely on strict FIFO across
  different permit sizes.

## Boundaries

- Retry, repeat, polling cadence, `Schedule`: [time](../time/guide.md). This skill only
  decides *where* a loop runs.
- Atomic shared state (`Ref`, `SynchronizedRef`, `SubscriptionRef`) and
  transactions: [state](../state/guide.md). A `Semaphore` limits *parallelism*; it is not a
  substitute for an atomic `Ref.modify`.
- `Stream`, `Stream.fromQueue`, `Stream.fromPubSub`, `mapEffect` with
  concurrency, and sinks: [streams](../streams/guide.md).
- Scopes, `acquireRelease`, layers and who closes what: [services](../services/guide.md).
  Every `forkScoped`, `Pool`, `PubSub` and `FiberSet` above depends on a Scope
  owned by a Layer or `Effect.scoped`.
- Typed errors, `Cause`, interruption as a `Cause`, `Effect.exit`: [core](../core/guide.md).
- Distributed or persisted work queues (cluster, workflow, RPC): their own
  skills; a `Queue` here is in-process and lost on restart.

## References

- [API cheat sheet with verified signatures and a full worker test](api-cheatsheet.md)
- [Fiber lifetimes, interruption and Pool/PubSub details](lifetimes-and-interruption.md)
- [Effect API: Fiber](https://effect.website/docs/v4/api/effect/Fiber)
- [Effect API: Queue](https://effect.website/docs/v4/api/effect/Queue)
- [Effect API: PubSub](https://effect.website/docs/v4/api/effect/PubSub)
- [Effect API: Semaphore](https://effect.website/docs/v4/api/effect/Semaphore)
- [Effect API: Deferred](https://effect.website/docs/v4/api/effect/Deferred)
- [Effect API: FiberMap](https://effect.website/docs/v4/api/effect/FiberMap)
- [Pinned Fiber source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Fiber.ts)
- [Pinned Queue source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Queue.ts)
- [Pinned Semaphore source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Semaphore.ts)
