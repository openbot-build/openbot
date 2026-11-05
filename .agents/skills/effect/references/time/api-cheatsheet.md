# Time API cheat sheet (effect@4.1.2)

Verified against `node_modules/effect/dist/{Schedule,Duration,DateTime,Cron,Clock,Random}.d.ts`
and `dist/testing/TestClock.d.ts`.

## Duration

`Duration.Input` is `Duration | number (milliseconds) | bigint (nanoseconds) | [seconds, nanos]
| "<n> <unit>" | "Infinity" | { weeks?, days?, hours?, minutes?, seconds?, millis?, ... }`.
Units in strings: `nano(s) micro(s) milli(s) second(s) minute(s) hour(s) day(s) week(s)`.
Every API that takes time (`Effect.sleep`, `timeout`, `Schedule.spaced`, ...) accepts any
`Duration.Input`.

Constructors: `Duration.millis(n)`, `seconds`, `minutes`, `hours`, `days`, `weeks`, `nanos(bigint)`,
`zero`, `infinity`, `fromInput(u)` (`Option`) / `fromInputUnsafe(u)`.
Arithmetic: `sum`, `subtract`, `times`, `divide`, `min`, `max`, `clamp`. Compare:
`isLessThan`, `isGreaterThan`, `between`, `Order`, `Equivalence`. Convert: `toMillis`,
`toSeconds`, `toMinutes`, `toNanos`, `toMicros` (4.1), `format(d)` (human string), `parts(d)`.
ISO 8601 (4.1): `Duration.formatIso(d)` returns `Option<string>` (`PT1H30M`), `Duration.fromIso("PT1H30M")`
returns `Option<Duration>`; both give `None` when the value is not representable or not valid.

## Schedule

`Schedule<Output, Input, Error, Env>`. Used by `Effect.retry` (Input = the error),
`Effect.repeat` / `Effect.schedule` (Input = the success value).

| Group | API |
| --- | --- |
| Delay shape | `spaced(d)` (wait `d` after each run), `fixed(d)` (regular cadence, no replay of missed ticks), `windowed(d)` (align to window boundaries), `exponential(base, factor = 2)`, `fibonacci(d)`, `duration(d)` (once, after `d`), `cron(expr, tz?, { onDstOverlap? })` |
| Counting | `recurs(n)` (n extra runs), `forever`, `once`, `during(d)` (while elapsed < d) |
| Bounding | `upTo({ times?, duration? })` stops at whichever limit comes first |
| Gating | `while(({ input, output, attempt, elapsed, duration }) => boolean \| Effect<boolean>)` |
| Combining | `max([a, b, ...])` continue while **all** continue, wait the **longer** delay; `min([...])` continue while **any** continues, wait the **shorter**; `concat(other)` run `self` then `other` |
| Tweaking | `jittered` (delay x random 0.8 to 1.2), `modifyDelay(meta => Effect<Duration.Input>)`, `addDelay`, `map`, `passthrough` (output the input), `tap(meta => Effect)` (logging, metrics), `setInputType<T>()` (name the input type so `while`/`tap` can read `input`) |
| Running by hand | `toStep(schedule)`, `toStepWithSleep(schedule)` for custom loops and tests |

`meta` (`Schedule.Metadata`) has `input`, `output`, `duration` (the chosen delay), `attempt`,
`elapsed`, `elapsedSincePrevious`, `now`, `start`.

Not in v4: `Schedule.intersect`, `union`, `andThen`, `compose`, or `upTo(n)` with a bare
number. Use `max`/`min`/`concat` and `upTo({ times })`.

`Effect.retry` accepts: a `Schedule`; a builder `($) => $(schedule)...` that infers the error
type; or options `{ times?, while?, until?, schedule? }`. `Effect.repeat` accepts the same
shape with the success value. `Effect.retryOrElse` / `Effect.repeatOrElse` add a fallback
for exhaustion. `Effect.schedule(eff, schedule)` runs `eff` first **after** the first
scheduled delay; `Effect.scheduleFrom(eff, initial, schedule)` seeds the schedule input.

```ts import.meta.vitest name="references/time/api-cheatsheet.md#1"
import { Effect, Schedule, Schema } from "effect"

class Transient extends Schema.TaggedError<Transient>()("Transient", { retryable: Schema.Boolean }) {}

// A real flaky call: fails with a retryable error twice, then succeeds.
let attempts = 0
const call: Effect.Effect<string, Transient> = Effect.suspend(() =>
  ++attempts < 3 ? Effect.fail(new Transient({ retryable: true })) : Effect.succeed("ok")
)

// Builder form: `$` fixes the schedule's input type to the effect's error type.
export const withBuilder = call.pipe(
  Effect.retry(($) =>
    $(Schedule.exponential("1 millis")).pipe(
      Schedule.while(({ input }) => input.retryable),
      Schedule.upTo({ times: 4 })
    )
  )
)

// "Fast at first, then settle": exponential until it reaches 5s, then every 5s, 10 times.
export const rampThenSteady = Schedule.min([
  Schedule.exponential("250 millis"),
  Schedule.spaced("5 seconds")
]).pipe(Schedule.upTo({ times: 10 }))

// Run the first policy for a while, then fall back to a slower one.
export const phases = Schedule.spaced("1 second").pipe(
  Schedule.upTo({ times: 5 }),
  Schedule.concat(Schedule.spaced("1 minute"))
)

await Effect.runPromise(withBuilder) // => "ok"
attempts // => 3
```

## Clock and TestClock

`Clock.currentTimeMillis`, `Clock.currentTimeNanos`, `Clock.monotonicTimeNanos` are Effects
(unsafe synchronous variants end in `Unsafe`). `Clock.Clock` is a `Context.Reference`, so a
custom clock is provided with `Effect.provideService(Clock.Clock, impl)`.

`TestClock` (`import { TestClock } from "effect/testing"`): `TestClock.layer()`,
`TestClock.adjust(duration)` (advance and run everything due, in order), `TestClock.setTime(millis)`,
`TestClock.withLive(eff)` (run `eff` against real time). The virtual clock starts at epoch 0
(1970-01-01T00:00:00Z).

## DateTime

Two shapes: `DateTime.Utc` (instant) and `DateTime.Zoned` (instant + `TimeZone`).

| Need | API |
| --- | --- |
| Now (Clock-based) | `DateTime.now` (`Effect<Utc>`), `nowInCurrentZone` (needs `CurrentTimeZone`), `nowUnsafe()` |
| Parse safely | `DateTime.make(input)` -> `Option`; `makeZoned(input, { timeZone, adjustForTimeZone? })` -> `Option<Zoned>`; `*Unsafe` variants throw |
| Attach a zone | `setZoneNamed("Europe/Berlin")` -> `Option<Zoned>`, `setZoneNamedUnsafe`, `setZoneOffset(ms)`, `setZoneCurrent` |
| Provide a default zone | `DateTime.layerCurrentZoneNamed(id)`, `layerCurrentZoneLocal`, `withCurrentZoneNamed(id)(eff)` |
| Calendar math | `add(dt, { days, months, ... })`, `subtract`, `startOf(dt, "day" \| "week" \| "month" ...)`, `endOf`, `nearest` |
| Exact elapsed math | `addDuration(dt, "24 hours")`, `subtractDuration`, `distance(a, b)` -> `Duration` |
| Compare | `Order`, `isLessThan`, `isGreaterThan`, `between`, `min`, `max`, `clamp`, `isPast(dt)` / `isFuture(dt)` (Effects reading the Clock) |
| Convert/format | `toEpochMillis`, `toDate`, `formatIso`, `formatIsoZoned`, `formatIsoDate`, `format({ ... })` (Intl options), `toParts`, `toUtc` |

Schema codecs for the boundary: `Schema.DateTimeUtcFromString`, `DateTimeUtcFromMillis`,
`DateTimeUtcFromDate`, `DateTimeZonedFromString`, `DurationFromMillis`, `DurationFromNanos`,
`DurationFromString`. (`Schema.DateTimeUtc` alone only accepts an existing `DateTime.Utc`.)

## Cron

`Cron.parse(expr, tz?, { onDstOverlap? })` returns a `Result<Cron, CronParseError>` (do not `throw`); `parseUnsafe`
throws. `Cron.next(cron, from?)` / `prev` return a `Date`; `Cron.sequence(cron, from?)` is an
iterator of upcoming dates; `Cron.match(cron, date)` tests a date. `Schedule.cron(expr, tz?)`
accepts a string or a parsed `Cron` and outputs the delay until the next match. 4.1 adds
`onDstOverlap: "earlier" | "later" | "both"` (default `"earlier"`) for local times that occur twice when
clocks fall back; it is accepted by `Cron.parse`, `parseUnsafe`, `make` and `Schedule.cron`.
Five fields (minute hour day-of-month month day-of-week) or six with a leading seconds field.

## Random

`Random.next` (0 to 1), `nextBoolean`, `nextInt`, `nextBetween(min, max)`,
`nextIntBetween(min, max)`, `shuffle(items)`, `choice(items)`. `effect.pipe(Random.withSeed("x"))`
makes the sequence deterministic for a test.
