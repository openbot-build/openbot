# Testing API cheat sheet (effect@4.1.x)

Signatures were read from `node_modules/effect/dist/testing/*.d.ts` and the
modules named. Import with `import { TestClock, TestConsole, TestSchema } from "effect/testing"`.

## TestClock

| API | Type | Notes |
| --- | --- | --- |
| `TestClock.layer(options?)` | `Layer<TestClock>` | `options.warningDelay` configures the "you are waiting on the clock" warning. Provide it to replace `Clock`. |
| `TestClock.adjust(duration)` | `Effect<void>` | move time forward; everything scheduled at or before the new time runs in order |
| `TestClock.setTime(timestamp)` | `Effect<void>` | absolute epoch milliseconds (starts at 0) |
| `TestClock.withLive(effect)` | `Effect<A, E, R>` | run a part of the test with the real clock |
| `TestClock.testClockWith((tc) => effect)` | | access the service (`tc.currentTimeMillisUnsafe()`) |
| `TestClock.make(options?)` | `Effect<TestClock, never, Scope>` | construct manually |

Everything time-based honours it: `Effect.sleep`, `Effect.timeout`,
`Effect.retry(schedule)`, `Effect.repeat(schedule)`, `Effect.delay`,
`Clock.currentTimeMillis`, cache TTLs.

Rules observed while verifying:

- A forked fiber does not run until the forking fiber yields. Use
  `Effect.forkChild(eff, { startImmediately: true })` when you must assert on
  state before the first `adjust`; `adjust` itself yields.
- `Schedule.exponential("1 second")` waits 1s, then 2s, then 4s.
- Sleeps wake in registration order, and the clock waits for each woken fiber
  to suspend before waking the next (4.1; needs `TestClock.layer()`).
- A sleeping fiber is woken only by `adjust`/`setTime`; waiting without
  advancing the clock hangs the test (and the clock warns after `warningDelay`).

## TestConsole

| API | Type |
| --- | --- |
| `TestConsole.layer` | `Layer<TestConsole>` |
| `TestConsole.logLines` | `Effect<ReadonlyArray<unknown>>`, arguments from `Console.log` |
| `TestConsole.errorLines` | `Effect<ReadonlyArray<unknown>>`, from `Console.error` |
| `TestConsole.testConsoleWith(f)` | access the service |

`Effect.log` output also lands in the console under the default logger, with a
timestamp prefix, so assert on logs with a capturing `Logger`:

```ts import.meta.vitest name="references/testing/api-cheatsheet.md#1"
import { Effect, Logger } from "effect"

const lines: Array<string> = []
const capture = Logger.make<unknown, void>(({ logLevel, message }) => {
  lines.push(`${logLevel}:${Array.isArray(message) ? message.join(" ") : String(message)}`)
})

export const run = Effect.logInfo("charged", 500).pipe(
  Effect.andThen(Effect.logWarning("slow")),
  Effect.provide(Logger.layer([capture]))
)

await Effect.runPromise(run)
lines // => ["Info:charged 500", "Warn:slow"]
```

`Logger.layer(loggers, { mergeWithExisting? })` replaces the logger set (or
adds to it with `mergeWithExisting: true`). A logger's options are
`{ message, logLevel, cause, fiber, date }`.

## TestSchema

`TestSchema` is `@stability unstable`. Promise-returning methods work in any
runner; methods ending in `Effect` use the calling fiber's services.

```ts import.meta.vitest name="references/testing/api-cheatsheet.md#2"
import { Schema } from "effect"
import { TestSchema } from "effect/testing"

const Port = Schema.Struct({ port: Schema.Int })
const asserts = new TestSchema.Asserts(Port)

await asserts.decoding().succeed({ port: 8080 })
await asserts.decoding().succeed({ port: 8080 }, { port: 8080 }) // with expected value
// `fail` compares the *formatted issue message* exactly:
await asserts.decoding().fail({ port: 1.5 }, 'Expected an integer\n  at ["port"]')
await asserts.encoding().succeed({ port: 8080 })
await asserts.make().succeed({ port: 8080 })
// property-based: decode(encode(x)) equals x
await new TestSchema.Asserts(Schema.NumberFromString).verifyRoundTrip({ seed: 1, runs: 20 })
await asserts.verifyRoundTrip({ seed: 1, runs: 20 })
```

| API | Notes |
| --- | --- |
| `new TestSchema.Asserts(schema)` | |
| `.decoding(opts?)` -> `succeed`, `succeedEffect`, `fail`, `failEffect`, `provide(service, impl)` | |
| `.encoding(opts?)` -> same set | |
| `.make(opts?)` -> `succeed`, `succeedEffect`, `fail`, `failEffect` | for `Schema.make` constructors |
| `.verifyRoundTrip(opts?)` / `.verifyRoundTripEffect(opts?)` | v3 name `verifyLosslessTransformation` is gone. Property-based: `decode(encode(x))` must equal `x` under the schema's own equivalence. Verified on 4.1.2 for `String`, `Int`, `NumberFromString` and `Schema.Struct({ a: Schema.String })` (4.0.0 falsified structs because it compared with `isDeepStrictEqual`). |
| `.arbitrary().verifyGeneration(opts?)` | generated values satisfy the schema |

## Other test-relevant APIs

| API | Use |
| --- | --- |
| `Layer.mock(Service, partial)` | partial test double; omitted members fail with an "unimplemented" defect |
| `Layer.buildWithScope(layer, scope)` / `Scope.make` / `Scope.close(scope, Exit.void)` | assert finalizers |
| `Random.withSeed(seed)` | deterministic randomness for an effect |
| `Deferred.make<A>()` / `Deferred.succeed(d, a)` / `Deferred.await(d)` | fiber handshake |
| `Latch.make(open?)` / `Latch.open` | gate fibers |
| `Effect.flip` | assert on typed failures |
| `Effect.exit` / `Effect.result` | assert on the whole outcome / on the typed outcome |
| `Fiber.join` / `Fiber.await` / `Fiber.interrupt` | `join` rethrows the fiber's failure, `await` returns an `Exit` |
| `Effect.forkChild(eff, { startImmediately: true })` | run the first step before the caller continues |
