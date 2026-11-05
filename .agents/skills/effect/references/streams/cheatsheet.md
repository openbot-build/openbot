# Stream cheat sheet (effect@4.1.2)

Every name below was checked against `node_modules/effect/src/Stream.ts`,
`Sink.ts` and `Take.ts`. Import everything from `"effect"`.

## Reading the types

```
Stream<A, E, R>          emits A, can end with failure E, needs services R
Sink<A, In, L, E, R>     consumes In, produces A, may leave unconsumed L
Channel<...>             the low-level engine; Stream and Sink wrap one
Take<A, E, Done>         one pull result: NonEmptyReadonlyArray<A> | Exit<Done, E>
Pull<A, E, Done>         one "give me the next batch" step; Done signals the end
```

- A `Stream` has no "done" failure in `E`: end of stream is represented
  internally by `Cause.Done` and removed from the public type
  (`Stream.fromQueue` takes a `Queue.Dequeue<A, E | Done>` and yields `Stream<A, E>`).
- `R` is only what the stream needs while running. `Stream.unwrap` and
  `Stream.callback` exclude `Scope` from `R` because the stream owns it.
- Elements move in non-empty arrays (`Stream.DefaultChunkSize` is 4096). `buffer`
  "destroys chunking"; call `Stream.rechunk(n)` afterwards if downstream needs
  fixed batch sizes. `Chunk` is no longer the public batch type: `runCollect`
  returns a plain `Array<A>`.

## Constructors

| Need | Function |
| --- | --- |
| literals / iterable / array | `Stream.make(1, 2)`, `fromIterable`, `fromArray`, `succeed`, `empty` |
| one effect, once | `fromEffect(effect)` ; ignore its value: `fromEffectDrain` |
| one effect, forever / on a schedule | `fromEffectRepeat`, `fromEffectSchedule(effect, schedule)`, `fromSchedule(schedule)`, `tick(duration)` |
| numeric range / generator | `range(1, 10)`, `iterate(seed, f)`, `unfold(seed, f)` |
| cursor pages | `paginate(seed, f)` where `f(s)` returns `Effect<readonly [values, Option<next>]>` |
| failure | `fail(e)`, `failCause`, `die(defect)` |
| lazy | `suspend(() => stream)`, `sync(() => a)` |
| effect that returns a stream (services, resources) | `unwrap(effect)` |
| queue / pubsub / subscription | `fromQueue`, `fromPubSub`, `fromPubSubTake`, `fromSubscription` |
| callback API | `callback(queue => effect, { bufferSize, strategy })` ; feed with `Queue.offerUnsafe`, end with `Queue.endUnsafe` |
| async iterable | `fromAsyncIterable(iterable, onError)` |
| web ReadableStream / DOM events | `fromReadableStream`, `fromEventListener(target, type)` |
| never ends | `never` |

## Transforming

| Need | Function |
| --- | --- |
| pure map / filter / both | `map`, `filter`, `filterMap` (takes a `Filter`, not an Option-returning function) |
| effectful map | `mapEffect(f, { concurrency, unordered })` ; `f(a, index)` |
| effectful filter | `filterEffect`, `filterMapEffect` |
| side effect, keep value | `tap(f)`, `tapError`, `tapErrorTag`, `tapCause` |
| flatten substreams | `flatMap(f, { concurrency, bufferSize })`, `switchMap` (cancel previous), `flatten` |
| stateful | `mapAccum`, `scan`, `scanEffect` |
| take / drop | `take(n)`, `takeWhile`, `takeUntil`, `drop`, `dropWhile`, `dropUntil`, `takeRight`, `limitBytes(n, fallback)` (switches to a fallback stream when the limit would be crossed; check the source for the exact signature) |
| batches | `grouped(n)`, `groupedWithin(n, duration)`, `sliding(n)`, `rechunk(n)`, `aggregateWithin` |
| keyed | `groupByKey(f)`, `groupBy`, `groupAdjacentBy` |
| rate | `throttle({ cost, units, duration, burst, strategy })`, `debounce(duration)` |
| timing out | `timeout(duration)` (ends stream if no element in time), `timeoutOrElse` |
| dedupe adjacent | `changes`, `changesWith` |
| combine | `concat`, `prepend`, `merge`, `mergeAll(streams, { concurrency })`, `zip`, `zipLatest`, `zipWithIndex`, `interleave`, `cross` |
| fan-out | `broadcast`, `share`, `toPubSub`; `partition(filter)` returns scoped passing/failing substreams (needs a `Scope`) |
| text / bytes | `decodeText()`, `encodeText`, `splitLines`, `mkString`, `mkUint8Array` |
| bridge to channels | `pipeThroughChannel(channel)`, `pipeThroughChannelOrFail`, `pipeThrough(sink)` (emits only the sink's leftovers) ; channels: `Ndjson`, `Sse`, `Csv`, `JsonArray`, `Xml`, `Tar`, `Zip`, `SchemaBinary` from `effect/encoding` |

## Errors, retries, resources

| Need | Function |
| --- | --- |
| handle one tag / several | `catchTag("X", f)`, `catchTags({ ... })`, `catchIf`, `catchFilter` |
| handle any cause incl. defects | `catchCause`, `catchDefect` |
| change error type | `mapError(f)`, `orDie`, `ignore`, `ignoreCause` (both take `{ log }`, which may be `"Unhandled"`) |
| fallback when empty | `orElseIfEmpty`, `orElseSucceed` |
| retry the whole stream | `retry(schedule)` (restarts the stream from scratch; already-emitted elements are emitted again) |
| escalate to another plan | `withExecutionPlan` |
| finalizer on any exit | `ensuring(effect)`, `onExit(f)`, `onStart`, `onEnd`, `onError` |
| scope per stream | `scoped(stream)`, `unwrap`, `callback` |
| provide services | `provide(layer)`, `provideService(tag, impl)`, `provideContext` |

`Stream.catch` is the exported name of the "recover from any typed error"
combinator (it is `catch_` internally). `catchAll` is v3.

## Consumers

| Result | Function |
| --- | --- |
| `Array<A>` | `runCollect` |
| `void` | `runDrain`, `runForEach(f)`, `runForEachWhile(f)`, `runForEachArray(f)` |
| `Option<A>` | `runHead`, `runLast` |
| `number` | `runCount`, `runSum` |
| any `Z` | `runFold(() => z, (z, a) => z)`, `runFoldEffect`, `run(sink)` |
| background | `drainFork(other)`, `runIntoQueue(queue)`, `toQueue({ capacity })`, `runIntoPubSub`, `toPubSub` |
| manual pulling | `toPull` (Effect needing `Scope`; each pull returns a non-empty array and fails with `Cause.Done` at the end) |
| interop | `toReadableStream`, `toAsyncIterable` |

## Sinks (from `effect`'s `Sink`)

`Sink.sum`, `Sink.count`, `Sink.head<A>()`, `Sink.last<A>()`, `Sink.take<A>(n)`,
`Sink.collect<A>()`, `Sink.drain`, `Sink.forEach(f)`, `Sink.reduce(init, f)`,
`Sink.fold(init, cont, f)`, `Sink.every`, `Sink.some`, `Sink.find`,
`Sink.map`, `Sink.mapInput`, `Sink.flatMap`, `Sink.mapEffect`,
`Sink.summarized`, `Sink.timed`, `Sink.ensuring`. Run with `Stream.run(sink)`.

## v3 to v4 names

| v3 | v4 |
| --- | --- |
| `Stream.async`, `asyncPush`, `asyncScoped` | `Stream.callback` |
| `Stream.catchAll` | `Stream.catch` |
| `Stream.mapChunks` | `Stream.mapArray` |
| `Stream.runCollect` -> `Chunk` | -> `Array` |
| `Stream.fromChunk` | `Stream.fromArray` |
| `Stream.scoped` | still `Stream.scoped`, but `unwrap` / `callback` already exclude `Scope` |
| `Stream.flatMap(f, { concurrency })` | same |
| `Stream.groupedWithin` | same name, emits `Array`, not `Chunk` |
| `Effect.Tag`-based `Stream.service` | `Stream.service(tag)` exists; prefer `unwrap` + `yield*` |

## A worked retry example

```ts import.meta.vitest name="references/streams/cheatsheet.md#1"
import { Effect, Schedule, Schema, Stream } from "effect"

class FeedError extends Schema.TaggedError<FeedError>()("FeedError", {
  cause: Schema.Defect()
}) {}

let attempts = 0
// Fails after emitting one element, twice, then succeeds.
const flaky = Stream.make(1).pipe(
  Stream.concat(Stream.fromEffect(Effect.suspend(() =>
    ++attempts < 3 ? Effect.fail(new FeedError({ cause: "boom" })) : Effect.succeed(2)
  )))
)

// retry re-runs the whole stream: note the repeated 1s in the output.
export const resilient = flaky.pipe(
  Stream.retry(Schedule.recurs(5)),
  Stream.runCollect
)

const collected = await Effect.runPromise(resilient)
collected // => [1, 1, 1, 2]
```
