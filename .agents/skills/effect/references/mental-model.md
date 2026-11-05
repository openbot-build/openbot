# Mental model: reading and designing by type

## Three channels, one value

```ts import.meta.vitest name="references/mental-model.md#1"
import { Effect } from "effect"

//                              success  expected failure      requirements
//                                 ↓        ↓                    ↓
const lookup = (id: string): Effect.Effect<number, "Timeout" | "NotFound", never> =>
  id === "slow" ? Effect.fail("Timeout") : id === "u1" ? Effect.succeed(42) : Effect.fail("NotFound")

await Effect.runPromise(lookup("u1")) // => 42
```

- **A** — the value on success.
- **E** — failures the *caller is expected to handle*. Union of tagged types.
- **R** — services that must be provided before it can run. A union too; each
  `yield* Service` adds one, each `Effect.provide` removes what it supplies.

There is a fourth, untyped channel: the **defect** (a bug, an invariant
violation, an infrastructure fault nobody can recover from) and a fifth state,
**interruption**. Both live in `Cause`, not in `E`. This split is the design
tool: *if a caller will write a branch for it, it belongs in `E`; if the only
sensible reaction is "log and stop this request", make it a defect.*

## Laziness is the point

```ts import.meta.vitest name="references/mental-model.md#2"
import { Effect } from "effect"

const sayHi = Effect.sync(() => console.log("hi")) // nothing printed
const twice = Effect.all([sayHi, sayHi])           // still nothing printed
Effect.runSync(twice)                              // now prints twice
```

An Effect is a recipe, so the same recipe can be run many times, wrapped in
`retry`, `timeout`, `withSpan`, or given different services. A `Promise` is a
running computation; you can only wait for it. When you feel the urge to
`await` something just to pass it on, stay inside the recipe instead.

## How to read a signature

| Signature | What it tells you |
| --- | --- |
| `Effect<User, NotFound, UserRepo>` | needs a `UserRepo`; may fail with `NotFound`; yields a `User` |
| `Effect<void, never, never>` | cannot fail expectedly, needs nothing: runnable now |
| `Effect<A, E, Scope>` | holds a resource; wrap in `Effect.scoped` or provide a Scope |
| `Layer<Db, ConfigError, Config>` | builds `Db`, building can fail with `ConfigError`, needs `Config` first |
| `Layer<A, E, R>` provided to `Effect<X, E2, A \| B>` | result `Effect<X, E2 \| E, B \| R>` |

Layer algebra: `Layer.provide(inner)` feeds `inner` into the layer and
*hides* it; `Layer.provideMerge(inner)` feeds it and *keeps exposing* it;
`Layer.merge` puts independent layers side by side. Build the graph so that the
final type is `Layer<AppServices, StartupErrors, never>`.

## Design by type, in practice

1. Write the signature you wish you had — the type alone, before the body:
   `checkout: (cart: Cart) => Effect.Effect<Receipt, OutOfStock | PaymentDeclined, Payments | Inventory>`.
2. Implement; let inference fill `E` and `R`. If the inferred type has an
   extra member, you have a failure you did not decide about — handle it,
   translate it, or `orDie` it deliberately.
3. If TypeScript says a service is missing, that is a layer you have not
   provided: the compiler is telling you the program cannot start yet.

## Concurrency model in four sentences

Every running Effect is a **fiber**, a lightweight thread owned by its parent.
When a parent finishes, fails, or is interrupted, its children are interrupted
and their finalizers run (structured concurrency). `Effect.forkChild` makes a
child tied to the current fiber, `Effect.forkScoped` ties it to the current
`Scope` (e.g. a Layer's lifetime), `Effect.forkDetach` escapes ownership and is
rarely correct. Prefer high-level combinators — `Effect.forEach` with
`concurrency`, `Effect.race`, `Stream` — over hand-managed fibers.

## Resource model in three sentences

A `Scope` is a list of finalizers. `Effect.acquireRelease(acquire, release)`
adds one when it runs; closing the scope (normal exit, failure, *or*
interruption) runs them in reverse order. A `Layer` carries its own scope, so
"a service with a database pool" is simply a Layer that uses `acquireRelease`.

## When the types fight you

- *"Type 'X' is not assignable to type 'never'" at a `runPromise`* — `R` is not
  empty; provide the missing layer first.
- *E widens to a huge union* — introduce a boundary error that wraps several
  low-level ones (`mapError((reason) => new RepoError({ reason }))`) so
  callers see one thing per layer of the architecture.
- *You want to annotate `R` or `E` by hand to make it compile* — don't; find
  the cause. Annotating return types of *service methods* is fine and good (it
  is the contract); annotating internals is noise.
