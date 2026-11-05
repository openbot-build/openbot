# Effect core: effects, failures, and running them

## How to think about it

A Promise is a *running* computation: by the time you hold it, the work has
started, it can only fail with `unknown`, and nobody downstream can stop it.
An `Effect<A, E, R>` is the opposite: an inert *description* of work that
succeeds with `A`, can fail with an expected error `E`, and needs services `R`.
Building it does nothing. Because it is a value, the same description can be
retried, timed out, raced, traced, provided different dependencies or
interrupted by code that never looks inside it. Every rule below protects that
property.

An Effect run can end three ways, and Effect keeps them apart on purpose:

| Ending | Meaning | Lives in | You handle it by |
| --- | --- | --- | --- |
| **Failure** | An *expected* problem the caller can act on (not found, rate limited, invalid) | `E`, as tagged data | `catchTag`, `catchTags`, `catch`, `result` |
| **Defect** | A bug or fault nobody will branch on (a `throw`, `die`, `orDie`) | not in `E` | almost never; report at the edge |
| **Interrupt** | Someone cancelled the fiber (timeout, race loser, scope closed) | not in `E` | never swallow; use finalizers (`ensuring`, `onInterrupt`, `acquireRelease`) |

`Cause<E>` is the full record of how a run went wrong (a list of those three
kinds, possibly several at once), and `Exit<A, E>` is `Success<A>` or
`Failure<Cause<E>>`. Most code never touches them: you just type `E` honestly
and recover where you can. You read `Exit`/`Cause` only at the edge of the
process, where you must decide an HTTP status or exit code.

People coming from `async/await` get four things wrong: they expect `catch`
to catch everything (here it catches only typed failures, by design); they
type errors as `Error` or `unknown` (which tells callers nothing); they call
`runPromise` wherever they need a value (which throws away interruption,
tracing and the services in scope); and they write the effect eagerly
(`Effect.succeed(fetchThing())` runs `fetchThing` at construction time).

## Choose

| Situation | Use | Why |
| --- | --- | --- |
| Value already in hand | `Effect.succeed(v)` | no work to defer |
| Cheap sync side effect that cannot throw (`Date.now`, counter) | `Effect.sync(() => ...)` | deferred until run; a throw becomes a defect |
| Sync code that may throw (`JSON.parse`) | `Effect.try({ try, catch })` | maps the throw into a typed `E` |
| Promise API that may reject | `Effect.tryPromise({ try: (signal) => ..., catch })` | typed `E`; `signal` aborts on interruption |
| Promise that "cannot" reject | `Effect.promise(() => ...)` | a rejection is a defect, not `E` |
| Callback or event API | `Effect.callback((resume, signal) => ...)` | return an `Effect` finalizer so interruption cleans up |
| Nullable value | `Effect.fromNullishOr(v)` then `mapError` | fails with `NoSuchElementError` until you give it a domain error |
| Build the effect from state at run time | `Effect.suspend(() => ...)` | defers the *construction*, not just the work |
| Sequential steps | `Effect.gen` / `Effect.fn("name")` | straight-line code, one trace span per call |
| Expected failure | `return yield* new NotFound({ id })` or `Effect.fail(e)` | goes into `E`; compiler tracks it |
| Unrecoverable at this level | `Effect.die(x)` / `Effect.orDie` | removes it from `E` on purpose |
| Recover from one error | `Effect.catchTag("Tag", f)` | untouched errors stay in `E`; new errors are never swallowed |
| Recover from several | `Effect.catchTags({ A: f, B: g })` | one place, exhaustive by construction |
| Recover from a nested reason | `Effect.catchReason`, `Effect.unwrapReason` | for errors with a tagged `reason` field |
| Recover from everything typed | `Effect.catch(f)` | only at a deliberate boundary; not defects |
| Branch on the outcome as data | `Effect.result` (`Result`), `Effect.exit` (`Exit`) | `result` keeps typed errors; `exit` also keeps defects/interrupts |
| Run a list | `Effect.forEach(xs, f, { concurrency: n })` | sequential unless you set concurrency; stops at first failure |
| Run a list, keep every outcome | `Effect.partition`, `Effect.all(xs, { mode: "result" })` | collects failures instead of short-circuiting |
| Retry transient failures | `Effect.retry({ times, while })` or a `Schedule` | defects and interruption are never retried |
| Bound latency | `Effect.timeout(d)` | interrupts the work, adds `TimeoutError` to `E` |
| Process entrypoint | `NodeRuntime.runMain(program)` | signals, exit code, error reporting |
| Framework you do not control | `ManagedRuntime.make(layer)` | one runtime, `runPromise` per request, `dispose` at shutdown |

When *not* to reach for Effect: a pure function with no failure and no I/O is
just a function. Do not wrap `x + 1` in `Effect.succeed`. Retry/time policies
live in [time](../time/guide.md); resources and dependencies in [services](../services/guide.md).

## Recipe

### The pitfall: looks fine, tells the caller nothing

```ts skip
// Eager, untyped, uncancellable, retries by hand.
async function loadInvoice(id: string): Promise<Invoice> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await gateway.get(id)          // can reject with anything
      if (res === null) throw new Error("not found") // same channel as outages
      return res
    } catch (e) {
      if (attempt === 2) throw e                 // retried "not found" too
    }
  }
  throw new Error("unreachable")
}
```

The signature promises `Invoice`, yet it can throw anything; "not found" and
"gateway down" are indistinguishable; it retries things that cannot succeed;
there is no timeout and no way to cancel it.

### The idiomatic version

```ts import.meta.vitest name="references/core/guide.md#2"
import { Effect, Schema } from "effect"

// Two *different* expected failures, because callers react differently:
// NotFound -> 404, GatewayUnavailable -> retry then 503.
export class InvoiceNotFound extends Schema.TaggedError<InvoiceNotFound>()("InvoiceNotFound", {
  id: Schema.String
}) {}

export class GatewayUnavailable extends Schema.TaggedError<GatewayUnavailable>()("GatewayUnavailable", {
  // Schema.Defect() holds an arbitrary thrown value (the original rejection).
  cause: Schema.Defect()
}) {}

export interface Invoice {
  readonly id: string
  readonly cents: number
}

// A local stand-in for an SDK: a Map-backed "remote" that rejects twice for
// "flaky" before answering. In real code this sits behind a service.
const remote = new Map<string, Invoice>([
  ["inv-1", { id: "inv-1", cents: 1200 }],
  ["inv-2", { id: "inv-2", cents: 1800 }],
  ["flaky", { id: "flaky", cents: 50 }]
])
let flakyFailures = 2
const gatewayGet = async (id: string, _signal: AbortSignal): Promise<Invoice | null> => {
  if (id === "flaky" && flakyFailures-- > 0) throw new Error("ECONNRESET")
  return remote.get(id) ?? null
}

// Effect.fn("name")(generator, ...pipeable steps):
// - gives a tracing span and a useful stack frame per call
// - the extra arguments (retry, timeout) wrap the whole body; never use .pipe here
export const loadInvoice = Effect.fn("loadInvoice")(
  function*(id: string) {
    // tryPromise: a rejection becomes *typed* data. `signal` aborts the request
    // if this fiber is interrupted (for example by the timeout below).
    const found = yield* Effect.tryPromise({
      try: (signal) => gatewayGet(id, signal),
      catch: (cause) => new GatewayUnavailable({ cause })
    })
    if (found === null) {
      // Always `return yield*` a failure so TypeScript knows control stops here.
      return yield* new InvoiceNotFound({ id })
    }
    return found
  },
  // Retry only the transient failure. `times: 3` = 1 attempt + 3 retries.
  // InvoiceNotFound is not retried: running it again cannot change the answer.
  Effect.retry({ times: 3, while: (e) => e._tag === "GatewayUnavailable" }),
  // Interrupts the work when exceeded and adds TimeoutError to E.
  Effect.timeout("5 seconds")
)
// Inferred, not annotated:
// (id: string) => Effect<Invoice, GatewayUnavailable | InvoiceNotFound | TimeoutError>

// Bounded concurrency: never an unbounded Promise.all. If one load fails the
// others are interrupted.
export const totalCents = Effect.fn("totalCents")(function*(ids: ReadonlyArray<string>) {
  const invoices = yield* Effect.forEach(ids, loadInvoice, { concurrency: 4 })
  return invoices.reduce((sum, invoice) => sum + invoice.cents, 0)
})

// Decide what each failure means *at the place that knows*. Handled tags leave E.
export const totalOrZero = (ids: ReadonlyArray<string>) =>
  totalCents(ids).pipe(
    Effect.catchTag("InvoiceNotFound", (e) =>
      Effect.logWarning("invoice missing", e.id).pipe(Effect.as(0))
    )
    // GatewayUnavailable | TimeoutError are still in E for the caller to decide.
  )

// Run it. (Doctest style: `// =>` asserts the awaited value.)
await Effect.runPromise(loadInvoice("inv-1")) // => { id: "inv-1", cents: 1200 }
// "flaky" rejects twice; retry absorbs both.
await Effect.runPromise(loadInvoice("flaky")) // => { id: "flaky", cents: 50 }
await Effect.runPromise(totalCents(["inv-1", "inv-2"])) // => 3000
await Effect.runPromise(totalOrZero(["inv-1", "nope"])) // => 0
const notFound = await Effect.runPromise(Effect.flip(loadInvoice("nope")))
notFound._tag // => "InvoiceNotFound"
```

### The edge: run once, and translate the outcome

Domain code returns Effects. Only the entry point runs them, and only there do
you look at `Exit` and `Cause` to pick a status.

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"

class NotFound {
  readonly _tag = "NotFound"
}
class Unavailable {
  readonly _tag = "Unavailable"
}

// A tiny router: /health works, /down is an outage, anything else is a 404.
const handler = (path: string): Effect.Effect<string, NotFound | Unavailable> =>
  path === "/health" ? Effect.succeed("ok")
    : path === "/down" ? Effect.fail(new Unavailable())
    : Effect.fail(new NotFound())

// A process: runMain installs SIGINT/SIGTERM handling, interrupts the fiber
// for graceful shutdown, reports an unhandled Cause and sets the exit code.
// It requires R = never (every service already provided); E may remain.
NodeRuntime.runMain(
  handler("/health").pipe(
    Effect.flatMap((body) => Effect.log(body)),
    Effect.catchTag("NotFound", () => Effect.logWarning("no such route"))
    // Unavailable is not handled: runMain reports it and exits non-zero.
  )
)
```

A framework you do not control (an Express/Next handler, a test harness): keep
one runtime for the whole process and run Effects through it per request.
Layers are built once, lazily, and released by `dispose()`.

```ts import.meta.vitest name="references/core/guide.md#4"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option } from "effect"

class NotFound {
  readonly _tag = "NotFound"
}
class Unavailable {
  readonly _tag = "Unavailable"
}

const handler = (path: string): Effect.Effect<string, NotFound | Unavailable> =>
  path === "/health" ? Effect.succeed("ok")
    : path === "/down" ? Effect.fail(new Unavailable())
    : path === "/bug" ? Effect.die(new Error("invariant broken"))
    : Effect.fail(new NotFound())

const runtime = ManagedRuntime.make(Layer.empty)

export const respond = async (path: string): Promise<{ status: number; body: string }> => {
  // runPromiseExit never rejects: the outcome is data.
  const exit = await runtime.runPromiseExit(handler(path))
  return Exit.match(exit, {
    onSuccess: (body) => ({ status: 200, body }),
    onFailure: (cause) => {
      // Typed failures first: these are the ones we designed.
      const failure = Cause.findErrorOption(cause)
      if (Option.isSome(failure)) {
        return failure.value._tag === "NotFound"
          ? { status: 404, body: "not found" }
          : { status: 503, body: "try later" }
      }
      // Client went away / we shut down: not an error to report.
      if (Cause.hasInterruptsOnly(cause)) return { status: 499, body: "" }
      // Anything else is a defect: a bug. Hide details from the client and
      // log the structured Cause (Cause.pretty(cause)) on the server.
      return { status: 500, body: "internal error" }
    }
  })
}

await respond("/health") // => { status: 200, body: "ok" }
await respond("/nope") // => { status: 404, body: "not found" }
await respond("/down") // => { status: 503, body: "try later" }
await respond("/bug") // => { status: 500, body: "internal error" }

await runtime.dispose()
```

## Design rules that follow from the model

1. **`E` is a union of tagged classes**, one per thing a caller might do
   differently. Define them with `Schema.TaggedError<Self>()(tag, fields)`
   (serializable, usable in HTTP/RPC schemas) or `Data.TaggedError(tag)<fields>`
   (plain, no schema). Never `Error`, `string` or `unknown`.
2. **Convert at the seam, once.** Foreign code (`tryPromise`, `try`) maps its
   rejection into your error class in the `catch` option. Do not let raw
   `UnknownError` leak up through three layers.
3. **Wrap causes you keep.** Put the original value in a `cause: Schema.Defect()`
   field so logs keep the stack while callers still branch on `_tag`.
4. **Decide defect-ness where you know nobody can recover.** A low-level
   module reports `DbError` honestly in `E`; the layer that knows no caller
   can do anything useful (a use case with no fallback, a service constructor)
   applies `Effect.orDie`. Doing it at the first line that can throw hides
   failures other callers might have handled.
5. **`catchTag` is the default recovery.** It names what you handle and leaves
   everything else visible. Use `Effect.catch` only to translate or to log and
   fall back at a deliberate boundary.
6. **Add behaviour with combinators, not control flow**: `Effect.retry`,
   `Effect.timeout`, `Effect.withSpan`, `Effect.annotateLogs`; these compose
   because the effect is a value.

## Anti-patterns

```ts skip
// 1. Eager work in the constructor.
const bad = Effect.succeed(fetch(url))          // fetch already started
```
Right: `Effect.tryPromise({ try: (signal) => fetch(url, { signal }), catch: ... })`.
Consequence: the "effect" can't be retried or cancelled; it already ran once.

```ts skip
// 2. Untyped failure channel.
Effect.tryPromise(() => db.query(sql))          // E = UnknownError
```
Right: `Effect.tryPromise({ try: ..., catch: (cause) => new DbError({ cause }) })`.
Consequence: callers cannot `catchTag`; everything looks the same.

```ts skip
// 3. Throwing for expected cases.
Effect.gen(function*() { if (!user) throw new Error("no user") })
```
Right: `if (!user) return yield* new UserNotFound({ id })`.
Consequence: the throw becomes a *defect*, invisible in `E`, unhandleable by `catchTag`, and reported as a bug.

```ts skip
// 4. Catch-all that eats errors added to E later.
program.pipe(Effect.catch(() => Effect.succeed(null)))
```
Right: `Effect.catchTag("NotFound", () => Effect.succeed(null))`.
Consequence: a `PermissionDenied` added to `E` next month is silently turned into `null`.

```ts skip
// 5. Running in the middle of domain code.
const user = await Effect.runPromise(loadUser(id))   // inside another Effect
```
Right: `const user = yield* loadUser(id)`.
Consequence: you lose interruption, the span context and the services in scope, and you reintroduce untyped rejections.

```ts skip
// 6. Retrying everything / unbounded concurrency.
Effect.forEach(ids, load, { concurrency: "unbounded" }).pipe(Effect.retry({ times: 10 }))
```
Right: `{ concurrency: 4 }` and `Effect.retry({ times: 3, while: (e) => e._tag === "GatewayUnavailable" })`.
Consequence: a 404 is hammered ten times; ten thousand ids open ten thousand sockets.

```ts skip
// 7. Swallowing the Cause "to keep the app alive".
program.pipe(Effect.catchCause(() => Effect.void))
```
Right: handle specific tags; let defects and interrupts reach the edge, where `runMain`/`runPromiseExit` reports them.
Consequence: every defect (a bug, a failed invariant) is silently turned into success, so nobody ever learns about it.

```ts skip
// 8. v3 names.
Effect.catchAll(f); Effect.either(e); Effect.fork(e); Effect.async(cb)
```
Right: `Effect.catch`, `Effect.result`, `Effect.forkChild`, `Effect.callback`. Consequence: they do not exist in 4.x; see `references/v3-to-v4.md`.

## Testing it

Core semantics are testable with plain `Effect.runPromiseExit` and `node:assert`
(no framework needed). Assert the *kind* of ending, not just the value.
`Effect.flip` swaps success and failure so a typed error is easy to assert on.

```ts import.meta.vitest name="references/core/guide.md#12"
import assert from "node:assert/strict"
import { Cause, Effect, Exit, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }) {}

const find = (id: string) =>
  id === "a" ? Effect.succeed({ id }) : Effect.fail(new NotFound({ id }))

// Success
assert.deepEqual(await Effect.runPromise(find("a")), { id: "a" })

// Typed failure: flip puts the error in the success channel
const error = await Effect.runPromise(Effect.flip(find("zzz")))
assert.equal(error._tag, "NotFound")
assert.equal(error.id, "zzz")

// Defect vs failure: orDie moves it out of E, and the Exit proves it
const exit = await Effect.runPromiseExit(find("zzz").pipe(Effect.orDie))
assert.ok(Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause))

// Interruption: a timed-out run was interrupted and its finalizer ran
let released = false
const timedOut = await Effect.runPromiseExit(
  Effect.never.pipe(
    Effect.onInterrupt(() => Effect.sync(() => { released = true })),
    Effect.timeout("10 millis")
  )
)
assert.ok(Exit.isFailure(timedOut))
assert.equal(released, true)
```

The same checks as `it.effect` tests with `@effect/vitest` (`it.effect` runs
the returned Effect with a `TestClock` in place; use `Effect.exit` rather than
`runPromiseExit`, and `TestClock` rather than real timers for anything
involving time; see [testing](../testing/guide.md)). These are typechecked here
and live in `*.test.ts` files in a real project:

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }) {}

const find = (id: string) =>
  id === "a" ? Effect.succeed({ id }) : Effect.fail(new NotFound({ id }))

it.effect("fails with NotFound", () =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(find("zzz"))
    assert.isTrue(Exit.isFailure(exit))
  }))
```

## Changed in 4.1

- `Exit.hasFails`, `Exit.hasDies` and `Exit.hasInterrupts` now return plain
  `boolean` instead of narrowing to `Failure`. Narrow with `Exit.isFailure(exit)`
  first, then read `exit.cause` (as the test above does).
- `Effect.cachedWithTTL` and `Effect.cachedInvalidateWithTTL` accept a function
  `(exit) => Duration.Input` as the TTL, so successes and failures can be cached
  for different lengths (for example `Exit.isSuccess(exit) ? "1 hour" : 0`).
- `Effect.ignore` and `Effect.ignoreCause` accept `log: "Unhandled"`, which logs
  at the level of `References.UnhandledLogLevel` (`undefined` disables it).
- `Effect.catchIf` types its refinement against `NoInfer<E>`: the refinement is
  checked against the error type you already have instead of steering inference.
- `ManagedRuntime.dispose()` is coalesced: repeated or concurrent calls wait for
  the first one, and calling it from a fiber the runtime itself owns does not
  deadlock.
- `TestClock` wakes sleeps in registration order and waits for each woken fiber
  to suspend (see [testing](../testing/guide.md)).

## Boundaries

- [services](../services/guide.md): anything with dependencies or a lifecycle. Tag/Layer
  construction, `Layer.provide`, scopes and `acquireRelease` live there; here
  you only choose where the run boundary sits and when `R` must be `never`.
- [schema](../schema/guide.md): decoding untrusted input and defining serializable errors
  (`Schema.TaggedError`, `Schema.Defect`) in depth. Failed decodes arrive in
  `E` as `SchemaError`.
- [time](../time/guide.md): `Schedule` policies, jitter, backoff, polling. Here you only
  use `retry({ times, while })`.
- [concurrency](../concurrency/guide.md): forking, fibers, queues, semaphores, racing. Here you
  only use `forEach`'s `concurrency` option and `timeout`.
- [testing](../testing/guide.md): `@effect/vitest`, `TestClock`, test layers.

## References

- [references/api-cheatsheet.md](api-cheatsheet.md): verified signatures by task
- [references/failure-model.md](failure-model.md): Cause, Exit, defects, interruption in depth
- [references/v3-to-v4.md](v3-to-v4.md): renamed or removed Effect APIs
- [Effect API](https://effect.website/docs/v4/api/effect/Effect)
- [Cause API](https://effect.website/docs/v4/api/effect/Cause)
- [Exit API](https://effect.website/docs/v4/api/effect/Exit)
- [ManagedRuntime API](https://effect.website/docs/v4/api/effect/ManagedRuntime)
- [Effect.ts at 4.1.2](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Effect.ts)
- [Cause.ts at 4.1.2](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Cause.ts)
- Maintained examples ship with the package: `node_modules/effect/ai-docs/src/01_effect/04_errors/`
