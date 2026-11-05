# Effect services, layers, and resource ownership

## How to think about it

A **service** is a *named capability* your code needs ("send mail", "look up a
user") described by an interface, not an implementation. Code that needs it
writes `yield* Mailer` and the type `R` of that effect grows a `Mailer`. `R` is
a to-do list the compiler keeps: the effect cannot be run until something
provides every item.

A **Layer** is the recipe for building a service: `Layer<ROut, E, RIn>` reads
"I produce `ROut`, I may fail to start with `E`, and I need `RIn` first". A
layer can read config, open a connection, start a background fiber, and
register a finalizer; the runtime builds layers in dependency order, shares each
one, and releases them in reverse order when the program ends. Layers are where
startup, shutdown and dependency wiring live, so domain code contains none of
it.

If you come from Express/Nest/Spring: there is no container, no decorators and
no reflection. Dependencies are types, the "container" is `Layer`, and the
wiring is ordinary values you compose. If you come from plain TypeScript:
stop importing `db` from a module and stop passing clients down five function
parameters. Name the capability, depend on it with `yield*`, provide it once at
the root, swap it in tests.

Three consequences shape every design:

1. A service *method* has `R = never`. Its dependencies were resolved when the
   layer was built; they must not leak into callers' types.
2. Resources (`new Pool()`, a socket, a timer) are acquired inside the layer
   with `Effect.acquireRelease` or forked with `Effect.forkScoped`, so the
   layer's scope owns the cleanup.
3. Provide layers in one place (the composition root). Every
   `Effect.provide(SomeLayer)` in the middle of the program is a second build.

## Choose

| Situation | Use | Why |
| --- | --- | --- |
| Name a capability | `class X extends Context.Service<X, Shape>()("app/X") {}` | the class is the key, the type and the place for `layer` |
| Read it | `const x = yield* X` in a layer or use case | adds `X` to `R` |
| One-shot call without a variable | `X.use((x) => x.method())` | still adds `X` to `R` |
| Implementation with no deps/resources | `Layer.succeed(X, impl)` | cheapest |
| Implementation that needs other services, config or setup | `Layer.effect(X, Effect.gen(...))` | `yield*` deps inside; `R` of the layer is inferred |
| Needs a resource with cleanup | `Effect.acquireRelease` inside `Layer.effect` | released when the layer's scope closes, even on failure |
| Background job tied to app lifetime | `Layer.effectDiscard(Effect.forkScoped(job))` | no service output; fiber interrupted at shutdown |
| Hide a layer's dependencies | `layer.pipe(Layer.provide(dep))` | output is just the service |
| Keep dependency visible downstream | `layer.pipe(Layer.provideMerge(dep))` | output is service + dependency |
| Independent layers side by side | `Layer.mergeAll(a, b, c)` | built concurrently |
| Choose the layer from config | `Layer.unwrap(Effect.gen(... return someLayer))` | decide at startup |
| Value with a default (flag, level) | `Context.Reference<T>(key, { defaultValue })` | no layer required |
| Per-tenant/per-key resource | `LayerMap.Service` | built lazily, idle-released |
| A shared pool / ref-counted resource | `Pool.make`, `RcRef.make`, `ScopedRef.make` | explicit lifetimes |
| Process entry for a layer-only app | `Layer.launch(AppLayer)` with `NodeRuntime.runMain` | runs until interrupted |
| Test | provide a test layer (`layerTest`, `Layer.mock`) | same use case, different edges |

When *not* to make a service: pure helpers, constants and data transforms are
plain functions and modules. Services are for things that perform effects,
hold state or resources, vary by environment, or that you want to fake.

## Recipe

### The pitfall

```ts skip
// db.ts: connects at import time, never closed, untestable, order-dependent.
export const db = new Pool({ connectionString: process.env.DATABASE_URL! })

// signup.ts: imports the concrete thing and uses a global clock and mailer.
import { db } from "./db"
export async function signup(email: string) {
  await db.query("insert into users ...", [email])
  await sendgrid.send({ to: email })    // tests call the real network
}
```

### The idiomatic version

A mailer that owns a connection, a user repository, and a use-case service that
depends on both. Every decision is narrated.

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Config, Context, Effect, Layer, Ref, Schema } from "effect"

// Errors are part of each service's *contract*: one class per thing a caller
// may react to. Layer-time failures (Config, connection) are separate and show
// up in the Layer's E, not in method signatures.
export class EmailTaken extends Schema.TaggedError<EmailTaken>()("EmailTaken", {
  email: Schema.String
}) {}
export class MailerError extends Schema.TaggedError<MailerError>()("MailerError", {
  cause: Schema.Defect()
}) {}

// A foreign client we do not control; stands in for an SDK.
class SmtpConnection {
  static readonly open = async (host: string) => new SmtpConnection(host)
  constructor(readonly host: string) {}
  readonly send = async (to: string, body: string) => {
    console.log(`[${this.host}] -> ${to}: ${body}`)
  }
  readonly close = async () => {
    console.log("smtp closed")
  }
}

// 1. A capability. The interface speaks the domain (send mail), not the SDK
//    (no `connection` leaks out), and every method has R = never.
export class Mailer extends Context.Service<Mailer, {
  send(to: string, body: string): Effect.Effect<void, MailerError>
}>()("app/Mailer") {
  // 2. The live implementation lives next to the key. Layer.effect: building
  //    the service is itself an Effect (config, connect, register cleanup).
  static readonly layer = Layer.effect(
    Mailer,
    Effect.gen(function*() {
      // Config is read here, once, at startup. A missing value is a typed
      // ConfigError in the *layer's* E, not a crash in some request later.
      const host = yield* Config.String("SMTP_HOST").pipe(Config.withDefault("localhost"))

      // acquireRelease inside a Layer: the layer's scope owns the connection.
      // It closes on normal shutdown, on failure of a later layer, on SIGINT.
      const connection = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => SmtpConnection.open(host),
          catch: (cause) => new MailerError({ cause })
        }),
        (c) => Effect.promise(() => c.close())
      )

      const send = Effect.fn("Mailer.send")((to: string, body: string) =>
        Effect.tryPromise({
          try: () => connection.send(to, body),
          catch: (cause) => new MailerError({ cause })
        })
      )

      // `of` checks the object against the interface.
      return Mailer.of({ send })
    })
  )
}

export class Users extends Context.Service<Users, {
  create(email: string): Effect.Effect<void, EmailTaken>
}>()("app/Users") {
  static readonly layer = Layer.effect(
    Users,
    Effect.gen(function*() {
      // State lives in a Ref created *per layer build*, not at module level.
      const emails = yield* Ref.make<ReadonlySet<string>>(new Set())
      const create = Effect.fn("Users.create")(function*(email: string) {
        const all = yield* Ref.get(emails)
        if (all.has(email)) {
          return yield* new EmailTaken({ email })
        }
        yield* Ref.set(emails, new Set(all).add(email))
      })
      return Users.of({ create })
    })
  )
}

// 3. A use-case service that composes the others. Dependencies are read
//    once, at construction; `register` itself requires nothing.
export class Signup extends Context.Service<Signup, {
  register(email: string): Effect.Effect<void, EmailTaken | MailerError>
}>()("app/Signup") {
  // `layerNoDeps` states its needs honestly: Layer<Signup, never, Users | Mailer>.
  // Tests and alternative wirings reuse it with their own dependencies.
  static readonly layerNoDeps = Layer.effect(
    Signup,
    Effect.gen(function*() {
      const users = yield* Users
      const mailer = yield* Mailer
      const register = Effect.fn("Signup.register")(function*(email: string) {
        yield* users.create(email)
        yield* mailer.send(email, "welcome")
      })
      return Signup.of({ register })
    })
  )

  // `layer` closes the graph: Layer.provide hides Users/Mailer from callers.
  // Type: Layer<Signup, ConfigError | MailerError, never>.
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(Layer.mergeAll(Users.layer, Mailer.layer))
  )
}

// 4. Domain code: R is Signup; E is exactly what we choose not to handle.
const program = Effect.gen(function*() {
  const signup = yield* Signup
  yield* signup.register("ada@example.com")
  yield* signup.register("ada@example.com")
}).pipe(
  Effect.catchTag("EmailTaken", (e) => Effect.logWarning("already registered", e.email))
)

// 5. Composition root: the only place that provides, the only place that runs.
//    runMain needs R = never; it will not compile until every layer is here.
NodeRuntime.runMain(program.pipe(Effect.provide(Signup.layer)))
```

What the compiler is telling you: `program` has `R = Signup`, so
`NodeRuntime.runMain(program)` is a type error; after `Effect.provide(Signup.layer)`
the requirement is gone and the remaining `E` (`MailerError`, `ConfigError`) is
what `runMain` will report.

### Choosing a layer from config, and a background worker

`Layer.unwrap` picks an implementation from `Config` at startup; `Layer.effectDiscard(Effect.forkScoped(job))` runs a worker owned by the app's scope; `Layer.launch(App)` + `NodeRuntime.runMain` runs the graph until interrupted. Full compiled example: "Choosing and running layers" in [references/layer-recipes.md](layer-recipes.md).

## Wiring rules

- **`provide` vs `provideMerge`.** `A.pipe(Layer.provide(B))` *consumes* `B`: the
  result exposes only `A`. `A.pipe(Layer.provideMerge(B))` exposes both. Use
  `provide` in library-style `layer` constants; use `provideMerge` at the root
  when tests or a framework also need the dependency.
- **Sharing is by layer value.** Within one build, a layer value appearing in
  several places is built once. A *function that returns a layer*, called
  twice, makes two layers and two pools. Bind it to a `const` and reuse it.
  `Layer.fresh(layer)` opts out of sharing deliberately.
- **Each `Effect.provide(layer)` call builds its layers** and releases them
  when that effect finishes. Provide once at the root, not per request.
- **No cycles.** If `A` needs `B` and `B` needs `A`, extract the shared
  capability into a third service.
- **Layer errors are startup errors.** `Layer<ROut, E>` fails the whole app
  with `E`. Use `Layer.orDie` if you want the launch to crash with a defect,
  `Layer.catchTag` to fall back to another layer.
- **Resource order is dependency order.** A layer's dependencies are built
  first and released last; you never schedule that by hand.

## Scopes for resources outside a layer

A `Scope` is a bag of finalizers. `Effect.acquireRelease` and `Effect.forkScoped`
put `Scope` in `R`; provide it with `Effect.scoped(eff)` (closed when `eff`
ends), with a scope you create via `Scope.make()` and close with
`Scope.close(scope, Exit.void)`, or let a Layer do it. Prefer
`Effect.acquireUseRelease(acquire, use, release)` for a resource used in one
place and a Layer for one shared by many. Worked example 8 in
[references/layer-recipes.md](layer-recipes.md).

## Anti-patterns

```ts skip
// 1. Dependencies leak into methods.
class Users extends Context.Service<Users, {
  find(id: string): Effect.Effect<User, NotFound, SqlClient>   // R in a method
}>()("app/Users") {}
```
Right: read `SqlClient` in `Layer.effect(Users, ...)` and expose `Effect<User, NotFound>`.
Consequence: every caller now needs `SqlClient` too, and you cannot swap the implementation without changing the interface.

```ts skip
// 2. A layer factory called twice.
const live = Layer.mergeAll(A.pipe(Layer.provide(makePool())), B.pipe(Layer.provide(makePool())))
```
Right: `const PoolLive = makePool()` then reuse the value. Consequence: two connection pools (verified: two builds, two releases).

```ts skip
// 3. Providing inside the program.
const handler = (req: Req) => process(req).pipe(Effect.provide(Db.layer))
```
Right: provide once at the composition root. Consequence: a pool is built and torn down per request.

```ts skip
// 4. Unowned resources.
Layer.effect(Db, Effect.sync(() => Db.of(new Pool(url))))   // never closed
```
Right: `Effect.acquireRelease(Effect.sync(() => new Pool(url)), (p) => Effect.promise(() => p.end()))`.
Consequence: connections outlive the app; tests hang on open handles.

```ts skip
// 5. Exposing the SDK instead of a capability.
class Stripe extends Context.Service<Stripe, { readonly client: StripeSdk }>()("Stripe") {}
```
Right: expose `charge(amount): Effect<Receipt, PaymentDeclined>`. Consequence: every caller couples to the SDK and the fake must reimplement it.

```ts skip
// 6. Ambient config and globals in methods.
const send = () => Effect.tryPromise(() => fetch(process.env.MAIL_URL!))
```
Right: `Config.String("MAIL_URL")` in the layer. Consequence: missing config surfaces mid-request as a crash instead of at startup as a typed `ConfigError`.

```ts skip
// 7. Duplicated keys.
class RedisCache extends Context.Service<RedisCache, { readonly get: (k: string) => Effect.Effect<string> }>()("app/Cache") {}
class LruCache extends Context.Service<LruCache, { readonly size: Effect.Effect<number> }>()("app/Cache") {}
```
Right: one unique id per service, e.g. package/path/Name. Consequence: both occupy the same slot in the `Context`; one silently shadows the other.

```ts skip
// 8. v3 constructs.
class Foo extends Context.Tag("Foo")<Foo, Shape>() {}
class Bar extends Effect.Service<Bar>()("Bar", { effect: Effect.succeed({ n: 1 }) }) {}
Layer.scoped(Foo, Effect.succeed({ n: 1 }))
```
Right: `Context.Service<Foo, Shape>()("Foo")` and `Layer.effect` (it already provides a Scope). Consequence: none of these exist in 4.x.

## Testing it

The point of services is that a test supplies a different layer for the same
use case. Keep the production `layerNoDeps` and give the test its own edges. A
shared in-memory fake that also exposes what was sent makes assertions simple.

```ts import.meta.vitest name="references/services/guide.md#11"
import assert from "node:assert/strict"
import { Context, Effect, Layer, Ref } from "effect"

class Mailer extends Context.Service<Mailer, {
  send(to: string): Effect.Effect<void>
}>()("app/Mailer") {}

// The fake records what it was asked to do; it is exposed as its own service
// so a test can read it back.
class Outbox extends Context.Service<Outbox, Ref.Ref<ReadonlyArray<string>>>()("test/Outbox") {
  static readonly layer = Layer.effect(Outbox, Ref.make<ReadonlyArray<string>>([]))
}

const MailerTest = Layer.effect(
  Mailer,
  Effect.gen(function*() {
    const outbox = yield* Outbox
    return Mailer.of({ send: (to) => Ref.update(outbox, (all) => [...all, to]) })
  })
).pipe(Layer.provideMerge(Outbox.layer)) // provideMerge: tests can also see Outbox

const welcome = Effect.gen(function*() {
  const mailer = yield* Mailer
  yield* mailer.send("ada@example.com")
})

const test = Effect.gen(function*() {
  yield* welcome
  const outbox = yield* Outbox
  assert.deepEqual(yield* Ref.get(outbox), ["ada@example.com"])
}).pipe(Effect.provide(MailerTest))

await Effect.runPromise(test)

// Partial fake: Layer.mock only needs the members the test touches; calling an
// omitted Effect member fails loudly with an "unimplemented" defect.
const Quiet = Layer.mock(Mailer, {})
await Effect.runPromise(Effect.void.pipe(Effect.provide(Quiet)))
```

Finalizers are behaviour; test them. Build the layer inside a scope you close
yourself and assert on what the release did:

```ts import.meta.vitest name="references/services/guide.md#12"
import assert from "node:assert/strict"
import { Context, Effect, Exit, Layer, Scope } from "effect"

const events: Array<string> = []

class Conn extends Context.Service<Conn, { readonly id: number }>()("app/Conn") {
  static readonly layer = Layer.effect(
    Conn,
    Effect.acquireRelease(
      Effect.sync(() => (events.push("open"), Conn.of({ id: 1 }))),
      () => Effect.sync(() => void events.push("close"))
    )
  )
}

const test = Effect.gen(function*() {
  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(Conn.layer, scope)
  assert.equal(Context.get(context, Conn).id, 1)
  assert.deepEqual(events, ["open"])
  yield* Scope.close(scope, Exit.void)
  assert.deepEqual(events, ["open", "close"])
})

await Effect.runPromise(test)
```

With `@effect/vitest`, `layer(MyLayer)("suite", (it) => { it.effect(...) })`
builds the layer once for the block and tears it down in `afterAll`; state is
shared between tests inside it. Compiled examples are in
[testing](../testing/vitest-patterns.md).

## Changed in 4.1

- `ManagedRuntime.dispose()` is coalesced: concurrent or repeated calls wait for
  the first dispose, and disposing from inside a fiber the runtime owns no longer
  deadlocks.
- `Context.makeUnsafe(map, { maxDepth })` takes an optional overlay depth
  (default 8) before a `Context` flattens itself; you rarely need it.
- `Context.pick` with zero or one key builds the result directly.
- Nothing in `Context.Service`, `Layer.effect`, `Layer.provide` or `Scope`
  changed shape; code written for 4.0.0 compiles as is.

## Boundaries

- [core](../core/guide.md): typed errors, `catchTag`, running (`runMain`, `ManagedRuntime`).
  Here you only decide that `R` must be empty before running.
- [config](../config/guide.md): `Config` schemas, providers, `Redacted`. Layers are where
  config is *read*.
- [concurrency](../concurrency/guide.md): what the forked fiber in a worker layer does; queues,
  semaphores, `FiberSet`.
- [testing](../testing/guide.md): `@effect/vitest`, `TestClock`, shared-layer test suites.
- [platform](../platform/guide.md), [sql](../sql/guide.md), [http](../http/guide.md), [ai](../ai/guide.md) and others: ready-made
  layers (`NodeHttpServer.layer`, `SqlClient`, `HttpClient`). Use theirs; do not
  re-wrap an SDK that already has a service.
- Errors cross the layer boundary as `E` of the `Layer` (startup) and as method
  `E` (runtime); resources cross as the scope that the layer owns.

## References

- [references/api-cheatsheet.md](api-cheatsheet.md): Context, Layer, Scope signatures
- [references/layer-recipes.md](layer-recipes.md): more worked graphs (shared pools, test doubles, ManagedRuntime, LayerMap)
- [Context API](https://effect.website/docs/v4/api/effect/Context)
- [Layer API](https://effect.website/docs/v4/api/effect/Layer)
- [Scope API](https://effect.website/docs/v4/api/effect/Scope)
- [ManagedRuntime API](https://effect.website/docs/v4/api/effect/ManagedRuntime)
- [Layer.ts at 4.1.2](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Layer.ts)
- [Context.ts at 4.1.2](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Context.ts)
- Maintained examples ship with the package: `node_modules/effect/ai-docs/src/01_effect/03_services/` and `05_resources/`
