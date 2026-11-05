# Testing Effect programs

## How to think about it

Effect code is testable because an effect is a *description*: the code under
test never changes, only what you hand it does. The dependencies are in `R`
(services) and time is a service too (`Clock`), so a test is:

1. take the **same** effect production runs,
2. **provide different services** (an in-memory fake, a scripted double, a
   `TestClock`),
3. run it and assert on its **outcome**: success value, typed failure, defect,
   interruption, resource release.

You do not mock modules, stub `setTimeout`, patch globals or call
`vi.useFakeTimers()`. If you feel the urge, the code reaches for something that
should be a service; fix that instead ([services](../services/guide.md)).

People used to Jest/Promise tests get three things wrong. They *wait*
(`sleep(1000)` in a test); here you move a virtual clock. They test only the
happy value; here the error channel is part of the contract, so you assert on
it as data. And they mock the framework (`runPromise`, `Layer`) instead of
swapping the edge (the Gateway, the clock).

## Choose

| You need to test | Use | Why |
| --- | --- | --- |
| Pure function, no Effect | plain test (`assert`, vitest `expect`) | Effect adds nothing |
| Effect with services | `Effect.provide(testLayer)` | same code, fake edges |
| Fake that needs state or call counts | in-memory layer with a `Ref`, exposed as its own service | assert what happened, not how |
| Only a few members of a big service | `Layer.mock(Service, { member })` | the rest fail loudly as "unimplemented" |
| A sequence of outcomes (fail, fail, succeed) | a *scripted* layer indexed by call count | tests retry and fallback logic |
| `sleep`, `timeout`, `retry`, `Schedule`, TTLs | `TestClock.layer()` + `forkChild` + `TestClock.adjust` | instant, deterministic |
| "What time is it?" | `TestClock.setTime(ms)` then `Clock.currentTimeMillis` | exact timestamps |
| Typed failure | `Effect.flip(eff)` or `Effect.exit(eff)` | error becomes a value to assert on |
| Defect or interruption | `Effect.exit` + `Cause.hasDies` / `hasInterrupts` | typed handlers never see them |
| Cleanup/finalizer ran | build in a scope you close, or `Effect.onInterrupt` flag | resources are behaviour |
| Two fibers must reach a point | `Deferred` / `Latch` handshake | never `sleep` to "let it run" |
| Console output | `TestConsole.layer` + `TestConsole.logLines` | captured, not printed |
| Log messages | `Logger.make` + `Logger.layer([capture])` | `Effect.log` goes through Loggers |
| Randomness | `Random.withSeed("seed")` or a service | reproducible |
| Schemas | `new TestSchema.Asserts(schema)` | decode/encode/round-trip helpers |
| Test runner glue | `@effect/vitest`: `it.effect`, `it.live`, `layer()` | provides TestClock, runs the Effect |
| Real network/database | `it.live` + the real layer, kept few | integration, not unit |

## Recipe

The code under test: a checkout that calls a payment gateway, retries
outages with backoff, never retries a declined card, and gives up after 30
seconds. This is exactly the logic that is painful to test with Promises,
because it is made of time and failure.

```ts import.meta.vitest name="references/testing/guide.md#1"
import assert from "node:assert/strict"
import { Context, Effect, Fiber, Layer, Ref, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"

// ---- code under test (production code; no test knowledge) ---------------
export class CardDeclined extends Schema.TaggedError<CardDeclined>()("CardDeclined", {
  reason: Schema.String
}) {}
export class GatewayDown extends Schema.TaggedError<GatewayDown>()("GatewayDown", {}) {}

export class Gateway extends Context.Service<Gateway, {
  charge(cents: number): Effect.Effect<string, CardDeclined | GatewayDown>
}>()("app/Gateway") {}

export const checkout = Effect.fn("checkout")(
  function*(cents: number) {
    const gateway = yield* Gateway
    return yield* gateway.charge(cents)
  },
  // Retry only outages: backoff 1s, 2s, 4s..., at most 3 retries.
  Effect.retry({
    schedule: Schedule.exponential("1 second"),
    times: 3,
    while: (e) => e._tag === "GatewayDown"
  }),
  Effect.timeout("30 seconds")
)

// ---- test double: a scripted gateway -------------------------------------
// Call n returns outcomes[n] (the last outcome repeats). `Calls` is a separate
// service so the test can ask "how many times was it called?".
export class Calls extends Context.Service<Calls, Ref.Ref<number>>()("test/Calls") {}

export const scripted = (
  outcomes: ReadonlyArray<Effect.Effect<string, CardDeclined | GatewayDown>>
) =>
  Layer.effect(
    Gateway,
    Effect.gen(function*() {
      const calls = yield* Calls
      return Gateway.of({
        charge: () =>
          Ref.getAndUpdate(calls, (n) => n + 1).pipe(
            Effect.flatMap((n) => outcomes[Math.min(n, outcomes.length - 1)] ?? Effect.die("empty script"))
          )
      })
    })
  ).pipe(
    // provideMerge: expose Calls to the test as well as Gateway.
    Layer.provideMerge(Layer.effect(Calls, Ref.make(0)))
  )

const ok = Effect.succeed("receipt-1")
const down = Effect.fail(new GatewayDown())
const declined = Effect.fail(new CardDeclined({ reason: "insufficient funds" }))

// ---- tests: each one is an ordinary Effect --------------------------------

// 1. Success: no retries.
export const successTest = Effect.gen(function*() {
  assert.equal(yield* checkout(500), "receipt-1")
  assert.equal(yield* Ref.get(yield* Calls), 1)
}).pipe(Effect.provide(scripted([ok])))

// 2. A declined card is a *typed failure* and is not retried.
//    Effect.flip puts the error in the success channel so we can assert on it.
export const declinedTest = Effect.gen(function*() {
  const error = yield* Effect.flip(checkout(500))
  assert.equal(error._tag, "CardDeclined")
  assert.equal(yield* Ref.get(yield* Calls), 1)
}).pipe(Effect.provide(scripted([declined])))

// 3. Outage -> exponential backoff, in zero real time.
//    Rule: fork the effect that sleeps, then advance the clock.
//    startImmediately makes the fiber run its first step before we continue.
export const retryTest = Effect.gen(function*() {
  const calls = yield* Calls
  const fiber = yield* Effect.forkChild(checkout(500), { startImmediately: true })
  assert.equal(yield* Ref.get(calls), 1) // attempt 1 ran, now sleeping 1s
  yield* TestClock.adjust("1 second") // backoff 1 elapses -> attempt 2, sleeping 2s
  assert.equal(yield* Ref.get(calls), 2)
  yield* TestClock.adjust("2 seconds") // backoff 2 elapses -> attempt 3 succeeds
  assert.equal(yield* Fiber.join(fiber), "receipt-1")
  assert.equal(yield* Ref.get(calls), 3)
}).pipe(Effect.provide(scripted([down, down, ok])))

// 4. Timeout: the hung call is interrupted and the caller gets TimeoutError.
export const timeoutTest = Effect.gen(function*() {
  const fiber = yield* Effect.forkChild(checkout(500), { startImmediately: true })
  yield* TestClock.adjust("30 seconds")
  const error = yield* Effect.flip(Fiber.join(fiber))
  assert.equal(error._tag, "TimeoutError")
}).pipe(Effect.provide(scripted([Effect.never])))

// ---- a minimal runner ------------------------------------------------------
// This is all `it.effect` does for you: provide TestClock, run, fail on error.
const run = (name: string, test: Effect.Effect<void, unknown>) =>
  Effect.runPromise(test.pipe(Effect.provide(TestClock.layer()))).then(() => console.log("ok", name))

await run("success", successTest)
await run("declined", declinedTest)
await run("retry", retryTest)
await run("timeout", timeoutTest)
```

The same tests under `@effect/vitest` (install `vitest` and `@effect/vitest`;
keep `@effect/vitest` at the same version as `effect`). `it.effect` runs the
returned Effect with a `TestClock` in place, so you drop the runner and the
`TestClock.layer()`. In a project the production code lives in its own module
and the test imports it; this file is self-contained so it typechecks here.

```ts
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Ref, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"

class GatewayDown extends Schema.TaggedError<GatewayDown>()("GatewayDown", {}) {}

class Gateway extends Context.Service<Gateway, {
  charge(cents: number): Effect.Effect<string, GatewayDown>
}>()("app/Gateway") {}

const checkout = (cents: number) =>
  Gateway.use((gateway) => gateway.charge(cents)).pipe(
    Effect.retry({ schedule: Schedule.exponential("1 second"), times: 3 }),
    Effect.timeout("30 seconds")
  )

// Fails twice with GatewayDown, then succeeds. `Calls` counts attempts.
class Calls extends Context.Service<Calls, Ref.Ref<number>>()("test/Calls") {}
const flakyGateway = Layer.effect(
  Gateway,
  Effect.gen(function*() {
    const calls = yield* Calls
    return Gateway.of({
      charge: () =>
        Ref.updateAndGet(calls, (n) => n + 1).pipe(
          Effect.flatMap((n) => n < 3 ? Effect.fail(new GatewayDown()) : Effect.succeed("receipt-1"))
        )
    })
  })
).pipe(Layer.provideMerge(Layer.effect(Calls, Ref.make(0))))

describe("checkout", () => {
  it.effect("retries outages with backoff", () =>
    Effect.gen(function*() {
      const calls = yield* Calls
      const fiber = yield* Effect.forkChild(checkout(500), { startImmediately: true })
      yield* TestClock.adjust("3 seconds") // 1s + 2s of backoff, in zero real time
      assert.strictEqual(yield* Fiber.join(fiber), "receipt-1")
      assert.strictEqual(yield* Ref.get(calls), 3)
    }).pipe(Effect.provide(flakyGateway)))
})
```

### Observing logs, console, randomness and cleanup

```ts import.meta.vitest name="references/testing/guide.md#3"
import assert from "node:assert/strict"
import { Console, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Random, Scope } from "effect"
import { TestConsole } from "effect/testing"

// Console: captured instead of printed. (TestConsole also receives Effect.log
// output formatted with a timestamp, so for log assertions prefer a Logger.)
const consoleTest = Effect.gen(function*() {
  yield* Console.log("hello")
  assert.deepEqual(yield* TestConsole.logLines, ["hello"])
}).pipe(Effect.provide(TestConsole.layer))

// Logs: install a capturing Logger for this effect only.
const captured: Array<unknown> = []
const capture = Logger.make<unknown, void>((options) => {
  captured.push(options.message)
})
const logTest = Effect.logInfo("charged", 500).pipe(Effect.provide(Logger.layer([capture])))

// Randomness: the same seed gives the same sequence.
const draw = (seed: string) => Random.nextInt.pipe(Random.withSeed(seed))

// Interruption + synchronisation without sleeping: Deferred is the handshake.
const interruptTest = Effect.gen(function*() {
  const started = yield* Deferred.make<void>()
  let released = false
  const fiber = yield* Effect.forkChild(
    Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => void (released = true)))
    )
  )
  yield* Deferred.await(started) // the fiber is definitely running now
  yield* Fiber.interrupt(fiber)
  assert.equal(released, true)
})

// Finalizers: build a layer in a scope you close, and assert on the release.
class Conn extends Context.Service<Conn, { readonly id: number }>()("app/Conn") {}
const events: Array<string> = []
const ConnLive = Layer.effect(
  Conn,
  Effect.acquireRelease(
    Effect.sync(() => (events.push("open"), Conn.of({ id: 1 }))),
    () => Effect.sync(() => void events.push("close"))
  )
)
const finalizerTest = Effect.gen(function*() {
  const scope = yield* Scope.make()
  yield* Layer.buildWithScope(ConnLive, scope)
  assert.deepEqual(events, ["open"])
  yield* Scope.close(scope, Exit.void)
  assert.deepEqual(events, ["open", "close"])
})

await Effect.runPromise(consoleTest)
await Effect.runPromise(logTest)
assert.deepEqual(captured, [["charged", 500]])
assert.equal(await Effect.runPromise(draw("a")), await Effect.runPromise(draw("a")))
await Effect.runPromise(interruptTest)
await Effect.runPromise(finalizerTest)
```

### Sharing a layer across a suite (`@effect/vitest`)

`layer(L)(name, (it) => ...)` builds `L` once for the block, tears it down in
`afterAll`, and every `it.effect` inside can `yield*` its services. State is
shared between those tests, which is fast and a trap: later tests see earlier
writes. Use it for expensive layers (a database container), and create fresh
state per test with `Effect.provide(layerTest)` inside the test otherwise.

Example: `layer(TodoRepo.layerTest)("TodoRepo", (it) => { it.effect(...) })`; see
[references/vitest-patterns.md](vitest-patterns.md).

Other helpers shown in the upstream examples: `it.live` (real clock and real
services, for integration tests), `it.effect.each([...])("name %#", (row) => ...)`
(parameterized), and `it.effect.prop("name", [Schema.String], ([value]) => ...)`
(property-based, with Schema-derived arbitraries).

## Test design rules

- **Fake the edge, not the logic.** Replace the gateway, database, clock,
  mailer. Never replace the thing under test or the Effect runtime.
- **Assert outcomes, not calls.** "The outbox contains the welcome mail" beats
  "send was called once with these args"; the first survives refactors.
- **One kind of ending per test.** Success, each typed failure, a defect,
  interruption: separate tests with names that say which.
- **Fork, then adjust.** Anything that sleeps must be started in a fiber
  (`Effect.forkChild`) before `TestClock.adjust`, otherwise the test blocks
  forever on a clock nobody advances. `adjust` runs everything scheduled up to
  the new time, in order.
- **Coordinate with `Deferred`, not delays.** To know a fiber reached a point,
  have it complete a `Deferred` there and `Deferred.await` it in the test.
- **Keep the fake honest.** The in-memory repo must reproduce the real one's
  typed errors (duplicate email -> `EmailTaken`), or tests pass for the wrong
  reason. Run the same contract tests against both when you can.
- **Per-test state by default.** Build the test layer inside the test; share a
  layer with `layer()` only for expensive resources.

## Anti-patterns

```ts skip
// 1. Real waiting.
it("retries", async () => { await Effect.runPromise(program) })   // takes 7 real seconds
```
Right: `TestClock` + `forkChild` + `TestClock.adjust("7 seconds")`. Consequence: slow, flaky suites that time out in CI.

```ts skip
// 2. Adjusting without a fork.
yield* TestClock.adjust("1 second")
yield* Effect.sleep("1 second")   // never wakes: the clock only moves when you move it
```
Right: `const f = yield* Effect.forkChild(Effect.sleep("1 second")); yield* TestClock.adjust("1 second"); yield* Fiber.join(f)`. Consequence: the test hangs.

```ts skip
// 3. Asserting only the happy value.
const result = await Effect.runPromise(checkout(500))
```
Right: add tests with `Effect.flip` / `Effect.exit` for each typed failure. Consequence: the error contract (the point of Effect) is untested; a regression turns a 402 into a 500 silently.

```ts skip
// 4. Mocking the runtime.
vi.spyOn(Effect, "runPromise").mockResolvedValue(...)
```
Right: provide a test `Layer` for the service at the boundary. Consequence: you test the mock; real behaviour (interruption, retries, tracing) is skipped.

```ts skip
// 5. Sleeping to let a fiber run.
const fiber = yield* Effect.forkChild(work); yield* Effect.sleep(10)
```
Right: `Deferred` handshake, or `startImmediately: true`. Consequence: races that pass locally and fail under load.

```ts skip
// 6. A global mutable test double shared by all tests.
const sent: Array<string> = []
const MailerTest = Layer.succeed(Mailer, Mailer.of({ send: (to) => Effect.sync(() => void sent.push(to)) }))
```
Right: create the state inside `Layer.effect` with a `Ref`, per test (see `scripted`). Consequence: test order changes results.

```ts skip
// 7. Ignoring cleanup and interruption.
// only asserting the return value of a scoped operation
```
Right: build in a scope you close, assert the finalizer ran (above). Consequence: leaked connections and fibers pass every test, then hang the process.

```ts skip
// 8. v3 test idioms.
Effect.runPromise(prog.pipe(Effect.provide(TestContext.TestContext)))   // remembered from v3
```
Right: `it.effect` (which supplies `TestClock`) or `Effect.provide(TestClock.layer())`. Consequence: `TestContext` does not exist; `effect/testing` exports only `TestClock`, `TestConsole` and `TestSchema`.

## Changed in 4.1

- `TestClock` now wakes sleeps in registration order (also for equal
  timestamps) and, after each woken sleep, waits for that fiber and anything it
  resumes or forks to suspend before waking the next one. Chains such as
  `Effect.retry` with a backoff `Schedule` run in order within a single
  `TestClock.adjust`.
- That guarantee holds for fibers running under `TestClock.layer()`, which is
  what `it.effect` installs. A clock built by hand with `TestClock.make` only
  waits one scheduler turn; prefer `layer`.
- If a woken fiber keeps running without suspending, the `TestClock` stops
  waiting for it and prints its "still running" warning after `warningDelay`.
  Use the same warning to find tests that wait for time they never advance.
- An interrupted sleep removes itself from the clock's queue, so a timed-out
  effect no longer leaves a stale sleeper behind.
- `TestSchema`'s `verifyRoundTrip` compares with the schema's own equivalence,
  so struct schemas now verify (4.0.0 reported "Property falsified" for them).
- `TestClock` built while another one is current uses the outer clock's live
  clock, so nested `TestClock.layer()`s do not wait on the outer virtual time.

## Testing it

Verify the harness before trusting it: write one test that *must fail* (change
an expectation, or remove `TestClock.adjust`) and confirm it fails or times
out. Then run `tsc --noEmit`: unexpected leftovers in `R` of a test effect mean
a service was not provided, which is the same error you would have hit at
runtime.

## Boundaries

- [services](../services/guide.md): how to design the services and layers you substitute;
  `Layer.mock`, `provideMerge`, scopes.
- [core](../core/guide.md): failure model (`Exit`, `Cause`, `flip`, `result`) used in assertions.
- [time](../time/guide.md): what the schedules you are testing mean; here we only drive them.
- [concurrency](../concurrency/guide.md): fibers, `Deferred`, `Latch`, queues used for coordination.
- [schema](../schema/guide.md): schema design; here `TestSchema` only asserts on it.
- [http-api](../http-api/guide.md), [sql](../sql/guide.md) and others: framework-specific test helpers
  (for example `HttpApiTest` in-memory clients) are covered there.

## References

- [references/api-cheatsheet.md](api-cheatsheet.md): verified signatures for TestClock, TestConsole, TestSchema, Logger/Random helpers
- [references/vitest-patterns.md](vitest-patterns.md): `@effect/vitest` usage taken from the upstream examples
- [TestClock API](https://effect.website/docs/v4/api/effect/testing/TestClock)
- [TestConsole API](https://effect.website/docs/v4/api/effect/testing/TestConsole)
- [TestSchema API](https://effect.website/docs/v4/api/effect/testing/TestSchema)
- [TestClock.ts at 4.1.2](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/testing/TestClock.ts)
- [TestSchema.ts at 4.1.2](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/testing/TestSchema.ts)
- Maintained examples ship with the package: `node_modules/effect/ai-docs/src/09_testing/`
