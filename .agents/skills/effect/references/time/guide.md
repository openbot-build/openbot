# Effect time

## How to think about it

"Time" in a program is four different things, and most time bugs come from
using the wrong one:

| Concept | Type | Question it answers |
| --- | --- | --- |
| Amount of elapsed time | `Duration` | "wait 30 seconds", "timeout after 2 s" |
| Point on the timeline | `DateTime.Utc` | "when did this happen", "expires at" |
| Calendar/wall-clock value | `DateTime.Zoned` | "9am Tuesday in Berlin", "add one month" |
| Policy for doing something again | `Schedule` | "retry 5 times with backoff", "every night at 02:00" |

All four meet at one service, `Clock`. `Effect.sleep`, `Effect.timeout`,
`Schedule`, `DateTime.now` and `DateTime.isPast` ask the Clock what time it is.
That is why the same code runs in production and finishes instantly under
`TestClock`. `Date.now()` and `setTimeout` bypass the Clock: they are real time
in tests, they cannot be interrupted cleanly, and they hide the dependency from
the type.

A `Schedule` is a **value describing a decision sequence**, not a loop. Each time
it is stepped it receives an input (the *error* for `Effect.retry`, the *success
value* for `Effect.repeat`) and answers "go again after this delay" or "stop".
Combinators build policies from small parts: a delay shape (`spaced`, `fixed`,
`exponential`, `cron`), a bound (`recurs`, `upTo`), a gate (`while`), and a tweak
(`jittered`, `modifyDelay`). Because it receives the input, the policy can
classify the failure, which a bare `for` loop with `setTimeout` never does well.

Coming from Promise/setInterval: the first execution is never delayed by
`retry`/`repeat`; `recurs(n)` counts the *extra* runs; and a plain number is
**milliseconds** wherever a `Duration.Input` is expected, so `Effect.sleep(5)` is
five milliseconds. Prefer the string form `"5 seconds"`.

## Choose

| Situation | Use | Why / when not |
| --- | --- | --- |
| Pause | `Effect.sleep("2 seconds")` | Interruptible, TestClock-controlled |
| Give up on slow work | `Effect.timeout(d)` (typed `TimeoutError`), `timeoutOption`, `timeoutOrElse` | Interrupts the work. Put it around the *whole* retry for a hard deadline |
| Retry transient failures | `Effect.retry(policy)` with `Schedule.exponential(...).pipe(Schedule.jittered, Schedule.upTo(...))` | Always bound it; classify with `Schedule.while` on the error; never retry validation or auth |
| Simple retry count | `Effect.retry({ times: 3 })` or `{ while: pred }` | No delay. Fine for tests and in-process retries, wrong for networks |
| Poll until a condition | `Effect.repeat({ schedule, until })` | Poll state, then map "still running at the end" to a typed timeout |
| Run periodically, first run now | `Effect.repeat(Schedule.spaced(d))` | `spaced` waits `d` after each run; `fixed` keeps a regular cadence; `windowed` aligns to boundaries |
| Run periodically, first run after the first delay | `Effect.schedule(job, schedule)` | Use for cron: do not run at start-up |
| Calendar schedule | `Schedule.cron("0 2 * * *", "Europe/Berlin")` or `Cron.parse` + `Cron.next` | Calendar, not an interval. Store the zone with the job |
| Current instant | `DateTime.now`, `Clock.currentTimeMillis` | Never `Date.now()` |
| Measure duration | `Effect.timed(eff)` returns `[Duration, A]` | Monotonic, TestClock-aware |
| Calendar arithmetic | `DateTime.add(dt, { months: 1 })` on a `Zoned` value | DST-aware. `addDuration(dt, "24 hours")` is exactly 24 h, not "tomorrow" |
| Parse/encode at the boundary | `Schema.DateTimeUtcFromString`, `DateTimeUtcFromMillis`, `DurationFromMillis` | Never pass raw `Date`/number through the domain |
| Deterministic randomness | `Random.next` + `Random.withSeed("x")` | `jittered` uses it too |
| Debounce/throttle/windows of a stream | not this skill: [streams](../streams/guide.md) | |
| Rate limiting concurrent calls | not this skill: [concurrency](../concurrency/guide.md) | |

## Recipe

### The pitfall: a hand-rolled retry loop

```ts skip
// WRONG: retries every error (including 404 and bugs), no jitter, no overall bound,
// uses real timers, and swallows interruption.
async function getInvoice(id: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.fetchInvoice(id)
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
}
```

### The idiom: a policy that reads the error

Design decisions: the failures are tagged data so the policy can read them
(`NotFound` is permanent, `RateLimited` carries the server's wait,
`Unavailable` is transient); the policy is one named value you can test and
reuse; there is a retry-count bound **and** a time bound; the whole operation
has a hard deadline.

```ts import.meta.vitest name="references/time/guide.md#2"
import { Duration, Effect, Schedule, Schema } from "effect"

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }) {}
export class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {}) {}
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  // Schema.DurationFromMillis decodes the wire number into a Duration.
  retryAfter: Schema.DurationFromMillis
}) {}
export type InvoiceError = NotFound | Unavailable | RateLimited

export const invoiceRetry = (base: Duration.Input) => Schedule.exponential(base).pipe(
  // +/- 20% random spread, so a fleet of clients does not retry in lockstep.
  Schedule.jittered,
  // Tell the schedule what it will be fed: the failure. This unlocks `input` below.
  Schedule.setInputType<InvoiceError>(),
  // Honour the server's Retry-After if it is longer than our backoff.
  Schedule.modifyDelay(({ input, duration }) =>
    Effect.succeed(input._tag === "RateLimited" ? Duration.max(duration, input.retryAfter) : duration)
  ),
  // Permanent errors stop the schedule at once, so the original error surfaces.
  Schedule.while(({ input }) => input._tag !== "NotFound"),
  // Hard limits: at most 5 retries (6 attempts) and 30 seconds of schedule time.
  Schedule.upTo({ times: 5, duration: "30 seconds" })
)

// The real call would be an HttpClient inside a service; here it fails twice.
let calls = 0
const fetchInvoice = (id: string): Effect.Effect<{ readonly id: string; readonly total: number }, InvoiceError> =>
  Effect.suspend(() => (++calls < 3 ? Effect.fail(new Unavailable()) : Effect.succeed({ id, total: 42 })))

export const getInvoice = (id: string, base: Duration.Input = "200 millis") =>
  fetchInvoice(id).pipe(
    Effect.retry(invoiceRetry(base)),
    // Deadline for everything above, retries included. Adds TimeoutError to E.
    Effect.timeout("45 seconds")
  )

// A tiny base keeps the demo instant; production uses the default.
await Effect.runPromise(getInvoice("inv-1", "1 millis")) // => { id: "inv-1", total: 42 }
calls // => 3
```

Read the result type: `Effect<{...}, InvoiceError | TimeoutError>`. A caller can
`catchTag("NotFound", ...)`; nothing else was swallowed.

### Poll until done, with a typed give-up

`Effect.repeat` runs the effect, then asks the schedule whether to go again.
`until` stops on success of the *condition*; the schedule bounds how long we try.
When the schedule is exhausted `repeat` returns the **last** value, so you must
look at it and decide: it is still "running", which is your timeout.

```ts import.meta.vitest name="references/time/guide.md#3"
import { Context, Duration, Effect, Layer, Ref, Schedule, Schema } from "effect"

export class JobFailed extends Schema.TaggedError<JobFailed>()("JobFailed", {
  jobId: Schema.String,
  reason: Schema.String
}) {}
export class JobTimedOut extends Schema.TaggedError<JobTimedOut>()("JobTimedOut", {
  jobId: Schema.String
}) {}

type Status =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Done"; readonly url: string }
  | { readonly _tag: "Failed"; readonly reason: string }

export class Exports extends Context.Service<Exports, {
  status(jobId: string): Effect.Effect<Status>
}>()("app/Exports") {}

export const waitForExport = Effect.fn("waitForExport")(function*(
  jobId: string,
  options: { readonly every: Duration.Input; readonly giveUpAfter: Duration.Input }
) {
  const exports = yield* Exports
  const last = yield* exports.status(jobId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(options.every).pipe(
        Schedule.upTo({ duration: options.giveUpAfter })
      ),
      until: (status) => status._tag !== "Running"
    })
  )
  switch (last._tag) {
    case "Done":
      return last.url
    case "Failed":
      return yield* new JobFailed({ jobId, reason: last.reason })
    case "Running":
      return yield* new JobTimedOut({ jobId })
  }
})

// A fake service: running for three polls, then done.
const polls = Ref.makeUnsafe(0)
const FakeExports = Layer.succeed(
  Exports,
  Exports.of({
    status: () =>
      Ref.updateAndGet(polls, (n) => n + 1).pipe(
        Effect.map((n): Status => (n < 4 ? { _tag: "Running" } : { _tag: "Done", url: "https://files/x.csv" }))
      )
  })
)

await Effect.runPromise(
  waitForExport("job-1", { every: "10 millis", giveUpAfter: "1 second" }).pipe(Effect.provide(FakeExports))
) // => "https://files/x.csv"
```

### Calendar jobs and DST-safe arithmetic

An interval ("every 24 hours") drifts across daylight-saving changes; a
calendar rule ("02:00 in the tenant's zone") does not. Run cron jobs with
`Effect.schedule` so nothing executes at start-up, and do date math on a
`Zoned` value with calendar units.

```ts import.meta.vitest name="references/time/guide.md#4"
import { DateTime, Effect, Option, Schedule } from "effect"

// Nightly at 02:00 in the tenant's zone. The zone is data stored with the tenant.
export const nightly = <A, E, R>(job: Effect.Effect<A, E, R>, zone: string) =>
  Effect.schedule(job, Schedule.cron("0 2 * * *", zone))

// 12:00 the day before New York "springs forward".
const noon = DateTime.makeZonedUnsafe("2024-03-09T12:00:00", {
  timeZone: "America/New_York",
  adjustForTimeZone: true // interpret the string as New York wall-clock time
})

// Calendar day: still 12:00 on the wall clock (offset changed from -05:00 to -04:00).
DateTime.formatIsoZoned(DateTime.add(noon, { days: 1 })) // => "2024-03-10T12:00:00.000-04:00[America/New_York]"
// Exactly 24 elapsed hours: 13:00 on the wall clock, because the clocks jumped.
DateTime.formatIsoZoned(DateTime.addDuration(noon, "24 hours")) // => "2024-03-10T13:00:00.000-04:00[America/New_York]"

// Parse untrusted text into a typed Option instead of throwing.
Option.isSome(DateTime.make("2024-06-15T14:30:00.000Z")) // => true
Option.isNone(DateTime.make("not a date")) // => true
```

Store and exchange instants as UTC (`DateTime.Utc`, ISO string or epoch
millis); attach a zone only for display and calendar rules.

### Repeated local times and ISO durations (4.1)

When clocks fall back, a local time such as 02:30 happens twice. A `Cron` fires on
the first occurrence by default; `onDstOverlap` chooses `"later"` or `"both"`.
`Duration.fromIso` / `formatIso` exchange ISO 8601 durations as `Option` values.

```ts import.meta.vitest name="references/time/guide.md#5"
import { Cron, Duration, Option } from "effect"

// Europe/Berlin repeats 02:00-02:59 on 2026-10-25 (first at +02:00, then at +01:00).
const earlier = Cron.parseUnsafe("30 2 * * *", "Europe/Berlin")
const both = Cron.parseUnsafe("30 2 * * *", "Europe/Berlin", { onDstOverlap: "both" })

// After 00:30Z, "earlier" skips the second 02:30 and waits for the next day.
Cron.next(earlier, "2026-10-25T00:30:00Z").toISOString() // => "2026-10-26T01:30:00.000Z"
Cron.next(both, "2026-10-25T00:30:00Z").toISOString() // => "2026-10-25T01:30:00.000Z"

Duration.formatIso(Duration.minutes(90)) // => Option.some("PT1H30M")
Option.map(Duration.fromIso("PT1H30M"), Duration.toMinutes) // => Option.some(90)
Option.isNone(Duration.fromIso("soon")) // => true
```

## Anti-patterns

**1. Raw `Date.now()` / `setTimeout` / `setInterval`.**

```ts skip
const expired = Date.now() > token.expiresAt
```
Right: `const now = yield* Clock.currentTimeMillis` (or `DateTime.isPast(expiresAt)`).
Consequence: tests need real waiting and time travel is impossible.

**2. Unbounded or indiscriminate retry.**

```ts skip
effect.pipe(Effect.retry(Schedule.exponential("1 second"))) // forever, retries every error
```
Right: add `Schedule.upTo({ times, duration })` and `Schedule.while` on the error.
Consequence: a permanent failure becomes an infinite loop and a retry storm.

**3. Backoff without jitter against a shared dependency.** Right:
`Schedule.jittered` on the backoff. Consequence: every client retries on the same
tick and re-overloads the service.

**4. Treating a bare number as seconds.** `Effect.sleep(5)` is 5 ms and
`Schedule.spaced(30)` is 30 ms. Right: `"5 seconds"`, `Duration.seconds(5)`.
Consequence: a hot loop that looks like a calm poll.

**5. Expecting `repeat` to wait before the first run, or `recurs(n)` to mean
n attempts.** `Effect.repeat(job, schedule)` runs once immediately;
`Schedule.recurs(3)` allows 3 *additional* runs (4 total). Right: use
`Effect.schedule` for "first run after the delay", and count from the docs. Consequence:
a cron job that fires on deploy, or one attempt too many.

**6. Ignoring the exhausted `repeat`.** After `repeat({ until, schedule })` the value
may still be "not done". Right: inspect it and fail with a typed timeout.
Consequence: callers treat an unfinished job as success.

**7. Adding `24 * 3600 * 1000` for "tomorrow" or JS `Date` math across zones.**
Right: `DateTime.add(zoned, { days: 1 })` on a `Zoned` value. Consequence: events
shift by an hour twice a year and `Date` silently uses the server's zone.

**8. Retrying non-idempotent work.** Retrying a payment `POST` without an
idempotency key duplicates the charge. Right: make the operation idempotent
first, then retry. Consequence: double side effects that no policy can detect.

**9. Swallowing the timeout.** `Effect.timeout` adds `TimeoutError` to `E`; handling
it with a generic `catch` also hides real errors. Right:
`Effect.catchTag("TimeoutError", ...)` or `timeoutOrElse`. Consequence: genuine
failures are reported as "slow".

## Testing it

Provide `TestClock.layer()` (from `effect/testing`), start the code in a fiber with
`startImmediately`, move time with `TestClock.adjust`, then join. No real waiting,
exact timelines. With `@effect/vitest` the same body lives inside
`it.effect("...", () => Effect.gen(...))`, which already provides the TestClock.

```ts import.meta.vitest name="references/time/guide.md#7"
import assert from "node:assert/strict"
import { Clock, DateTime, Effect, Fiber, Schedule } from "effect"
import { TestClock } from "effect/testing"

const test = Effect.gen(function*() {
  // 1. Retry timeline: record the virtual time of every attempt.
  const attempts: Array<number> = []
  const flaky = Clock.currentTimeMillis.pipe(
    Effect.tap((now) => Effect.sync(() => void attempts.push(now))),
    Effect.andThen(Effect.fail("unavailable" as const))
  )
  const fiber = yield* Effect.forkChild(
    flaky.pipe(Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 3 }))), Effect.exit),
    { startImmediately: true }
  )
  yield* TestClock.adjust("3 seconds")
  const exit = yield* Fiber.join(fiber)
  assert.deepEqual(attempts, [0, 1000, 2000, 3000]) // 1 attempt + 3 retries
  assert.equal(exit._tag, "Failure") // the policy was exhausted; the error is surfaced

  // 2. Expiry: set the clock instead of waiting for it.
  const expiresAt = DateTime.makeUnsafe("2030-01-01T00:00:00Z")
  yield* TestClock.setTime(DateTime.toEpochMillis(expiresAt) - 1000)
  assert.equal(yield* DateTime.isPast(expiresAt), false)
  yield* TestClock.adjust("2 seconds")
  assert.equal(yield* DateTime.isPast(expiresAt), true)

  // 3. A timeout without sleeping a minute.
  const slow = yield* Effect.forkChild(
    Effect.sleep("1 hour").pipe(Effect.timeout("1 minute"), Effect.flip),
    { startImmediately: true }
  )
  yield* TestClock.adjust("1 minute")
  assert.equal((yield* Fiber.join(slow))._tag, "TimeoutError")
}).pipe(Effect.provide(TestClock.layer()))

await Effect.runPromise(test)
```

Test the *policy*, not the library: assert the attempt count, that a
`NotFound` stops after one attempt, and that `RateLimited` waits at least
`retryAfter`. For jitter, either assert bounds (delays within 0.8x to 1.2x) or run
with `Random.withSeed("seed")`. Fake the dependency as a service (see
`Exports` above) so tests control its answers sequence.

## Changed in 4.1

- `Cron.parse`, `parseUnsafe`, `make` and `Schedule.cron` accept `onDstOverlap`
  (`"earlier"` default, `"later"`, `"both"`) for local times repeated when clocks
  fall back.
- `Duration.fromIso` and `Duration.formatIso` (both `Option`) and `Duration.toMicros`.
- `Effect.cachedWithTTL` (and `cachedInvalidateWithTTL`) accept a function
  `(exit) => Duration.Input`, so failures can be cached for a shorter time (or not at all).
- `Schedule.cron` and `Schedule.windowed` no longer produce a zero delay at an exact
  boundary: the next occurrence or full window is used instead.
- The official retry pattern in the docs now bounds attempts with
  `Schedule.upTo({ times })`, as the recipe above does.

## Boundaries

- Errors, `Cause`, `Effect.exit`, interruption semantics: [core](../core/guide.md). This skill
  chooses *when* to retry; classifying failures into tagged errors is the
  caller's design.
- Fibers, forking a scheduled loop into a scope, queues and semaphores:
  [concurrency](../concurrency/guide.md). `Effect.forkScoped(nightly(job, zone))` inside a Layer is
  the right home for a background cron job.
- Decoding date/duration strings and numbers at the edge: [schema](../schema/guide.md).
- Rate limits, retries and timeouts of HTTP calls: [http](../http/guide.md); the policies
  here plug into it.
- Debounce, throttle, `Stream.schedule`, `Stream.tick`: [streams](../streams/guide.md).
- Testing conventions and `@effect/vitest`: [testing](../testing/guide.md).
- Durable timers that survive restarts (workflows, cluster):
  [workflow](../workflow/guide.md) / [cluster](../cluster/guide.md). A `Schedule` lives only as long as the
  process.

## References

- [Schedule, Duration, DateTime, Cron and Clock cheat sheet](api-cheatsheet.md)
- [Effect API: Schedule](https://effect.website/docs/v4/api/effect/Schedule)
- [Effect API: Cron](https://effect.website/docs/v4/api/effect/Cron)
- [Effect API: Duration](https://effect.website/docs/v4/api/effect/Duration)
- [Effect API: DateTime](https://effect.website/docs/v4/api/effect/DateTime)
- [Effect API: Clock](https://effect.website/docs/v4/api/effect/Clock)
- [Pinned Schedule source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Schedule.ts)
- [Pinned DateTime source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/DateTime.ts)
- [Pinned TestClock source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/testing/TestClock.ts)
