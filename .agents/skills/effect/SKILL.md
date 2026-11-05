---
name: effect
compatibility: "Targets effect@4.1.x (npm latest); Effect v3 code needs migration."
description: "Start here whenever you write, review, or refactor TypeScript that uses or should use Effect: how to think in Effect<A, E, R>, design errors, services and layers, translate async/await and try/catch, and verify the result. Routes to per-module guides (services, schema, http-api, sql, streams, testing, ai, …) under references/."
---

# Writing Effect code

Effect is not a bag of helpers around Promise. It is a way of making three
things that ordinary TypeScript hides — **how a computation can fail**, **what
it needs to run**, and **what it must clean up** — visible in the type and
checked by the compiler. Good Effect code is code where you can read those
three facts off a signature and trust them.

Read this file first. Then open the guide for each module you touch (table at
the end). All depth lives in `references/`.

## The model in one paragraph

`Effect<A, E, R>` is an inert *description* of a program that, when run, either
succeeds with `A`, fails with an expected error `E`, or needs services `R`
first. Building one does nothing. Only a *run* function at the edge of the
process starts it. Because it is a value, you can retry it, time it out, race
it, trace it, provide different dependencies, or interrupt it — without
changing the code inside. That is the entire payoff; every rule below protects
it.

## Work type-first

Write the types before the bodies. For any new feature, in this order: the
`Schema`s for its data and states → one tagged error per outcome a caller will
branch on → the `Context.Service` contract with full method signatures → the
signature of each use case (`Effect.fn.Return<A, E, R>`) → only then the bodies.
Then read every compiler error as a design question — a missing `R` is an
unwired layer, an unexpected `E` is a failure you have not decided about — and
never answer it with `as`, `any`, or `E = unknown`. Make illegal states
unrepresentable (tagged unions plus transition functions), brand primitive ids,
and derive TypeScript types from schemas so the validator and the type cannot
drift. The full method, techniques, an end-to-end runnable example, and a
"compiler message → what it means" table are in
[references/type-first.md](references/type-first.md). Read it before designing
anything non-trivial.

## Six design rules

1. **Type the failures that callers can act on; let the rest die.** `E` holds
   *expected* failures (not found, validation, rate limit) as tagged data.
   Bugs and infrastructure faults nobody will branch on are defects:
   `Effect.orDie` / `Effect.die`. A signature with `E = unknown` or
   `E = Error` has told the caller nothing.
2. **Decode at the boundary, once.** Everything that crosses into your program
   (HTTP bodies, env, files, DB rows, LLM output) is `unknown` until a `Schema`
   decodes it. Inside, pass domain types, never re-validate.
3. **Dependencies are services, not imports.** Name a capability
   (`Context.Service`), depend on it with `yield*`, and let `R` accumulate.
   Never import a concrete client in domain code or pass it as a parameter
   through five layers.
4. **Assemble once, at the composition root.** `Layer`s build services (and own
   their resources) and are provided in one place. Domain code never calls
   `Effect.provide`; tests swap layers.
5. **Resources have an owner.** Anything that must be closed
   (`Effect.acquireRelease`, pools, servers, fibers) lives in a `Scope` owned
   by a Layer or an explicit `Effect.scoped`. No `try/finally`, no "remember to
   close".
6. **Run exactly once, at the edge.** `NodeRuntime.runMain` (or `Layer.launch`)
   for processes; a `ManagedRuntime` for frameworks you do not control. A
   `runPromise` in the middle of domain code defeats rules 1–5.

## Before you write a function: six questions

Answer these in order; the code mostly falls out.

| Question | Decides |
| --- | --- |
| What are the states and values, as types? Which combinations must be impossible? | tagged unions, brands, `Schema` (type-first) |
| What input is untrusted, and what is its decoded type? | `Schema` at the entry |
| Which failures will a caller *branch on*? | tagged errors in `E`; everything else `orDie` |
| What outside capability does it need (db, clock, http, config)? | a `Context.Service` in `R` |
| Does anything it creates need releasing, or run in the background? | `acquireRelease` / `forkScoped` inside a Layer |
| How will a test run it without the network or real time? | test `Layer`, `TestClock` |

## A complete shape

This is the skeleton every Effect application grows from: schema at the edge,
tagged domain error, a service with a swappable layer, an `Effect.fn` use case,
and a single provide at the root.

```ts import.meta.vitest name="entry skill skeleton"
import { Context, Effect, Layer, Ref, Schema } from "effect"

// 1. Boundary: untrusted input becomes a typed value exactly once.
export const SignupInput = Schema.Struct({
  email: Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/)),
  name: Schema.NonEmptyString
})
export type SignupInput = typeof SignupInput.Type

// 2. Expected failures are tagged data the caller can branch on.
export class EmailTaken extends Schema.TaggedError<EmailTaken>()("EmailTaken", {
  email: Schema.String
}) {}

// 3. A capability, not an implementation. Layers come with the service.
export class Accounts extends Context.Service<Accounts, {
  insert(input: SignupInput): Effect.Effect<{ readonly id: number }, EmailTaken>
}>()("app/Accounts") {
  static readonly layerMemory = Layer.effect(
    Accounts,
    Effect.gen(function*() {
      const rows = yield* Ref.make<ReadonlyArray<SignupInput>>([])
      return Accounts.of({
        insert: Effect.fn("Accounts.insert")(function*(input) {
          const all = yield* Ref.get(rows)
          if (all.some((row) => row.email === input.email)) {
            return yield* new EmailTaken({ email: input.email })
          }
          yield* Ref.set(rows, [...all, input])
          return { id: all.length + 1 }
        })
      })
    })
  )
}

// 4. Use case: straight-line code; E and R are inferred, not annotated.
//    Type: (raw: unknown) => Effect<number | string, SchemaError, Accounts>
export const signup = Effect.fn("signup")(function*(raw: unknown) {
  const input = yield* Schema.decodeUnknownEffect(SignupInput)(raw)
  const accounts = yield* Accounts
  const { id } = yield* accounts.insert(input)
  yield* Effect.logInfo("account created", id)
  return id
}, Effect.catchTag("EmailTaken", (e) => Effect.succeed(`taken:${e.email}`)))

// 5. Composition root: provide once, run once.
export const main = signup({ email: "a@b.c", name: "Ada" }).pipe(
  Effect.provide(Accounts.layerMemory)
)
await Effect.runPromise(main) // => 1
```

Read the types as documentation: `signup` still *requires* `Accounts` and can
still fail with `SchemaError` (bad input) — the compiler will not let you run it
until a layer is provided, and `EmailTaken` is gone from `E` because you
handled it. See [references/worked-example.md](references/worked-example.md)
for how this grows into a real service step by step.

## Translate habits, do not transliterate them

| You would write | Write instead | Why |
| --- | --- | --- |
| `async function f() { await ... }` | `Effect.fn("f")(function*() { yield* ... })` | lazy, traced, interruptible, typed |
| `try { } catch (e) { }` | `Effect.catchTag("X", ...)` / `Effect.exit` | catches only what you named, keeps the rest typed |
| `throw new Error("not found")` | `return yield* new NotFound({ id })` | error becomes part of the signature |
| `new Promise(resolve => ...)` | `Effect.callback` (returns a finalizer) | cancellation cleans up the source |
| `await fetch(...)` in a use case | a service wrapping `HttpClient` | testable, retriable, traceable |
| `process.env.X!` | `Config.String("X")` in a Layer | missing config is a typed startup error |
| `JSON.parse(x) as T` | `Schema.decodeUnknownEffect(T)(x)` | a cast proves nothing |
| `setTimeout`/`Date.now()` | `Effect.sleep`, `Clock` | `TestClock` can drive it |
| `Promise.all(xs.map(f))` | `Effect.forEach(xs, f, { concurrency: 8 })` | bounded, interrupts siblings on failure |
| `let x = 0; x++` shared across tasks | `Ref` / `SynchronizedRef` | atomic updates |
| module-level `const db = connect()` | `Layer` with `acquireRelease` | lifecycle, ordering, test doubles |
| `class Foo { constructor(private db: Db) }` wiring by hand | `Context.Service` + `Layer.effect` | R tracks it, no manual plumbing |
| `if (x == null) throw` | `Option` for "may be absent", typed error for "must exist" | absence is a value |

More before/after pairs, including bad-first versions and why each
"improvement" matters, are in
[references/from-async-await.md](references/from-async-await.md).

## Mistakes that look fine and are not

- **`Effect.gen` wrapped in a function by hand** (`const f = (x) => Effect.gen(...)`).
  Use `Effect.fn("f")(function*(x) {...})`; you get a span and a stack frame
  per call. For hot library code use `Effect.fnUntraced`.
- **Forgetting `return` before `yield* new MyError()`**. Without it TypeScript
  thinks the function continues; always `return yield*` a failure.
- **`Effect.catch(() => ...)` swallowing everything** when you meant one error.
  Prefer `catchTag` — a new error added to `E` later must not be silently
  eaten.
- **`Effect.runPromise` inside a service method** or a `.then` chain: you have
  left Effect, and lost interruption, tracing context, and the layer you were
  given. Return the Effect.
- **Providing a layer per call** (`Effect.provide(Db.layer)` inside a
  function): a fresh pool per request. Provide at the root.
- **`Effect.orDie` too early.** Do it where you *decide* the caller cannot
  recover — usually the edge of a service implementation — not the first line
  that can throw.
- **Catching `cause`/`unknown` to "log and continue"** in domain code.
  Interruption is a cause; swallowing it makes fibers unkillable.
- **Typing `R` by hand to `never`.** If it will not compile without a cast, a
  layer is missing; find it.
- **Importing from v3 paths or names.** `Effect.catchAll`, `Layer.scoped`,
  `Context.Tag`, `Effect.Service`, `Either` are not v4. See
  [references/v4-names.md](references/v4-names.md).

## Read the source — always

Skills are a map; `node_modules/effect` is the territory, and it ships its own
TypeScript source, JSDoc (with **When to use** and **Gotchas** sections),
maintained `ai-docs` examples and the authors' style guide (`CLAUDE.md`).
Effect v4 renamed much of v3, so memory and blog posts mislead; reading the
installed code does not.

1. Before using an API you have not seen in this project's installed
   `effect`, `grep` it and read its JSDoc: `src/<Module>.ts`. The Gotchas are
   the part that saves you a bug.
2. `ai-docs/src/**` first for "how do I do X"; `src/internal/` when you need to
   know what a function really does; `dist/*.d.ts` for the exact types.
3. When behaviour matters, turn the claim into a runnable experiment (a
   `ts import.meta.vitest` fence or a test) instead of trusting prose —
   including this skill's prose. If the source and a guide disagree, the source
   wins.
4. After every non-trivial change run `tsc --noEmit`. The compiler is the
   reviewer for E and R: an unexpected leftover in either is a design finding.
5. Modules marked `@stability unstable` (http, http-api, sql, ai, cli, rpc,
   cluster, workflow…) can change in minor releases; pin exact versions of
   every `effect` / `@effect/*` package together.

Commands, the anatomy of a JSDoc entry, a reading order, and a worked
experiment are in [references/reading-the-source.md](references/reading-the-source.md).

## Review checklist for Effect code

- Anything unfamiliar was looked up in the installed source, not guessed.
- Types were designed before bodies: states are tagged unions, ids are branded,
  no `as`/`any` to silence the compiler, service methods have declared signatures.

- Every `E` is a tagged, intentional, handled-or-documented set. No `unknown`
  or bare `Error`.
- No `async`, `await`, `try/catch`, `new Promise`, or `.then` in domain code.
- No `Effect.runPromise`/`runSync` outside the entrypoint, tests, or a
  framework bridge.
- No `process.env`, `Date.now`, `Math.random`, `console.log` — use `Config`,
  `Clock`, `Random`, `Effect.log`.
- Services are small interfaces; each has a test layer; layers are provided in
  one file.
- Every resource is acquired through a Layer or `Scope`; nothing is closed by
  hand.
- Concurrency has an explicit bound (`{ concurrency: n }`) and an owner
  (`forkScoped`, `Effect.scoped`).
- Tests use `@effect/vitest` `it.effect` with `TestClock`; no real sleeps.

## Where to go next

Read the guide for every module you touch **before** writing code with it.
Each `guide.md` follows the same shape: how to think about the module, a
decision table, a complete recipe, anti-patterns (wrong → right), how to test
it, and the boundaries with neighbouring modules. Folders also hold
`api-cheatsheet`-style files with verified signatures.

| You are doing | Guide |
| --- | --- |
| Run boundaries, typed errors vs defects, `Cause`/`Exit`, retry/timeout, creating effects from Promises/callbacks | [core](references/core/guide.md) |
| `Context.Service`, `Layer` composition, scoped resources, `ManagedRuntime`, startup/shutdown | [services](references/services/guide.md) |
| Decoding untrusted input, codecs, brands, tagged unions, schema-backed errors and classes | [schema](references/schema/guide.md) |
| `Option`/`Result`, `Data`, equality, ordering, immutable collections, absence vs failure | [data](references/data/guide.md) |
| `Config`, env/.env/secrets, `Redacted`, typed startup configuration | [config](references/config/guide.md) |
| Fibers, bounded fan-out, races/timeouts, `Queue`/`Semaphore`/`Deferred`/`Pool`/`PubSub`, lifetimes | [concurrency](references/concurrency/guide.md) |
| `Ref`, `SynchronizedRef`, `SubscriptionRef`, `ScopedRef`, `RcRef`, transactions (`Tx*`) | [state](references/state/guide.md) |
| `Schedule`, retry with backoff, polling, cron, `Clock`, `Duration`, `DateTime` | [time](references/time/guide.md) |
| `Stream`, pagination, backpressure, `Sink`, channels, framing large or endless data | [streams](references/streams/guide.md) |
| Base64/Hex, NDJSON/SSE, JSON-in-string, bytes vs text at boundaries | [encoding](references/encoding/guide.md) |
| Files, paths, terminal, child processes, sockets, workers, `NodeRuntime.runMain` | [platform](references/platform/guide.md) |
| `HttpClient`, raw `HttpRouter` servers, middleware, retries, schema-decoded bodies | [http](references/http/guide.md) |
| Schema-first `HttpApi`: endpoints, errors with status, auth middleware, typed client, OpenAPI | [http-api](references/http-api/guide.md) |
| `RpcGroup` contracts between processes you own; HTTP/WebSocket/worker transports | [rpc](references/rpc/guide.md) |
| `sql` tag, `SqlSchema`, repositories, transactions, migrations, `Model` | [sql](references/sql/guide.md) |
| Key-value stores, `PersistedCache`, durable queues, rate limiting | [persistence](references/persistence/guide.md) |
| Durable multi-step processes: `Workflow`, `Activity`, `DurableDeferred`, resume after restart | [workflow](references/workflow/guide.md) |
| Sharded `Entity` ownership, runners, idempotent/persisted messages | [cluster](references/cluster/guide.md) |
| Append-only typed event journals, replay, read models, multi-device sync | [eventlog](references/eventlog/guide.md) |
| Logs, metrics, spans, OTLP/Prometheus exporters, error reporting | [observability](references/observability/guide.md) |
| Typed commands, flags, arguments, prompts, exit codes | [cli](references/cli/guide.md) |
| `LanguageModel`, tool kits, structured output, streaming, agent loops, providers | [ai](references/ai/guide.md) |
| Test layers, `TestClock`, `@effect/vitest`, asserting failures/defects/interruption | [testing](references/testing/guide.md) |
| Atoms backed by Effects, `AsyncResult`, invalidation keys, UI bindings | [reactivity](references/reactivity/guide.md) |

How modules combine (HTTP API over SQL, validating external data, service
graphs, choosing persistence) is in
[references/composition.md](references/composition.md).

## References

- [Type-first development](references/type-first.md)
- [Reading the Effect source](references/reading-the-source.md)
- [Mental model and how to read a type](references/mental-model.md)
- [From async/await to Effect: rewrites](references/from-async-await.md)
- [Worked example: designing a feature](references/worked-example.md)
- [v3 → v4 names that trip people up](references/v4-names.md)
- [Effect source at 4.1.2](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Effect.ts)
- [Effect API docs](https://effect.website/docs/v4/api/effect/Effect)
