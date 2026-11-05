# Failure model in depth: Cause, Exit, defects, interruption

Read this when you must *classify* how a run ended (edge of the process,
logging, metrics, retry predicates) or when you are tempted to catch
"everything".

## The three kinds, concretely

A `Cause<E>` has a `reasons` array. Each reason is exactly one of:

| `_tag` | Field | Produced by |
| --- | --- | --- |
| `"Fail"` | `error: E` | `Effect.fail`, `yield* new MyError()`, the `catch` of `tryPromise`/`try` |
| `"Die"` | `defect: unknown` | `Effect.die`, `Effect.orDie`, a `throw` inside `sync`/`map`/`flatMap`, a rejected `Effect.promise` |
| `"Interrupt"` | `fiberId` | `Effect.interrupt`, `Fiber.interrupt`, a `timeout` or `race` loser, a closed `Scope` |

There can be several reasons at once (two parallel branches failing, a failure
plus a finalizer that also failed). That is why `Cause` is a list, and why
`Cause.squash` (pick one `unknown` to show) is lossy.

Typed handlers (`catch`, `catchTag`, `retry`, `result`, `mapError`) only see
`Fail` reasons. Defects and interrupts pass straight through them. This is the
reason `catch(() => ...)` is *not* the same as `try/catch`.

## Classifying a Cause

```ts import.meta.vitest name="references/core/failure-model.md#1"
import { Cause, Effect, Exit, Option, Schema } from "effect"

class PaymentDeclined extends Schema.TaggedError<PaymentDeclined>()("PaymentDeclined", {
  reason: Schema.String
}) {}

export type Outcome =
  | { readonly kind: "ok" }
  | { readonly kind: "declined"; readonly reason: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "bug"; readonly report: string }

// Order matters: look for the designed failure first, then cancellation,
// and treat what is left as a defect to report.
export const classify = (exit: Exit.Exit<unknown, PaymentDeclined>): Outcome => {
  if (Exit.isSuccess(exit)) return { kind: "ok" }
  const { cause } = exit
  const failure = Cause.findErrorOption(cause) // first Fail reason, as Option<E>
  if (Option.isSome(failure)) return { kind: "declined", reason: failure.value.reason }
  if (Cause.hasInterruptsOnly(cause)) return { kind: "cancelled" }
  return { kind: "bug", report: Cause.pretty(cause) } // structured, stack-bearing text
}

// The exit comes from running the effect and *observing* its outcome:
export const run = (charge: Effect.Effect<void, PaymentDeclined>) =>
  Effect.runPromiseExit(charge).then(classify)

await run(Effect.void) // => { kind: "ok" }
await run(Effect.fail(new PaymentDeclined({ reason: "insufficient funds" }))) // => { kind: "declined", reason: "insufficient funds" }
await run(Effect.interrupt) // => { kind: "cancelled" }
// A defect is a bug: `report` holds the stack-bearing text.
const bug = await run(Effect.die(new Error("invariant broken")))
bug.kind // => "bug"
```

Predicates available on a `Cause`: `hasFails`, `hasDies`, `hasInterrupts`,
`hasInterruptsOnly`. Extractors: `findError` / `findErrorOption`,
`findDefect`, `squash`. Rendering: `Cause.pretty(cause)` (string with stacks),
`Cause.prettyErrors(cause)` (array of `Error`).

## Observing an outcome inside an Effect

Inside a program you rarely want the whole `Exit`. Pick the narrowest tool:

| You want | Use | Sees defects/interrupts? |
| --- | --- | --- |
| Branch on typed failure as a value | `Effect.result` -> `Result<A, E>` | no, they still propagate |
| Typed failure dropped to `Option` | `Effect.option` | no |
| Everything, as data | `Effect.exit` -> `Exit<A, E>` | yes |
| Run cleanup knowing how it ended | `Effect.onExit((exit) => ...)` | yes (and the effect still ends the same way) |
| Cleanup only on cancellation | `Effect.onInterrupt(() => ...)` | interruption only |
| Cleanup always | `Effect.ensuring(finalizer)` | all |
| Log failures, keep going | `Effect.tapError`, `Effect.tapCause` | `tapCause` sees all; error is not changed |
| Recover from bugs (plugins, request isolation) | `Effect.catchDefect` | defects only |

```ts import.meta.vitest name="references/core/failure-model.md#2"
import { Effect, Exit, Result, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }) {}

const lookup = (id: string): Effect.Effect<string, NotFound> =>
  id === "1" ? Effect.succeed("Ada") : Effect.fail(new NotFound({ id }))

export const program = Effect.gen(function*() {
  // result: typed failures become values, so you can fan out and keep going.
  const results = yield* Effect.forEach(["1", "2"], (id) => Effect.result(lookup(id)))
  const names = results.flatMap((r) => (Result.isSuccess(r) ? [r.success] : []))

  // exit: also observes defects and interruption. Use sparingly.
  const exit = yield* Effect.exit(lookup("3").pipe(Effect.orDie))

  // onExit: a finalizer that knows how the run ended, without changing it.
  yield* lookup("1").pipe(
    Effect.onExit((e) => Effect.logInfo(Exit.isSuccess(e) ? "released after success" : "released after failure"))
  )
  return { names, exit: Exit.isFailure(exit) }
})

await Effect.runPromise(program) // => { names: ["Ada"], exit: true }
```

## Interruption rules

- Interruption is *cooperative and structured*: interrupting a fiber
  interrupts its children, runs its finalizers, and only then completes.
  `Effect.timeout`, `Effect.race`, `forEach` with a failing sibling, and
  closing a `Scope` all use it.
- It is not an error. Never convert it to a domain value and never retry it.
  `Effect.retry` does not retry interrupts or defects.
- A `Promise` you started is *not* stopped by interruption unless you pass the
  `AbortSignal` that `tryPromise`/`promise`/`callback` give you into the API.
- Code that must finish once started (commit, release) goes in an
  `Effect.uninterruptible` region or, better, in a finalizer
  (`Effect.acquireRelease`, `Effect.ensuring`), which Effect already protects.

```ts import.meta.vitest name="references/core/failure-model.md#3"
import { Effect, Exit } from "effect"

let closed = false

const withConnection = Effect.acquireUseRelease(
  Effect.succeed({ id: 1 }),                              // acquire
  () => Effect.never,                                     // use: runs until interrupted
  () => Effect.sync(() => { closed = true })              // release: always runs
)

export const demo = Effect.gen(function*() {
  const exit = yield* Effect.exit(withConnection.pipe(Effect.timeout("10 millis")))
  return { timedOut: Exit.isFailure(exit), closed }
})

await Effect.runPromise(demo) // => { timedOut: true, closed: true }
```

## Defects: when `die`/`orDie` is correct

Use `Effect.orDie` / `Effect.die` when the caller *cannot* do anything useful:
violated invariants, missing config discovered at startup, an impossible
branch, a dependency whose failure your whole use case cannot survive.
Do not use it to skip designing errors: once an error is a defect, `catchTag`
can no longer see it, a retry policy will not retry it, and an HTTP layer will
render it as a 500.

## Exit as a return value

`Exit.match(exit, { onSuccess, onFailure })` is exhaustive. Other helpers:
`Exit.isSuccess`, `Exit.isFailure`, `Exit.getSuccess`, `Exit.getCause`,
`Exit.findErrorOption`, `Exit.findDefect`, `Exit.hasFails/hasDies/hasInterrupts`
(plain booleans; narrow with `Exit.isFailure` first),
`Exit.succeed/fail/die/interrupt` constructors (useful in test doubles).
