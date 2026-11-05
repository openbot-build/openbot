# Layer recipes

Longer worked graphs for situations the main skill only names. Each snippet is
a complete file.

## 1. One pool, shared by two repositories

Wire the shared dependency *once* and reuse the same layer value: the pool is
built once and released once. (A function that returns a layer, called twice,
builds two pools.)

```ts import.meta.vitest name="references/services/layer-recipes.md#1"
import { Context, Effect, Layer } from "effect"

const events: Array<string> = []

class Pool extends Context.Service<Pool, {
  query(sql: string): Effect.Effect<ReadonlyArray<string>>
}>()("app/Pool") {
  static readonly layer = Layer.effect(
    Pool,
    Effect.acquireRelease(
      Effect.sync(() => {
        events.push("pool opened")
        return Pool.of({ query: (sql) => Effect.succeed([sql]) })
      }),
      () => Effect.sync(() => void events.push("pool closed"))
    )
  )
}

class Orders extends Context.Service<Orders, {
  readonly all: Effect.Effect<ReadonlyArray<string>>
}>()("app/Orders") {
  static readonly layerNoDeps = Layer.effect(
    Orders,
    Effect.gen(function*() {
      const pool = yield* Pool
      return Orders.of({ all: pool.query("select * from orders") })
    })
  )
}

class Invoices extends Context.Service<Invoices, {
  readonly all: Effect.Effect<ReadonlyArray<string>>
}>()("app/Invoices") {
  static readonly layerNoDeps = Layer.effect(
    Invoices,
    Effect.gen(function*() {
      const pool = yield* Pool
      return Invoices.of({ all: pool.query("select * from invoices") })
    })
  )
}

// Both repositories depend on the same `Pool.layer` value => one pool.
// Layer.provide(Pool.layer) on the merged layer states that most clearly.
export const Repos = Layer.mergeAll(Orders.layerNoDeps, Invoices.layerNoDeps).pipe(
  Layer.provide(Pool.layer)
)

export const program = Effect.gen(function*() {
  const orders = yield* Orders
  const invoices = yield* Invoices
  return [...(yield* orders.all), ...(yield* invoices.all)]
}).pipe(Effect.provide(Repos))

// One "pool opened", one "pool closed", and the queries ran against that pool.
await Effect.runPromise(program) // => ["select * from orders", "select * from invoices"]
events // => ["pool opened", "pool closed"]
```

## 2. Alternative implementations with one interface

Put each implementation next to the key as a static layer. The use case never
changes; the root (or a test) picks.

```ts import.meta.vitest name="references/services/layer-recipes.md#2"
import { Context, Effect, Layer, Ref, Schema } from "effect"

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }) {}

export class Todos extends Context.Service<Todos, {
  add(title: string): Effect.Effect<string>
  get(id: string): Effect.Effect<string, NotFound>
}>()("app/Todos") {
  // In-memory: fast, deterministic, fine for tests and local development.
  static readonly layerMemory = Layer.effect(
    Todos,
    Effect.gen(function*() {
      const rows = yield* Ref.make<ReadonlyMap<string, string>>(new Map())
      return Todos.of({
        add: Effect.fn("Todos.add")(function*(title) {
          const id = String((yield* Ref.get(rows)).size + 1)
          yield* Ref.update(rows, (m) => new Map(m).set(id, title))
          return id
        }),
        get: Effect.fn("Todos.get")(function*(id) {
          const title = (yield* Ref.get(rows)).get(id)
          if (title === undefined) return yield* new NotFound({ id })
          return title
        })
      })
    })
  )
}

export const addAndRead = Effect.gen(function*() {
  const todos = yield* Todos
  const id = yield* todos.add("write docs")
  return yield* todos.get(id)
})

// Swap implementation by swapping the layer, not the code.
export const program = addAndRead.pipe(Effect.provide(Todos.layerMemory))

await Effect.runPromise(program) // => "write docs"
// The in-memory fake keeps the real contract: a missing id is a typed NotFound.
const missing = await Effect.runPromise(
  Todos.use((todos) => todos.get("nope")).pipe(Effect.flip, Effect.provide(Todos.layerMemory))
)
missing._tag // => "NotFound"
```

## 3. `make` option: one definition, several layers

`Context.Service` accepts a `make` effect, exposed as `Service.make`, so a live
and a test layer can share construction logic.

```ts import.meta.vitest name="references/services/layer-recipes.md#3"
import { Context, Effect, Layer } from "effect"

export class Greeter extends Context.Service<Greeter, {
  greet(name: string): Effect.Effect<string>
}>()("app/Greeter", {
  make: Effect.gen(function*() {
    const prefix = "Hello"
    return { greet: (name: string) => Effect.succeed(`${prefix}, ${name}`) }
  })
}) {
  static readonly layer = Layer.effect(this, this.make)
}

export const program = Greeter.use((g) => g.greet("Ada")).pipe(Effect.provide(Greeter.layer))

await Effect.runPromise(program) // => "Hello, Ada"
```

## 4. A value with a default: `Context.Reference`

For flags and tunables there is nothing to build, so no layer is required. If
nothing provides it, the default is used.

```ts import.meta.vitest name="references/services/layer-recipes.md#4"
import { Context, Effect } from "effect"

export const MaxRetries = Context.Reference<number>("app/MaxRetries", {
  defaultValue: () => 3
})

export const program = Effect.gen(function*() {
  const max = yield* MaxRetries
  return max
})

// 3 by default; override locally for one effect:
export const overridden = program.pipe(Effect.provideService(MaxRetries, 10))

await Effect.runPromise(program) // => 3
await Effect.runPromise(overridden) // => 10
```

## 5. Per-tenant resources with `LayerMap`

`LayerMap.Service` builds a layer lazily per key, shares it between users of
the same key, and releases it after `idleTimeToLive`.

```ts import.meta.vitest name="references/services/layer-recipes.md#5"
import { Context, Effect, Layer, LayerMap } from "effect"

class TenantDb extends Context.Service<TenantDb, {
  readonly tenant: string
}>()("app/TenantDb") {
  static readonly layer = (tenant: string) =>
    Layer.effect(
      TenantDb,
      Effect.acquireRelease(
        Effect.sync(() => TenantDb.of({ tenant })),
        () => Effect.log(`closed ${tenant}`)
      )
    )
}

class Tenants extends LayerMap.Service<Tenants>()("app/Tenants", {
  lookup: (tenant: string) => TenantDb.layer(tenant),
  idleTimeToLive: "1 minute"
}) {}

export const program = Effect.gen(function*() {
  const db = yield* TenantDb
  return db.tenant
}).pipe(
  Effect.provide(Tenants.get("acme")), // Layer<TenantDb, never, Tenants>
  Effect.provide(Tenants.layer)
)

await Effect.runPromise(program) // => "acme"
```

## 6. Bridging to a framework: `ManagedRuntime`

Build the application layer once; run request-level effects through it. Layers
are built lazily on first use and released by `dispose()`.

```ts import.meta.vitest name="references/services/layer-recipes.md#6"
import { Context, Effect, Layer, ManagedRuntime } from "effect"

class Counter extends Context.Service<Counter, { readonly next: Effect.Effect<number> }>()("app/Counter") {
  static readonly layer = Layer.effect(
    Counter,
    Effect.sync(() => {
      let n = 0 // state belongs to this layer build, not to the module
      return Counter.of({ next: Effect.sync(() => ++n) })
    })
  )
}

export const runtime = ManagedRuntime.make(Counter.layer)

// Framework handler: thin; everything interesting is an Effect.
export const handler = async () => {
  const exit = await runtime.runPromiseExit(Counter.use((c) => c.next))
  return exit._tag === "Success" ? { status: 200, body: exit.value } : { status: 500, body: 0 }
}

// The layer was built once, so state is shared across requests.
await handler() // => { status: 200, body: 1 }
await handler() // => { status: 200, body: 2 }

// In a server: process.once("SIGTERM", () => void runtime.dispose())
await runtime.dispose()
```

## 7. Fall back to another layer, or fail the launch

```ts import.meta.vitest name="references/services/layer-recipes.md#7"
import { Context, Effect, Layer, Schema } from "effect"

class Cache extends Context.Service<Cache, { readonly kind: string }>()("app/Cache") {}

class RedisDown extends Schema.TaggedError<RedisDown>()("RedisDown", {}) {}

const redis = Layer.effect(Cache, Effect.fail(new RedisDown()))
const memory = Layer.succeed(Cache, Cache.of({ kind: "memory" }))

// Fall back if Redis is down; other failures still stop the launch.
export const CacheLive = redis.pipe(Layer.catchTag("RedisDown", () => memory))

// Or crash the launch with a defect instead of a typed layer error:
export const Strict = redis.pipe(Layer.orDie)

await Effect.runPromise(Cache.use((c) => Effect.succeed(c.kind)).pipe(Effect.provide(CacheLive))) // => "memory"

// With orDie the typed RedisDown becomes a defect: the run fails, no fallback.
const strictExit = await Effect.runPromiseExit(Cache.use((c) => Effect.succeed(c.kind)).pipe(Effect.provide(Strict)))
strictExit._tag // => "Failure"
```

## 8. Scopes for resources outside a layer

A `Scope` is a bag of finalizers. `Effect.acquireRelease` and `Effect.forkScoped`
require `Scope` in `R`; something must provide it.

```ts import.meta.vitest name="references/services/layer-recipes.md#8"
import { Effect, Exit, Scope } from "effect"

const events: Array<string> = []
const note = (event: string) => Effect.sync(() => void events.push(event))

// Effect.scoped: a scope that lives exactly as long as this effect.
export const withTempResource = Effect.scoped(
  Effect.gen(function*() {
    yield* Effect.acquireRelease(note("open"), () => note("close"))
    yield* note("using")
  })
)

await Effect.runPromise(withTempResource)
events // => ["open", "using", "close"]

// A scope you control (for example per connection or per request in a server):
export const manual = Effect.gen(function*() {
  const scope = yield* Scope.make()
  yield* Effect.acquireRelease(note("open2"), () => note("close2")).pipe(Scope.provide(scope))
  yield* note("alive until we close the scope")
  yield* Scope.close(scope, Exit.void)
})

await Effect.runPromise(manual)
events.slice(3) // => ["open2", "alive until we close the scope", "close2"]
```

Prefer `Effect.acquireUseRelease(acquire, use, release)` when the resource is
used in one place; prefer a Layer when it is shared by many users.

## Choosing and running layers

```ts
import { Config, Context, Effect, Layer } from "effect"

class Store extends Context.Service<Store, {
  readonly put: (k: string, v: string) => Effect.Effect<void>
}>()("app/Store") {
  static readonly layerMemory = Layer.sync(Store)(() => {
    const data = new Map<string, string>()
    return Store.of({ put: (k, v) => Effect.sync(() => void data.set(k, v)) })
  })
  static readonly layerRemote = (url: URL) =>
    Layer.succeed(Store, Store.of({ put: (k, v) => Effect.log(`PUT ${url.host}/${k}=${v}`) }))

  // Choose the implementation at startup, from config. The Effect runs once
  // when the layer is built; its result *is* the layer.
  static readonly layer = Layer.unwrap(
    Effect.gen(function*() {
      const inMemory = yield* Config.Boolean("STORE_IN_MEMORY").pipe(Config.withDefault(false))
      if (inMemory) return Store.layerMemory
      const url = yield* Config.URL("STORE_URL")
      return Store.layerRemote(url)
    })
  )
}

// A background worker as a layer: no service output; the forked fiber is owned
// by the layer's scope and interrupted when the app shuts down.
export const Heartbeat = Layer.effectDiscard(
  Effect.forkScoped(
    Effect.forever(Effect.sleep("30 seconds").pipe(Effect.andThen(Effect.logInfo("alive"))))
  )
)

// Compose: Heartbeat needs nothing, Store.layer needs nothing.
// Layer.launch turns the whole graph into one long-running Effect<never>.
export const App = Layer.mergeAll(Store.layer, Heartbeat)
export const main = Layer.launch(App)
```

Run `main` with `NodeRuntime.runMain(main)`. Ctrl-C interrupts it, the scope
closes, finalizers run in reverse build order.

