# Effect core API cheat sheet (effect@4.1.x)

Every signature below was read from `node_modules/effect/dist/Effect.d.ts`
(or the named module). `R` is omitted when it is `never`. Data-last overloads
(for `pipe`) are shown; each also has a data-first form.

## Creating

| API | Type | Notes |
| --- | --- | --- |
| `Effect.succeed(a)` | `Effect<A>` | |
| `Effect.sync(() => a)` | `Effect<A>` | thrown value becomes a defect |
| `Effect.suspend(() => eff)` | `Effect<A, E, R>` | builds the effect at run time |
| `Effect.fail(e)` | `Effect<never, E>` | prefer `return yield* new MyError()` inside `gen` |
| `Effect.die(x)` | `Effect<never>` | defect, not in `E` |
| `Effect.try(() => a)` | `Effect<A, Cause.UnknownError>` | |
| `Effect.try({ try, catch })` | `Effect<A, E>` | `catch: (error: unknown) => E` |
| `Effect.promise((signal) => p)` | `Effect<A>` | rejection is a defect |
| `Effect.tryPromise((signal) => p)` | `Effect<A, Cause.UnknownError>` | |
| `Effect.tryPromise({ try: (signal) => p, catch })` | `Effect<A, E>` | if `catch` throws, that is a defect |
| `Effect.callback((resume, signal) => void \| Effect<void>)` | `Effect<A, E, R>` | `resume(Effect.succeed(x))`; returned Effect is the finalizer |
| `Effect.fromNullishOr(v)` | `Effect<NonNullable<A>, Cause.NoSuchElementError>` | |
| `Effect.fromOption(opt, onNone?)` | `Effect<A, NoSuchElementError \| E>` | `onNone: () => E` |
| `Effect.fromResult(result)` | `Effect<A, E>` | |
| `Effect.never` / `Effect.void` / `Effect.interrupt` | | |
| `Effect.gen(function*() { ... })` | inferred | `yield*` an Effect or a `TaggedError` instance |
| `Effect.fn("name")(function*(args) {...}, ...pipeables)` | `(args) => Effect` | span + stack frame; extra args wrap the body |
| `Effect.fnUntraced(function*(args) {...})` | same, no span | library code, hot paths |
| `Effect.fn.Return<A, E, R>` | type | annotate a generator's return type |

Not yieldable in `Effect.gen`: `Option` and `Result` values
(`yield* Option.some(1)` throws "Not a valid effect" at runtime). Convert
first with `Effect.fromOption` / `Effect.fromResult`.

## Transforming and sequencing

| API | Type |
| --- | --- |
| `Effect.map(f)` | `Effect<A> -> Effect<B>` |
| `Effect.flatMap(f)` / `Effect.andThen(f)` | `(a: A) => Effect<B, E2, R2>` |
| `Effect.tap(f)` | runs `f(a)`, keeps `a` |
| `Effect.as(b)` / `Effect.asVoid` | replace the success value |
| `Effect.zip(that, { concurrent? })` | tuple of both |
| `Effect.when(condition)` | `Effect<Option<A>>` (note: yields an `Option`) |
| `Effect.filterOrFail(pred, (a) => e)` | refine or fail with `E2` |
| `Effect.flip` | swap success and error channels (great in tests) |

## Errors

| API | Behaviour |
| --- | --- |
| `Effect.catchTag("T" \| ["A","B"], f, orElse?)` | handles those tags; `E` loses them |
| `Effect.catchTags({ A: f, B: g })` | one handler per tag |
| `Effect.catchReason("ParentTag", "ReasonTag", f, orElse?)` | for errors with a tagged `reason` field |
| `Effect.catchReasons("ParentTag", { ... }, orElse?)` | several reasons |
| `Effect.unwrapReason("ParentTag")` | lifts reasons into `E` |
| `Effect.catch(f)` | `f: (e: E) => Effect<A2, E2, R2>`; typed failures only |
| `Effect.catchIf(refinement, f, orElse?)` / `Effect.catchFilter(filter, f)` | predicate-based |
| `Effect.catchCause(f)` | `f: (cause: Cause<E>) => Effect`; sees all three kinds |
| `Effect.catchDefect(f)` | `f: (defect: unknown) => Effect` |
| `Effect.mapError(f)` / `Effect.mapBoth` | transform `E` |
| `Effect.orDie` | `E` becomes a defect (`Effect<A, never, R>`) |
| `Effect.orElseSucceed((e) => a)` | fallback value, `E` becomes `never` |
| `Effect.ignore` / `Effect.ignore({ log: true })` | discard result and error; `log` also takes a severity or `"Unhandled"` (uses `References.UnhandledLogLevel`) |
| `Effect.tapError(f)` / `Effect.tapCause(f)` / `Effect.tapDefect(f)` | observe without changing |
| `Effect.result` | `Effect<Result<A, E>, never, R>` |
| `Effect.option` | `Effect<Option<A>, never, R>` |
| `Effect.exit` | `Effect<Exit<A, E>, never, R>` |
| `Effect.sandbox` | `Effect<A, Cause<E>, R>`; re-expose with `Effect.catchCause` |

`catchTag` requires a union member with a literal `_tag`: tags come from
`Schema.TaggedError`, `Data.TaggedError`, `Schema.TaggedClass`, or any object
with `readonly _tag: "X"`.

## Retry, time

| API | Type / notes |
| --- | --- |
| `Effect.retry({ times?, while?, until?, schedule? })` | or `Effect.retry(schedule)`; initial attempt always runs; `while`/`until` may return `boolean` or `Effect<boolean>` and may narrow `E` |
| `Effect.timeout(duration)` | `E \| Cause.TimeoutError`; interrupts the source |
| `Effect.cachedWithTTL(ttl)` | `Effect<Effect<A, E, R>>`; `ttl` is a duration or `(exit) => duration` (4.1) |
| `Effect.timeoutOption(duration)` | `Option<A>` instead of an error |
| `Effect.timeoutOrElse({ duration, orElse })` | custom fallback |
| `Effect.sleep(duration)` | durations: `"5 seconds"`, `500`, `Duration.seconds(5)` |
| `Effect.repeat(schedule)` | repeat on success |

## Collections

| API | Notes |
| --- | --- |
| `Effect.forEach(iter, f, { concurrency?, discard? })` | `f: (a, index) => Effect`; sequential by default; first failure interrupts the rest |
| `Effect.all([...] \| {k: eff}, { concurrency?, discard?, mode? })` | tuple/record in, tuple/record out; `mode: "result"` collects `Result`s |
| `Effect.partition(iter, f, opts)` | `[successes, failures]`, never fails |
| `Effect.validate(iter, f, opts)` | collects all failures, fails if any |
| `Effect.firstSuccessOf(effects)` | try in order |
| `Effect.race(a, b)` / `Effect.raceAll` | loser is interrupted |

`concurrency` is a `number` or `"unbounded"` (`Types.Concurrency`).

## Cleanup and interruption

| API | Notes |
| --- | --- |
| `Effect.acquireUseRelease(acquire, use, release)` | `release` gets `(resource, exit)` |
| `Effect.acquireRelease(acquire, release)` | needs a `Scope` in `R`; see [services](../services/guide.md) |
| `Effect.ensuring(finalizer)` | `Effect<X, never, R1>` always runs |
| `Effect.onExit((exit) => eff)` / `Effect.onError` / `Effect.onInterrupt((ids) => eff)` | |
| `Effect.uninterruptible` / `Effect.uninterruptibleMask` / `Effect.interruptible` | |

## Running (at the edge only)

| API | Result |
| --- | --- |
| `Effect.runPromise(eff, { signal? })` | `Promise<A>`; rejects on failure |
| `Effect.runPromiseExit(eff, { signal? })` | `Promise<Exit<A, E>>`; never rejects |
| `Effect.runSync(eff)` | throws `AsyncFiberError` if it suspends; also on failure |
| `Effect.runSyncExit(eff)` | `Exit` |
| `Effect.runFork(eff, opts?)` | `Fiber<A, E>` |
| `Effect.runCallback(eff, { onExit })` | returns an interruptor |
| `NodeRuntime.runMain(eff, { disableErrorReporting?, teardown? })` | `@effect/platform-node`; `eff` must have `R = never` |
| `ManagedRuntime.make(layer, { memoMap? })` | `.runPromise`, `.runPromiseExit`, `.runSync`, `.runFork`, `.dispose()` |
| `Effect.runPromiseWith(context)` etc. | when you already hold a `Context` |

## Observability one-liners

`Effect.log`, `logInfo`, `logWarning`, `logError`, `logDebug` (variadic
messages); `Effect.annotateLogs({ k: v })`; `Effect.withSpan("name", { attributes })`;
`Effect.fn("name")` already adds a span. Details in [observability](../observability/guide.md).
