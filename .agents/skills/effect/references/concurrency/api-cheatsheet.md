# Concurrency API cheat sheet (effect@4.1.2)

Every signature below was read from `node_modules/effect/dist/*.d.ts`. Data-first
and data-last (pipeable) forms exist for functions marked "dual".

## Forking (all on `Effect`)

| API | Result | Lifetime of the new fiber |
| --- | --- | --- |
| `Effect.forkChild(eff, opts?)` | `Effect<Fiber<A, E>, never, R>` | until it finishes or the **forking fiber** ends |
| `Effect.forkScoped(eff, opts?)` | `Effect<Fiber<A, E>, never, R \| Scope>` | until the current `Scope` closes |
| `Effect.forkIn(eff, scope, opts?)` | `Effect<Fiber<A, E>, never, R>` | until the given scope closes |
| `Effect.forkDetach(eff, opts?)` | `Effect<Fiber<A, E>, never, R>` | unowned; only ends on its own or by explicit interrupt |
| `Effect.awaitAllChildren(eff)` | `Effect<A, E, R>` | wraps `eff`; waits for children forked inside it |

`opts` is `{ startImmediately?: boolean; uninterruptible?: boolean | "inherit" }`.
A fork returns before the child runs; without `startImmediately: true` a child
interrupted at once may never execute (so its `onInterrupt` never registers).

`Effect.fork`, `Effect.forkDaemon` and `Effect.forkAll` do not exist in 4.x.

## Fiber

`Fiber.join(f)` (re-raises the fiber's failure), `Fiber.await(f)` (`Effect<Exit<A, E>>`,
never fails), `Fiber.awaitAll(fibers)` (array of `Exit`), `Fiber.joinAll(fibers)`,
`Fiber.interrupt(f)` (waits until the fiber has finished its finalizers),
`Fiber.interruptAll(fibers)`, `Fiber.interruptAs(f, fiberId)`, `Fiber.runIn(f, scope)`,
`Fiber.getCurrent()`.

## Collections and racing (on `Effect`)

| API | Notes |
| --- | --- |
| `forEach(iterable, (a, i) => eff, { concurrency?, discard? })` | sequential by default |
| `all(iterable \| record, { concurrency?, discard?, mode?: "default" \| "result" })` | `"result"` returns `Result` per element and never fails |
| `partition(iterable, f, { concurrency? })` | never fails; `[passes, fails]` |
| `validate(iterable, f, opts?)` | accumulates all failures, fails if any |
| `race(a, b)` / `raceAll([...])` | first **success**; losers interrupted |
| `raceFirst(a, b)` / `raceAllFirst([...])` | first **completion**, success or failure |
| `timeout(d)` | adds `Cause.TimeoutError` (`_tag: "TimeoutError"`) to `E` |
| `timeoutOption(d)` / `timeoutOrElse({ ... })` | `Option` / custom fallback |
| `delay(d)` / `sleep(d)` / `timed` | `Duration.Input` accepts millis, `"2 seconds"`, `Duration` |

`concurrency` is `number | "unbounded" | "inherit"`.

## Interruption

`Effect.interrupt`, `Effect.onInterrupt(fn)`, `Effect.onExit(fn)`, `Effect.ensuring(fin)`,
`Effect.uninterruptible(eff)`, `Effect.interruptible(eff)`,
`Effect.uninterruptibleMask((restore) => ...)`, `Effect.interruptibleMask(...)`.
`Effect.acquireRelease` makes acquisition uninterruptible and always runs release.

## Deferred (`Deferred<A, E>`)

`make<A, E = never>()`, `await(d)` (exported as `Deferred.await`), `succeed(d, a)`, `fail(d, e)`,
`failCause`, `die`, `interrupt`, `done(d, exit)`, `complete(d, effect)`,
`completeWith`, `into(effect, d)`, `isDone`, `poll`. Every completer returns
`Effect<boolean>`: `true` only for the first completion. `makeUnsafe`,
`doneUnsafe`, `isDoneUnsafe` are the synchronous escape hatches.

## Queue (`Queue<A, E = never>`)

| Constructor | Behaviour when full |
| --- | --- |
| `bounded(n)` | `offer` suspends (backpressure) |
| `dropping(n)` | `offer` returns `false`, message discarded |
| `sliding(n)` | oldest message evicted |
| `unbounded()` | never full |
| `make({ capacity?, strategy? })` | general form |

Producing: `offer` (`Effect<boolean>`), `offerAll` (returns the messages that did not fit),
`end` (needs `E` to include `Cause.Done`; consumers drain, then fail with `Done`),
`fail`, `failCause`, `interrupt`, `shutdown` (discards buffered messages).
Consuming: `take`, `takeAll`, `takeN`, `takeBetween`, `poll` (`Option`), `peek`,
`collect` (until Done), `clear`, `size`, `isFull`.
Narrowed views: `asEnqueue`, `asDequeue` for handing out only one side.
Queue is a *work* queue: one taker per message.

## PubSub

`bounded(n | { capacity, replay? })`, `dropping`, `sliding`, `unbounded({ replay? })`.
`publish`, `publishAll` (`Effect<boolean>`), `subscribe(pubsub)` returns
`Effect<Subscription<A>, never, Scope>`; consume with `PubSub.take`, `takeAll`, `takeUpTo`,
`takeBetween`. `shutdown`, `end`, `awaitShutdown`. For streams use
`Stream.fromPubSub` (see [streams](../streams/guide.md)). A subscription is tied to a Scope;
a subscriber that leaves unsubscribes.

## Semaphore, Latch, PartitionedSemaphore

`Semaphore.make(n)`; methods `sem.withPermits(k)(eff)`, `sem.withPermit(eff)`,
`withPermitsIfAvailable(k)(eff)` (`Option`), `take(k)`, `takeIfAvailable(k)`,
`takeScoped(k)` (4.1: holds permits until the current `Scope` closes), `release(k)`, `releaseAll`, `resize(k)`. Prefer `withPermits` to manual take/release.
`PartitionedSemaphore.make<K>({ permits })` shares one permit budget fairly across keys:
`PartitionedSemaphore.withPermits(sem, key, k)(eff)` / `withPermit(sem, key, eff)`. `Latch.make(open?)`; `open`, `close`, `release`,
`await`, `whenOpen(eff)`, `isOpen()`.

## FiberSet, FiberMap, FiberHandle

All three are created with `make()` and require a `Scope` (the scope's close
interrupts everything inside). `run(self, eff, opts?)` forks into the collection;
for `FiberMap`/`FiberHandle` it accepts `onlyIfMissing`, and all accept
`propagateInterruption` and `startImmediately`. `join` fails with the first fiber
failure; `awaitEmpty` waits for the collection to drain; `size`, `clear`. `FiberMap`
adds `get`, `has`, `remove` keyed by `K`. `makeRuntime` / `makeRuntimePromise` produce a
function to run effects (with `R` captured) from callbacks outside Effect, such as a
webhook handler, while keeping the fibers owned by the collection.

## Pool

`Pool.make({ acquire, size, concurrency?, targetUtilization? })` (fixed size) and
`Pool.makeWithTTL({ acquire, min, max, timeToLive, ... })` both return
`Effect<Pool<A, E>, never, R | Scope>`. `Pool.use(pool, (a) => eff)` borrows for the
duration of `eff`; `Pool.get(pool)` borrows until the current scope closes.
`Pool.invalidate(pool, item)` retires a broken item. `Pool.stats(pool)` (4.1) returns
`{ idle, used, pending, min, max }` for metrics. There is no acquisition-timeout
option: wrap `Pool.use` in `Effect.timeout`.

## Worked test: the worker service under TestClock

Copy of the `Thumbnails` layer from `guide.md` plus a test that asserts the worker
bound and graceful drain.

```ts import.meta.vitest name="references/concurrency/api-cheatsheet.md#1"
import assert from "node:assert/strict"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"

class ThumbnailFailed extends Schema.TaggedError<ThumbnailFailed>()("ThumbnailFailed", {
  imageId: Schema.String
}) {}
class Overloaded extends Schema.TaggedError<Overloaded>()("Overloaded", {}) {}

interface Pending {
  readonly imageId: string
  readonly result: Deferred.Deferred<string, ThumbnailFailed>
}

class Thumbnails extends Context.Service<Thumbnails, {
  request(imageId: string): Effect.Effect<string, ThumbnailFailed | Overloaded>
}>()("app/Thumbnails") {
  static readonly layer = (options: {
    readonly workers: number
    readonly capacity: number
    readonly render: (imageId: string) => Effect.Effect<string, ThumbnailFailed>
  }) =>
    Layer.effect(
      Thumbnails,
      Effect.gen(function*() {
        const queue = yield* Queue.dropping<Pending, Cause.Done>(options.capacity)
        const worker = Queue.take(queue).pipe(
          Effect.flatMap((job) =>
            Effect.exit(options.render(job.imageId)).pipe(
              Effect.flatMap((exit) => Deferred.done(job.result, exit))
            )
          ),
          Effect.forever,
          Effect.catchTag("Done", () => Effect.void)
        )
        const fibers = yield* Effect.forEach(
          Array.from({ length: options.workers }),
          () => Effect.forkScoped(worker)
        )
        yield* Effect.addFinalizer(() => Queue.end(queue).pipe(Effect.andThen(Fiber.awaitAll(fibers))))
        return Thumbnails.of({
          request: Effect.fn("Thumbnails.request")(function*(imageId) {
            const result = yield* Deferred.make<string, ThumbnailFailed>()
            if (!(yield* Queue.offer(queue, { imageId, result }))) return yield* new Overloaded()
            return yield* Deferred.await(result)
          })
        })
      })
    )
}

// 1. Concurrency never exceeds the worker count; results keep input order.
const bound = Effect.gen(function*() {
  const active = yield* Ref.make(0)
  const peak = yield* Ref.make(0)
  const render = (id: string) =>
    Effect.gen(function*() {
      const now = yield* Ref.updateAndGet(active, (n) => n + 1)
      yield* Ref.update(peak, (p) => Math.max(p, now))
      yield* Effect.sleep("1 second")
      yield* Ref.update(active, (n) => n - 1)
      return `${id}.png`
    })
  const results = yield* Effect.gen(function*() {
    const thumbs = yield* Thumbnails
    const all = yield* Effect.forkChild(
      Effect.forEach(["a", "b", "c", "d", "e"], thumbs.request, { concurrency: "unbounded" })
    )
    yield* TestClock.adjust("1 second")
    yield* TestClock.adjust("1 second")
    yield* TestClock.adjust("1 second")
    return yield* Fiber.join(all)
  }).pipe(Effect.provide(Thumbnails.layer({ workers: 2, capacity: 10, render })))
  assert.deepEqual(results, ["a.png", "b.png", "c.png", "d.png", "e.png"])
  assert.equal(yield* Ref.get(peak), 2)
})

// 2. A failing job is a typed failure for that caller only; the worker survives.
const failure = Effect.gen(function*() {
  const render = (id: string) =>
    id === "bad" ? Effect.fail(new ThumbnailFailed({ imageId: id })) : Effect.succeed(`${id}.png`)
  const [bad, good] = yield* Effect.gen(function*() {
    const thumbs = yield* Thumbnails
    const bad = yield* Effect.exit(thumbs.request("bad"))
    const good = yield* thumbs.request("ok")
    return [bad, good] as const
  }).pipe(Effect.provide(Thumbnails.layer({ workers: 1, capacity: 10, render })))
  assert.ok(Exit.isFailure(bad))
  assert.equal(good, "ok.png")
})

// 3. After shutdown starts, requests are rejected with a typed error.
const rejected = Effect.gen(function*() {
  const thumbs = yield* Effect.scoped(
    Effect.gen(function*() {
      return yield* Thumbnails
    }).pipe(Effect.provide(Thumbnails.layer({ workers: 1, capacity: 1, render: (id) => Effect.succeed(id) })))
  )
  const exit = yield* Effect.exit(thumbs.request("late"))
  assert.ok(Exit.isFailure(exit))
})

await Effect.runPromise(
  Effect.all([bound, failure, rejected]).pipe(Effect.provide(TestClock.layer()))
).then(() => console.log("ok"))
```
