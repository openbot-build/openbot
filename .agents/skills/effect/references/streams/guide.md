# Effect Streams

## How to think about it

An `Effect<A, E, R>` produces **one** value. A `Stream<A, E, R>` produces
**zero or more** `A` over time, may fail once with `E` (which ends it), and
needs `R` to run. Like an Effect, a Stream is an inert description: building
it performs no I/O. It runs when you hand it to a `run*` function (or a
`Sink`), which returns an `Effect` you then run at the edge like any other.

Streams are **pull-based**. The consumer asks for the next batch; the producer
does work only when asked. That single fact is where backpressure comes from:
a slow consumer simply stops pulling, so the upstream stops reading the file or
calling the API. Nothing is buffered unless you ask for a buffer. Internally a
stream moves non-empty arrays ("chunks") of elements per pull for speed, but
you reason about it as one element at a time, and a Stream is not lossy about
failures: a failure terminates the stream, and finalizers run in reverse order
of acquisition however it ends (success, failure, `take`, interruption).

If you come from other tools: it is **not** an RxJS Observable (push, hot by
default, you must remember to unsubscribe) and **not** a Node `Readable`
(events plus manual `pause()`/`resume()`, errors as a side channel). It is much
closer to an async iterator whose `for await` loop is fused with typed errors,
requirements, concurrency control and guaranteed cleanup. The most common
mistake is reaching for `Effect.forEach`/`Promise.all` over a huge array, or
collecting a source into an array "to process it". If the data is large,
unbounded, or arrives incrementally, keep it a Stream and end it in a
`runForEach`/`runFold`/`runDrain`/Sink.

## Choose

| Situation | Use | Why |
| --- | --- | --- |
| Finite list, fits in memory, one result per item | `Effect.forEach(xs, f, { concurrency })` | no streaming machinery needed |
| Large or unbounded sequence, process and discard | `Stream.run*` ending in `runDrain` / `runForEach` | constant memory, backpressure |
| Page through an API with a cursor | `Stream.paginate(cursor, f)` | f returns `[values, Option<nextCursor>]` |
| Poll something on a schedule | `Stream.fromEffectSchedule(effect, schedule)` | schedule owns timing; stream is interruptible |
| Wrap callbacks / event emitters / websockets | `Stream.callback(queue => ...)` | register + `acquireRelease` to unregister |
| Wrap an existing async iterable | `Stream.fromAsyncIterable(it, onError)` | you must type the thrown error |
| Wrap a Node `Readable` | `NodeStream.fromReadable` from `@effect/platform-node` | see [platform](../platform/guide.md) |
| Pure per-item transform | `Stream.map` / `Stream.filter` | no effect needed |
| Effectful per-item transform | `Stream.mapEffect(f, { concurrency: n })` | bounded parallelism, order kept unless `unordered: true` |
| Each item expands to a sub-stream | `Stream.flatMap(f, { concurrency: n })` | default is sequential concatenation |
| Combine independent streams | `Stream.merge` / `mergeAll(streams, { concurrency })` | interleaves as items arrive |
| Pair items positionally | `Stream.zip` / `zipLatest` | zip waits for both sides |
| Batch for bulk writes | `Stream.groupedWithin(size, duration)` / `Stream.grouped(size)` | flush on size or time |
| Let producer run ahead of consumer | `Stream.buffer({ capacity })` | bounded; `strategy` picks suspend/dropping/sliding |
| Fan one source out to several consumers | `Stream.share` / `Stream.broadcast` | source runs once |
| Turn a stream into one summary value | `Stream.runFold`, `runSum`, `runCount`, or `Stream.run(Sink...)` | the consumer decides the result type |
| Encode/decode NDJSON, SSE, framed binary | `pipeThroughChannel` + `effect/encoding` | see [encoding](../encoding/guide.md) |
| Hand-written pull/push protocol | `Channel` (rare) | stay on Stream unless implementing an operator |
| A single result or a fixed small array | plain `Effect` | a one-element Stream is overhead |

Not a Stream: request/response (use `Effect`), shared mutable state (use
`Ref`, [state](../state/guide.md)), a work queue with explicit producers and consumers
(use `Queue`, [concurrency](../concurrency/guide.md), then `Stream.fromQueue` to read it).

## Recipe

The scenario: sync orders from a cursor-paginated upstream API into a
warehouse, without ever holding more than a few pages in memory, with typed
errors, bounded concurrency, and batched writes.

First the pitfall, then the idiomatic version.

```ts skip
// PITFALL: everything is loaded before anything is processed.
// - memory grows with the table; one failing row loses all progress
// - Promise.all fires every enrichment at once and hammers the API
// - the error type is `unknown`
async function sync() {
  const all: Order[] = []
  let cursor: number | undefined = 0
  while (cursor !== undefined) {
    const page = await fetchPage(cursor)
    all.push(...page.rows)
    cursor = page.next
  }
  const enriched = await Promise.all(all.map(enrich))
  await warehouse.insertMany(enriched)
}
```

```ts import.meta.vitest name="references/streams/guide.md#2"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"

// Expected failures are tagged data a caller can branch on.
export class UpstreamError extends Schema.TaggedError<UpstreamError>()("UpstreamError", {
  cursor: Schema.Number,
  cause: Schema.Defect()
}) {}

// A row that fails decoding is a data problem, not a transport problem:
// give it its own tag so a caller can choose to skip, dead-letter, or abort.
export class BadRow extends Schema.TaggedError<BadRow>()("BadRow", {
  message: Schema.String
}) {}

export class Order extends Schema.Class<Order>("Order")({
  id: Schema.String,
  cents: Schema.Int
}) {}

// Capabilities are services, so the pipeline below is testable without a network.
export class Upstream extends Context.Service<Upstream, {
  // Raw rows are `unknown`: the pipeline decodes them once, at the boundary.
  page(cursor: number): Effect.Effect<{
    readonly rows: ReadonlyArray<unknown>
    readonly next: Option.Option<number>
  }, UpstreamError>
}>()("app/Upstream") {}

export class Warehouse extends Context.Service<Warehouse, {
  insertMany(orders: ReadonlyArray<Order>): Effect.Effect<void>
}>()("app/Warehouse") {}

const decodeOrder = Schema.decodeUnknownEffect(Order)

// A Stream is built from a service, so it carries R = Upstream until provided.
export const orders = Stream.unwrap(Effect.gen(function*() {
  const upstream = yield* Upstream
  return Stream.paginate(0, (cursor: number) =>
    // Return [elements of this page, next cursor]. Option.none() ends the stream.
    upstream.page(cursor).pipe(
      Effect.map((page) => [page.rows, page.next] as const)
    ))
}))

// A fake enrichment call. mapEffect keeps at most 4 in flight and
// applies backpressure to the paginator when they are all busy.
const enrich = (order: Order) => Effect.succeed(new Order({ id: order.id, cents: order.cents + 1 })).pipe(
  Effect.delay("10 millis")
)

export const sync = Effect.gen(function*() {
  const warehouse = yield* Warehouse
  return yield* orders.pipe(
    // Decode at the boundary; BadRow is the only way this stage can fail.
    Stream.mapEffect((row) =>
      decodeOrder(row).pipe(Effect.mapError((error) => new BadRow({ message: String(error) })))
    ),
    Stream.mapEffect(enrich, { concurrency: 4 }),
    // Flush 100 rows OR whatever arrived in 2 seconds, whichever comes first.
    Stream.groupedWithin(100, "2 seconds"),
    Stream.runForEach((batch) => warehouse.insertMany(batch))
  )
})
// sync: Effect<void, UpstreamError | BadRow, Upstream | Warehouse>
// Both error tags survive in E and both services in R: nothing is hidden.

// Recover per concern, not with a blanket catch:
export const syncSkippingBadRows = Effect.catchTag(sync, "BadRow", (error) =>
  // The stream already ended at the first BadRow. To skip individual rows
  // instead, handle the error INSIDE mapEffect (see the Anti-patterns section).
  Effect.logWarning(`aborted at bad row: ${error.message}`))

// Composition root: test layers in tests, real ones in main.
export const memoryUpstream = Layer.succeed(
  Upstream,
  Upstream.of({
    page: (cursor) =>
      Effect.succeed({
        rows: [{ id: `o${cursor}`, cents: cursor }],
        next: cursor < 2 ? Option.some(cursor + 1) : Option.none()
      })
  })
)

// The warehouse remembers every batch it was given.
const inserted: Array<ReadonlyArray<Order>> = []
const memoryWarehouse = Layer.succeed(
  Warehouse,
  Warehouse.of({
    insertMany: (batch) => Effect.sync(() => void inserted.push(batch))
  })
)

await Effect.runPromise(sync.pipe(Effect.provide(Layer.mergeAll(memoryUpstream, memoryWarehouse))))
// Three pages of one row each, enriched (+1), flushed as ONE batch when the stream ended.
inserted.map((batch) => batch.map((order) => order.cents)) // => [[1, 2, 3]]

// A page that carries a malformed row ends the stream with the tagged BadRow.
const badUpstream = Layer.succeed(
  Upstream,
  Upstream.of({
    page: () => Effect.succeed({ rows: [{ id: "o1" }], next: Option.none() })
  })
)
const badRow = await Effect.runPromise(
  Effect.flip(sync).pipe(Effect.provide(Layer.mergeAll(badUpstream, memoryWarehouse)))
)
badRow._tag // => "BadRow"
```

Read the design decisions off it:

- **`Stream.unwrap`** turns an `Effect<Stream>` into a Stream, so you can
  `yield*` services (or acquire a resource) before the stream starts. Any
  `Scope` the effect needs is tied to the *stream's* lifetime and closed when
  the stream ends or is interrupted, which is how a stream that opens a file
  or socket cleans up even if you `take(5)` from it.
- **Unit of failure.** `E` of a Stream is "this stream can end with E". There is
  no per-element error channel. If one bad row must not kill the pipeline,
  convert it into a *value* (`Result`, a `Skipped` marker) in `mapEffect`.
- **Concurrency is a parameter, not a structure.** `mapEffect(f, { concurrency: 4 })`
  preserves order. Add `unordered: true` for higher throughput when order does
  not matter.
- **Time-based batching** (`groupedWithin`) is what makes bulk inserts efficient
  without making slow trickles wait forever.

### Resource-safe sources and callbacks

A stream that owns a resource acquires it *inside* the stream (`Stream.unwrap` +
`Effect.acquireRelease`, or `Stream.callback`) so it is released on every exit path.
A compiled `Stream.callback` example with buffer strategy is in
[references/patterns.md](patterns.md).

### Sinks: choosing the result type

`Stream.run*` helpers cover most cases. Use a `Sink` when you want to name
a reusable consumer, or compose "take some, then stop".

```ts import.meta.vitest name="references/streams/guide.md#3"
import { Effect, Sink, Stream } from "effect"

const program = Effect.gen(function*() {
  const total = yield* Stream.range(1, 10).pipe(Stream.run(Sink.sum))
  const firstThree = yield* Stream.range(1, 10).pipe(Stream.run(Sink.take<number>(3)))
  const folded = yield* Stream.range(1, 5).pipe(
    Stream.runFold(() => 0, (acc: number, n) => acc + n)
  )
  return { total, firstThree, folded }
})

const result = await Effect.runPromise(program)
result // => { total: 55, firstThree: [1, 2, 3], folded: 15 }
```

`runCollect` returns an `Array`; `runHead`/`runLast` return `Option`;
`runForEach`/`runDrain` return `void`; `runCount`/`runSum` return numbers.

### Backpressure and fan-out

```ts import.meta.vitest name="references/streams/guide.md#4"
import { Effect, Stream } from "effect"

// Producer: fast. Consumer: slow. Without buffer the producer only runs when the
// consumer pulls. With buffer it runs ahead by AT MOST `capacity` elements, then
// suspends. Never use capacity: "unbounded" on a source that can outrun the sink.
let produced = 0
const slow = Stream.range(1, 40).pipe(
  Stream.tap(() => Effect.sync(() => void produced++)),
  Stream.buffer({ capacity: 4 }),
  Stream.mapEffect((n) => Effect.sleep("2 millis").pipe(Effect.as(n)), { concurrency: 1 })
)

const sum = await Effect.runPromise(Stream.runSum(slow))
sum // => 820

// Two consumers, one upstream read. `share` ref-counts the source: it starts when
// the first subscriber arrives and stops when the last leaves. `share` allocates
// resources, so it needs a Scope: Effect.scoped owns it here.
let reads = 0
const source = Stream.range(1, 5).pipe(
  Stream.tap(() => Effect.sleep("2 millis")),
  Stream.tap(() => Effect.sync(() => void reads++))
)

const both = Effect.scoped(Effect.gen(function*() {
  const shared = yield* Stream.share(source, { capacity: 16 })
  return yield* Effect.all(
    [Stream.runCollect(shared), Stream.runCollect(shared)],
    { concurrency: 2 }
  )
}))

const [a, b] = await Effect.runPromise(both)
a // => [1, 2, 3, 4, 5]
b // => [1, 2, 3, 4, 5]
// The upstream ran once, not twice:
reads // => 5
```

## Anti-patterns

**1. Collecting then processing.** Loads the whole source; no backpressure; first
byte of output waits for the last byte of input.

```ts skip
const rows = yield* Stream.runCollect(source)
yield* Effect.forEach(rows, handle)
```
```ts import.meta.vitest name="references/streams/guide.md#7"
import { Effect, Stream } from "effect"

const seen: Array<number> = []
const handle = (n: number) => Effect.sync(() => void seen.push(n))
const source = Stream.range(1, 5)

// Each element is handled as it is produced; nothing is collected first.
await Effect.runPromise(source.pipe(Stream.runForEach(handle)))
seen // => [1, 2, 3, 4, 5]
```

**2. I/O at construction time.** `Stream.fromIterable(await fetchAll())` or an
`Effect.runPromise` while building the stream does the work eagerly and outside
the fiber (no interruption, no retry). Keep the effect inside:
`Stream.fromEffect`, `Stream.paginate`, `Stream.unwrap`.

**3. Unbounded concurrency against a real dependency.**

```ts skip
Stream.flatMap(fetchDetails, { concurrency: "unbounded" })
```
One slow upstream turns into thousands of in-flight requests and a rate-limit
ban. Pick a number from the dependency's limit, usually 4 to 16. For rate, not
parallelism, add `Stream.throttle`.

**4. Swallowing the stream error to "keep going".** A Stream ends at its first
failure. `Stream.catch...` replaces the *rest* of the stream; it does not resume
after the bad element. Per-element tolerance belongs inside the mapping:

```ts import.meta.vitest name="references/streams/guide.md#8"
import { Effect, Result, Stream } from "effect"

const parse = (s: string): Effect.Effect<number, "Bad"> =>
  Number.isNaN(Number(s)) ? Effect.fail("Bad") : Effect.succeed(Number(s))

const tolerant = Stream.make("1", "x", "3").pipe(
  Stream.mapEffect((s) => Effect.result(parse(s)), { concurrency: 1 }),
  // Failures became values; the stream itself cannot fail here.
  Stream.filter(Result.isSuccess),
  Stream.map((r) => r.success)
)

const kept = await Effect.runPromise(Stream.runCollect(tolerant))
kept // => [1, 3]

// Without the Result wrapper the same stream dies at "x" and never sees "3":
const strict = Stream.make("1", "x", "3").pipe(Stream.mapEffect(parse, { concurrency: 1 }))
const failure = await Effect.runPromise(Effect.flip(Stream.runCollect(strict)))
failure // => "Bad"
```

**5. Acquiring resources outside the stream.** Opening a file before building
the stream and closing it after `runCollect` leaks if the stream is `take`n,
fails, or is interrupted. Acquire in `Stream.unwrap(Effect.acquireRelease(...))`
or in the `Stream.callback` effect; the Scope is closed for you.

**6. `Channel` as a default.** Writing a custom Channel to batch or map loses
the tested operators (`groupedWithin`, `mapEffect`, `buffer`) and makes
finalization your problem. Use Channel only through `Stream.pipeThroughChannel`
with ready-made ones (`Ndjson.decodeString()`), or when writing a new operator.

**7. Stringifying errors before recovery.** `Stream.mapError(String)` early
leaves downstream nothing to `catchTag` on. Keep tagged errors until the
boundary that decides what the user sees.

**8. Using a Stream where `Effect.forEach` does it.** For ten items and a
`{ concurrency: 4 }` bound, `Effect.forEach` is simpler and returns an array.
Reach for Stream when size is unbounded, arrival is incremental, or you need
batching, time windows, merging, or backpressure.

## Testing it

Make the source a service (as above) and test with a deterministic in-memory
layer. For time-based operators, drive virtual time instead of sleeping.

```ts import.meta.vitest name="references/streams/guide.md#9"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"

const program = Effect.gen(function*() {
  // Emits 1, 2, 3 immediately, then nothing for ten seconds, then 4.
  const source = Stream.make(1, 2, 3).pipe(
    Stream.concat(Stream.fromEffect(Effect.delay(Effect.succeed(4), "10 seconds")))
  )
  const fiber = yield* source.pipe(
    Stream.groupedWithin(10, "1 second"),
    Stream.runCollect,
    Effect.forkChild
  )
  // No real waiting: advance the virtual clock past both timers.
  yield* TestClock.adjust("11 seconds")
  return yield* Fiber.join(fiber)
})

const batches = await Effect.runPromise(Effect.provide(program, TestClock.layer()))
// The 1s window flushed [1, 2, 3]; the 10s element arrived in its own batch.
batches // => [[1, 2, 3], [4]]
```

With `@effect/vitest` the same body goes in `it.effect(...)`, which installs the
`TestClock` for you (no `Effect.provide`):

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"

it.effect("flushes on time", () => Effect.gen(function*() {
  const fiber = yield* Stream.make(1).pipe(Stream.groupedWithin(10, "1 second"), Stream.runCollect, Effect.forkChild)
  yield* TestClock.adjust("1 second")
  assert.deepStrictEqual(yield* Fiber.join(fiber), [[1]])
}))
```

Also test: finite sources for operator logic (`Stream.make(...)` then
`Stream.runCollect`); the failure path (`Stream.fail`, then `Effect.flip` on the
run to assert the tagged error); and cleanup, by building a source with
`Effect.acquireRelease` whose release flips a `Ref`, running `Stream.take(1)`,
and asserting the Ref afterwards. See [testing](../testing/guide.md).

## Changed in 4.1

Stream's public API is stable between 4.0 and 4.1; what changed is behaviour and a few options.

- `Stream.partition` and `Stream.groupByKey` now end their per-branch queues cleanly when the
  source fails or the consumer finishes, so a branch that is still being read no longer hangs.
- `Stream.zip`/`zipWith`/`zipLeft`/`zipRight` keep leftover elements correctly across chunk
  boundaries when the two sides emit different batch sizes.
- `Stream.groupedWithin` and `Stream.sliding` flush a partial last batch before surfacing a
  failure, instead of dropping it in some orderings.
- `Stream.pipeThrough(sink)` returns the elements the sink left unconsumed in front of the rest
  of the stream.
- `Stream.ignore` and `Stream.ignoreCause` accept `log: "Unhandled"` to log at the level of
  `References.UnhandledLogLevel`.
- `Stream.mkUint8Array` returns `Uint8Array<ArrayBuffer>`.
- `Sink.takeUntil` / `takeUntilEffect` keep the matching element and hand the rest back as leftover.
- New channels to feed `pipeThroughChannel`: `Csv`, `JsonArray`, `Xml`, `Tar`, `Zip`
  ([encoding formats](../encoding/formats.md)). The upstream stream examples
  (`ai-docs/src/03_stream`) are unchanged.

## Boundaries

- [schema](../schema/guide.md): decoding each element (`Schema.decodeUnknownEffect`) and
  `Ndjson.decodeSchemaString`; define the element type there.
- [encoding](../encoding/guide.md): `Ndjson`, `Sse`, `SchemaBinary` channels and `Stream.decodeText`
  / `splitLines` pipelines for bytes.
- [concurrency](../concurrency/guide.md): `Queue`, `PubSub`, `Semaphore`, fibers; use these when
  you need explicit producers/consumers. Streams read from them with
  `Stream.fromQueue` / `Stream.fromPubSub`.
- [time](../time/guide.md): `Schedule` for `fromEffectSchedule`, `Stream.retry`, `repeat`.
- [http](../http/guide.md), [platform](../platform/guide.md): response bodies, files and sockets are
  streams of `Uint8Array`; `HttpServerResponse.stream`, `FileSystem.stream`.
- [core](../core/guide.md): how errors and causes work; [services](../services/guide.md): scopes, layers.
  Errors cross the stream boundary as the `E` of the `run*` Effect; resources
  cross as `Scope` held by the stream until it ends.

## References

- [Cheat sheet with signatures and v3 renames](cheatsheet.md)
- [Callback sources and resource safety](patterns.md)
- [Stream API](https://effect.website/docs/v4/api/effect/Stream)
- [Sink API](https://effect.website/docs/v4/api/effect/Sink)
- [Channel API](https://effect.website/docs/v4/api/effect/Channel)
- [Take API](https://effect.website/docs/v4/api/effect/Take)
- [Encoding channels for streams](../encoding/formats.md)
- [Pinned Stream source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Stream.ts)
- [Pinned Sink source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Sink.ts)
- [Upstream stream examples](https://github.com/Effect-TS/effect/tree/effect%404.1.2/ai-docs/src/03_stream)
