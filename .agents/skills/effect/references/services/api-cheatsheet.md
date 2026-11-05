# Services, Layers, Scopes: verified API

All signatures read (effect@4.1.x) from `node_modules/effect/dist/{Context,Layer,Effect,Scope}.d.ts`.

## Context

| API | Meaning |
| --- | --- |
| `class X extends Context.Service<X, Shape>()("id") {}` | class-style key. `X` is the key and the type. `X["Service"]` is `Shape`. |
| `Context.Service<X, Shape>()("id", { make })` | `make: Effect<Shape, E, R>` (or a function returning one) is exposed as `X.make` |
| `Context.Service<Shape>("id")` | function-style key (no class) |
| `X.of(shape)` | identity function that type-checks `shape` |
| `X.use((s) => Effect)` | `Effect<A, E, R \| X>` |
| `X.useSync((s) => a)` | `Effect<A, never, X>` |
| `yield* X` | read the service inside `Effect.gen` |
| `Context.Reference<T>("id", { defaultValue: () => t })` | service with a default; never appears in `R` |
| `Context.make(key, impl)`, `Context.add`, `Context.get`, `Context.getOption`, `Context.merge`, `Context.mergeAll`, `Context.pick`, `Context.omit` | working with raw contexts |
| `Effect.provideService(key, impl)` | provide one implementation to one effect (also data-first) |
| `Effect.updateService(key, f)` | modify the provided service for an effect (adds it to `R`) |
| `Effect.service(key)` | `Effect<S, never, I>`, same as `yield* key` |

## Layer

`Layer<ROut, E = never, RIn = never>`.

| API | Type |
| --- | --- |
| `Layer.succeed(key, impl)` / `Layer.succeed(key)(impl)` | `Layer<I>` |
| `Layer.sync(key)(() => impl)` | `Layer<I>` |
| `Layer.effect(key, effect)` / `Layer.effect(key)(effect)` | `Layer<I, E, Exclude<R, Scope>>` (the layer's Scope is supplied for you) |
| `Layer.effectDiscard(effect)` | `Layer<never, E, Exclude<R, Scope>>` |
| `Layer.unwrap(effectOfLayer)` | `Layer<A, E \| E1, R1 \| Exclude<R, Scope>>` |
| `Layer.suspend(() => layer)` | lazy layer |
| `Layer.empty` | `Layer<never>` |
| `Layer.mergeAll(a, b, ...)` / `Layer.merge(a, b)` | union of outputs, union of requirements; built concurrently |
| `self.pipe(Layer.provide(dep))` | `Layer<ROut2, E \| E2, RIn \| Exclude<RIn2, ROut>>`; also accepts an array of layers |
| `self.pipe(Layer.provideMerge(dep))` | like `provide`, but the output also contains `dep`'s output |
| `Layer.fresh(layer)` | opt out of sharing |
| `Layer.orDie` | layer error becomes a defect |
| `Layer.catchTag("T", f)` / `Layer.catchCause` / `Layer.catch` | fall back to another layer |
| `Layer.tap(f)` | run an effect with the built context, keep the layer |
| `Layer.updateService(key, f)` | modify a service on its way out |
| `Layer.mock(key, partialImpl)` | test double; omitted Effect members fail with an "unimplemented" defect |
| `Layer.launch(layer)` | `Effect<never, E, RIn>`: build, then run forever until interrupted |
| `Layer.build(layer)` | `Effect<Context<ROut>, E, RIn \| Scope>` |
| `Layer.buildWithScope(layer, scope)` | build into a scope you control |
| `Layer.span`, `Layer.withSpan` | tracing for layer construction |
| `Layer.makeMemoMapUnsafe()` | share memoization across several `ManagedRuntime`s (`ManagedRuntime.make(layer, { memoMap })`) |

Provide to an effect: `Effect.provide(layer)`, `Effect.provide([layerA, layerB])`,
`Effect.provide(layer, { local: true })` (rebuild for this call).

## Scope and resources

| API | Meaning |
| --- | --- |
| `Effect.acquireRelease(acquire, (a, exit) => release, { interruptible? })` | `Effect<A, E, R \| R2 \| Scope>` |
| `Effect.acquireUseRelease(acquire, use, release)` | no `Scope` in `R` |
| `Effect.acquireDisposable(acquire)` | for `Disposable` / `AsyncDisposable` resources |
| `Effect.addFinalizer((exit) => Effect<void>)` | `Effect<void, never, R \| Scope>` |
| `Effect.scoped(eff)` | removes `Scope` from `R`, closes it when `eff` finishes |
| `Effect.scope` | read the current `Scope` |
| `Effect.forkScoped(eff)` | fork a fiber owned by the scope; interrupted when it closes |
| `Effect.forkIn(scope)` | fork into a specific scope |
| `Scope.make(strategy?)` | `Effect<Scope.Closeable>`; `"sequential"` (default) or `"parallel"` finalizers |
| `Scope.close(scope, exit)` | run finalizers (reverse order) |
| `Scope.provide(scope)` | satisfy `Scope` in `R` with this scope |
| `Scope.addFinalizer(scope, effect)` | |
| `ScopedRef.make(() => a)` / `ScopedRef.set(self, acquire)` / `ScopedRef.get` | a value that can be re-acquired; old resource released |
| `RcRef.make({ acquire, idleTimeToLive? })` / `RcRef.get` | reference-counted shared resource |
| `Pool.make({ acquire, size, concurrency?, targetUtilization? })` / `Pool.get` | resource pool; `Pool.get` needs `Scope` |
| `LayerMap.Service<Self>()(id, { lookup, idleTimeToLive?, dependencies? })` | keyed layers; `.get(key)`, `.invalidate(key)`, `.layer` |

## Reading a Layer type

`Layer<Signup, ConfigError | MailerError, never>`:

- `Signup`: what you get.
- `ConfigError | MailerError`: how startup can fail (a launch error).
- `never`: nothing left to provide, so it is safe to hand to
  `Effect.provide`, `Layer.launch` or `ManagedRuntime.make`.

`ManagedRuntime.make` only accepts a layer with `RIn = never`; the compiler
points at exactly what is missing if you forgot one.
