# Effect reactivity: atoms, AsyncResult and invalidation

## How to think about it

A UI is a function of state, and most state is *derived* from other state or
from asynchronous data. The usual React answer (`useEffect` + `fetch` +
`useState` + manual loading flags + manual refetch after a mutation) scatters
three concerns: when to fetch, what the data looks like while it is not there
yet, and who must refetch when something changes. `effect/reactivity` makes
each one explicit and moves all three out of components.

- An **Atom** is a node in a dependency graph: a value, or a function that
  reads other atoms with `get(other)`. When an input changes, dependents
  recompute. An atom built from an `Effect` or `Stream` holds an
  **`AsyncResult`**: `Initial` (nothing yet), `Success` or `Failure`, each
  carrying a `waiting` flag and (on failure) the previous success. Loading
  and error states are values you render, not booleans you juggle.
- An **`AtomRegistry`** is the runtime that stores atom values and
  subscriptions. Atoms are *definitions*; they have no state until a registry
  reads them. A registry disposes atoms nobody observes (unless
  `Atom.keepAlive`), cancelling their in-flight Effect fibers. This is how
  unmounting a view interrupts its request.
- **`Atom.runtime(layer)`** is the bridge to the rest of Effect: it builds
  your services once per registry and lets atoms and functions use them, so
  an atom's Effect can `yield* Todos` like any other Effect. The `R` of an
  atom Effect is the layer's output, nothing else.
- **Reactivity keys** decouple writers from readers. A mutation says "I changed
  `todos`" (`reactivityKeys: ["todos"]`); any query atom tagged
  `Atom.withReactivity(["todos"])` refetches. Neither knows the other exists.

Coming from React Query/SWR: keys are explicit and shared by queries and
mutations, and the cache lives in the registry, not in a module global. From
RxJS: an atom is a lazily evaluated, auto-disposed, glitch-free derived value,
not a stream you must subscribe to and unsubscribe from. From Redux: no
reducers; derived state is a function of other atoms, and async is built in.

The module is unstable. The framework adapters are separate packages that
pin the same `effect` version; keep them aligned.

## Choose

| Situation | Use | Why |
| --- | --- | --- |
| Local UI state (a toggle, a text field) | `Atom.make(initialValue)` | writable atom, no Effect needed |
| State derived from other state | `Atom.make((get) => ...)` | recomputes when inputs change |
| Data from a service or HTTP | `runtime.atom(effect)` | `AsyncResult`, service access, interruption on dispose |
| A user action that calls a service | `runtime.fn<Arg>()(effect, { reactivityKeys })` | write the argument to run; state is an `AsyncResult` |
| Refetch queries after a mutation | `reactivityKeys` on the `fn` + `Atom.withReactivity(keys)` on queries | decoupled invalidation |
| One atom per id (user, row) | `Atom.family(id => atom)` | memoized, same id gives the same atom |
| Typed HTTP client as atoms | `AtomHttpApi.Service` | query/mutation atoms from an `HttpApi` |
| Typed RPC client as atoms | `AtomRpc.Service` | same for `effect/rpc` groups |
| Server-render then continue on the client | `Atom.serializable` + `Hydration` | validated state transfer |
| A mutable object whose fields UI binds to | `AtomRef` | fine-grained refs (`AtomRef.make`, `collection`) |
| Cross-component domain logic, no UI | plain services + `Ref` ([services](../services/guide.md), [state](../state/guide.md)) | atoms are for *view* state |
| Server-side caching/dedup | [persistence](../persistence/guide.md) / `Cache` | registries are per UI lifetime |
| Event-sourced data that must refresh the UI | `EventLog.groupReactivity` ([eventlog](../eventlog/guide.md)) | feeds the same keys |

## Recipe

### 1. The pitfall: fetching in components

```ts skip
// WRONG: effect never interrupted, no shared cache, refetch is manual,
// the error is `unknown`, and loading/error flags can disagree.
function TodoList() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    fetch("/todos").then((r) => r.json()).then(setTodos).finally(() => setLoading(false))
  }, [])
  const complete = (id: string) => fetch(`/todos/${id}`, { method: "PUT" }).then(/* refetch? */)
  /* ... */
}
```

### 2. Services, a runtime, a query atom and a mutation

Start from the domain, with no UI import. The atoms are a thin layer on top.

```ts import.meta.vitest name="references/reactivity/guide.md#2"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity"

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  id: Schema.String
}) {}

export interface Todo {
  readonly id: string
  readonly title: string
  readonly done: boolean
}

// A service: the only thing atoms know about the outside world.
export class Todos extends Context.Service<Todos, {
  readonly list: Effect.Effect<ReadonlyArray<Todo>>
  complete(id: string): Effect.Effect<void, NotFound>
}>()("app/Todos") {
  // In production this layer would wrap HttpClient/RPC; tests use this one.
  static readonly layerMemory = Layer.effect(
    Todos,
    Effect.gen(function*() {
      const rows = yield* Ref.make<ReadonlyArray<Todo>>([
        { id: "1", title: "write skill", done: false }
      ])
      return Todos.of({
        list: Ref.get(rows),
        complete: (id) =>
          Effect.gen(function*() {
            const all = yield* Ref.get(rows)
            if (!all.some((todo) => todo.id === id)) {
              return yield* new NotFound({ id })
            }
            yield* Ref.set(rows, all.map((t) => (t.id === id ? { ...t, done: true } : t)))
          })
      })
    })
  )
}

// One runtime per layer. It builds Todos once per registry and shares it.
// Define it at module level: it is a definition, not running state.
export const runtime = Atom.runtime(Todos.layerMemory)

// Query atom. Type: Atom<AsyncResult<ReadonlyArray<Todo>, never>>.
// `withReactivity(["todos"])` re-runs it whenever "todos" is invalidated.
export const todosAtom = runtime.atom(Todos.use((todos) => todos.list)).pipe(
  Atom.withReactivity(["todos"])
)

// Derived state is a plain function of other atoms. It recomputes only when
// todosAtom changes, and it never throws: it handles all three AsyncResult
// states explicitly.
export const remainingAtom = Atom.make((get) => {
  const result = get(todosAtom)
  return AsyncResult.isSuccess(result)
    ? result.value.filter((todo) => !todo.done).length
    : 0
})

// Mutation as an atom. Writing an id to it runs the Effect. Its state is an
// AsyncResult<void, NotFound>: the typed failure reaches the UI as data.
// On success it invalidates "todos", which refetches todosAtom.
export const completeTodo = runtime.fn<string>()(
  (id) => Todos.use((todos) => todos.complete(id)),
  { reactivityKeys: ["todos"] }
)

// Rendering an AsyncResult without unions of booleans.
export const describe = (result: AsyncResult.AsyncResult<ReadonlyArray<Todo>>) =>
  AsyncResult.match(result, {
    onInitial: () => "loading",
    onFailure: () => "failed",
    onSuccess: (success) =>
      `${success.value.length} todos${success.waiting ? " (refreshing)" : ""}`
  })

// Drive the graph with a plain registry, no UI. `mount` keeps atoms alive.
const registry = AtomRegistry.make()
registry.mount(todosAtom)
registry.mount(completeTodo)

const before = [describe(registry.get(todosAtom)), registry.get(remainingAtom)]
registry.set(completeTodo, "1") // runs the mutation, then invalidates "todos"
const after = [describe(registry.get(todosAtom)), registry.get(remainingAtom)]
registry.dispose()

;[before, after] // => [["1 todos", 1], ["1 todos", 0]]
```

Notes on what the types are telling you:

- `runtime.atom(effect)`: the Effect's requirements may include only the
  runtime's services (here `Todos`), `Scope` and `AtomRegistry`. A service not
  in the layer is a compile error. This is the same `R` discipline as
  anywhere else in Effect.
- A plain `Atom.make(effect)` (no runtime) can only use `Scope | AtomRegistry`.
  Use it for effects with no services.
- `Atom.withReactivity` and `Atom.runtime` share one default factory, so they
  share one `Reactivity` service. If you create your own factory with
  `Atom.context()`, use *its* `withReactivity` and `runtime`, or invalidation
  will not reach your queries.
- `waiting: true` on a `Success` means "showing the previous value while
  refetching". Render stale data with a spinner instead of blanking the view.

### Running it without a UI

Atoms are plain values and a registry is plain code, so the whole graph works
in Node (CLIs, servers, workers) and in tests with no framework: build an
`AtomRegistry`, `mount` the atoms a view would observe, write to function
atoms with `registry.set`, and read with `registry.get` or
`AtomRegistry.getResult`. A complete example is in [Testing it](#testing-it).

### 3. Hydration: state crossing the server/client boundary

A serialized atom value is untrusted input. `Atom.serializable` requires a key
and a `Schema`, so hydrated data is decoded rather than cast.

```ts import.meta.vitest name="references/reactivity/guide.md#3"
import { Context, Effect, Layer, Schema } from "effect"
import { Atom, AtomRegistry, AsyncResult, Hydration } from "effect/reactivity"

const User = Schema.Struct({ id: Schema.String, name: Schema.String })
class Missing extends Schema.TaggedError<Missing>()("Missing", { id: Schema.String }) {}

class Users extends Context.Service<Users, {
  get(id: string): Effect.Effect<typeof User.Type, Missing>
}>()("app/Users") {
  static readonly layerMemory = Layer.succeed(Users)({
    get: (id) => (id === "u1" ? Effect.succeed({ id, name: "Ada" }) : Effect.fail(new Missing({ id })))
  })
}

const runtime = Atom.runtime(Users.layerMemory)

// One atom per user id; the serialization key must be unique per atom.
export const userAtom = Atom.family((id: string) =>
  runtime.atom(Users.use((users) => users.get(id))).pipe(
    Atom.serializable({
      key: `user:${id}`,
      schema: AsyncResult.Schema({ success: User, error: Missing })
    })
  )
)

const program = Effect.gen(function*() {
  // "Server": render, then dehydrate everything that is serializable.
  const server = yield* AtomRegistry.AtomRegistry
  yield* AtomRegistry.getResult(server, userAtom("u1"))
  const state = Hydration.dehydrate(server) // JSON-safe array

  // "Client": a fresh registry preloaded from that state. No request is made
  // for userAtom("u1") because a decoded value is already there.
  const client = AtomRegistry.make()
  Hydration.hydrate(client, state)
  const result = AsyncResult.getOrElse(client.get(userAtom("u1")), () => undefined)
  client.dispose()
  return result
}).pipe(Effect.provide(AtomRegistry.layer))

const hydrated = await Effect.runPromise(program)
hydrated // => { id: "u1", name: "Ada" }
```

`Hydration.dehydrate` skips `Initial` values by default
(`encodeInitialAs: "ignore"`); pass `"promise"` to stream pending results.
Hydrated data that no longer decodes (an old deploy's shape) is skipped
instead of throwing, so the atom just loads normally (4.1).

By default a hydrated or seeded *effect* atom still runs its effect once on
mount, because the dependencies it reads are only known after it runs. When
the seed is authoritative, opt out with `skipInitialRun`: on
`Atom.serializable({ key, schema, skipInitialRun: true })` for hydration, or
as the third argument of `Atom.initialValue` for registry `initialValues`
(4.1). The atom keeps the seed until it is refreshed or a dependency changes.

```ts import.meta.vitest name="references/reactivity/guide.md#3b"
import { Effect } from "effect"
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity"

const makeProfile = () => {
  const calls = { n: 0 }
  const profile = Atom.make(Effect.sync(() => {
    calls.n++
    return "loaded from the service"
  }))
  return { calls, profile }
}

// Default: the seed is shown, but the effect still runs on mount.
const plain = makeProfile()
const plainRegistry = AtomRegistry.make({
  initialValues: [Atom.initialValue(plain.profile, AsyncResult.success("seeded"))]
})
plainRegistry.mount(plain.profile)

// skipInitialRun: the seed stands and the service is never called.
const skipped = makeProfile()
const skippedRegistry = AtomRegistry.make({
  initialValues: [Atom.initialValue(skipped.profile, AsyncResult.success("seeded"), { skipInitialRun: true })]
})
skippedRegistry.mount(skipped.profile)

const summary = {
  plainCalls: plain.calls.n,
  skippedCalls: skipped.calls.n,
  skippedValue: AsyncResult.getOrElse(skippedRegistry.get(skipped.profile), () => "")
}
plainRegistry.dispose()
skippedRegistry.dispose()
summary // => { plainCalls: 1, skippedCalls: 0, skippedValue: "seeded" }
```

### 4. Typed clients as atoms

If you already have an `HttpApi` or `RpcGroup` contract (see [http-api](../http-api/guide.md),
[rpc](../rpc/guide.md)), do not hand-write fetch atoms. `AtomHttpApi.Service` and
`AtomRpc.Service` build a service whose `.query(...)` returns an atom and
whose `.mutation(...)` returns a function atom, both typed from the contract
(payload, success, and error schemas). `reactivityKeys` on a query and on a
mutation connect them exactly as in step 2.

This fence is typechecked, not executed, because the protocol opens HTTP
connections.

```ts
import { Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { Atom, AtomRpc } from "effect/reactivity"
import { Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/rpc"

class TodoRpcs extends RpcGroup.make(
  Rpc.make("ListTodos", { success: Schema.Array(Schema.String) }),
  Rpc.make("AddTodo", { payload: { title: Schema.String }, success: Schema.String })
) {}

// The transport (socket, HTTP, worker) is chosen by the app. Here: JSON over
// HTTP; the server must use the same serialization.
const ProtocolLayer = RpcClient.layerProtocolHttp({ url: "https://api.example.com/rpc" }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerJson)
)

export class TodoClient extends AtomRpc.Service<TodoClient>()("app/TodoClient", {
  group: TodoRpcs,
  protocol: ProtocolLayer
}) {}

// Query atom: AsyncResult<ReadonlyArray<string>, RpcClientError>.
export const listAtom = TodoClient.query("ListTodos", undefined, {
  reactivityKeys: ["todos"]
})

// Mutation atom: write { payload, reactivityKeys } to run it.
export const addTodo = TodoClient.mutation("AddTodo")

export const keepList = Atom.keepAlive(listAtom)
```

### 5. Typed reactivity keys (optional)

By default keys are free-form (`["todos"]`, `{ todos: ["1"] }`), so a typo in
one place silently stops invalidation. An *application* (never a library) can
declare its keys by augmenting `Reactivity.Keys`; every public entry point
(`Reactivity.mutation/query/stream/invalidate`, `Atom.withReactivity`,
`reactivityKeys` options, `AtomHttpApi`, `AtomRpc`, `SqlClient.reactive`,
`EventLog.groupReactivity`) then accepts only declared names, and record ids
must match the declared id type. Declare a key as `never` if it is only used
in array form (4.1).

Not compiled by this repository's snippet check: a module augmentation is
program-wide, so declaring keys here would reject every other example's free-form
keys. It was verified in a separate project.

```ts skip
import { Effect } from "effect"
import { Reactivity } from "effect/reactivity"

declare module "effect/reactivity/Reactivity" {
  interface Keys {
    readonly todos: string // ids are strings: { todos: ["1"] } hits "todos" and "todos:1"
    readonly settings: never // array form only
  }
}

export const rename = Effect.succeed("saved").pipe(
  Reactivity.mutation({ todos: ["1"] }),
  Effect.andThen(Reactivity.invalidate(["settings"]))
)

// @ts-expect-error "todoz" is not a declared key
export const typo = Reactivity.invalidate(["todoz"])
```

### 6. Binding to a framework (unverified here)

`@effect/atom-react`, `@effect/atom-solid` and `@effect/atom-vue` are not
installed in this repository, so the following is **not compiled**; it was
read from `@effect/atom-react` declarations of an earlier 4.0.x release. Check
your installed version's `.d.ts` before relying on it.

```tsx skip
import { RegistryProvider, useAtomValue, useAtomSet, useAtomSuspense } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { completeTodo, todosAtom } from "./model.ts"

export const App = () => (
  // One registry per app (or per SSR request). Do not create it in a component.
  <RegistryProvider>
    <TodoList />
  </RegistryProvider>
)

function TodoList() {
  const result = useAtomValue(todosAtom)            // re-renders on change
  const complete = useAtomSet(completeTodo)          // (id) => void
  return AsyncResult.match(result, {
    onInitial: () => <p>Loading...</p>,
    onFailure: () => <p>Failed</p>,
    onSuccess: ({ value }) => (
      <ul>{value.map((t) => <li key={t.id} onClick={() => complete(t.id)}>{t.title}</li>)}</ul>
    )
  })
}
// `useAtomSuspense(todosAtom)` returns the success and suspends/throws instead.
```

## Anti-patterns

**Fetching in render or `useEffect` instead of an atom.** Nothing cancels the
request when the view unmounts, and every component re-implements loading
and error state.

```ts skip
useEffect(() => { Effect.runPromise(todos.list).then(setState) }, [])
```

Right: `runtime.atom(...)` read with the hook; the registry interrupts the
fiber when no one observes the atom.

**`Atom.make(effect)` for an Effect that needs services.** It only provides
`Scope | AtomRegistry`, so `Todos` is an unsatisfied requirement (a compile
error), and "fixing" it with a cast gives a runtime defect.

```ts skip
const todosAtom = Atom.make(Todos.use((t) => t.list)) // R = Todos: type error
```

Right: `Atom.runtime(layer).atom(...)`, so the layer supplies `Todos`.

**Calling `Effect.runPromise` inside an atom or handler.** It escapes the
registry's interruption and the runtime's services.

```ts skip
const a = Atom.make(() => { Effect.runPromise(todos.list); return 0 })
```

Right: return the Effect from the atom or the `fn`; the registry runs it.

**Mutating then refetching by hand.**

```ts skip
await complete(id); await refetchTodos()   // every caller must remember
```

Right: `reactivityKeys: ["todos"]` on the mutation and
`Atom.withReactivity(["todos"])` on queries; the pairing lives in one place.

**Ignoring `waiting` and the `Initial` state.** Reading `result.value`
without checking the tag throws or shows a blank flash on refetch.

```ts skip
const count = (get(todosAtom) as any).value.length
```

Right: `AsyncResult.match`, or `AsyncResult.getOrElse(result, () => [])`, and
show stale data while `waiting`.

**Creating a registry (or runtime) per render.** State and caches reset every
time and layers are rebuilt.

```ts skip
function App() { const registry = AtomRegistry.make() /* ... */ }
```

Right: one `RegistryProvider` at the root (or `AtomRegistry.layer` in a scope
you own), and atoms/runtimes defined at module level.

**Hydrating data you did not validate.** A cast of serialized JSON into an
atom value trusts the page's script tags and old deploys.

```ts skip
registry.set(userAtom, JSON.parse(window.__STATE__) as User)
```

Right: `Atom.serializable({ key, schema })` and `Hydration.hydrate`, which
decode with the schema; give every atom a stable key and version the schema.

**Reading an unobserved atom and expecting it to keep state.** With no
subscriber (and no `Atom.keepAlive`), the atom is disposed and a later read
starts over; a mutation's result is lost before you can look at it.

```ts skip
registry.set(completeTodo, "1"); registry.get(completeTodo) // may be Initial
```

Right: `registry.mount(atom)` (or `subscribe`) for as long as you care, or
wrap long-lived atoms in `Atom.keepAlive`.

## Testing it

You do not need a DOM or a framework. Build an `AtomRegistry`, mount the
atoms a view would observe, drive them with `registry.set`, and assert on
`registry.get` and `AsyncResult` tags. Swap the layer under `Atom.runtime`
for a fake: runtimes are values, so make a test runtime from a test layer.

```ts import.meta.vitest name="references/reactivity/guide.md#14"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity"

class Denied extends Schema.TaggedError<Denied>()("Denied", {}) {}

class Counter extends Context.Service<Counter, {
  readonly current: Effect.Effect<number>
  increment(by: number): Effect.Effect<number, Denied>
}>()("app/Counter") {
  static readonly layerMemory = Layer.effect(
    Counter,
    Effect.gen(function*() {
      const n = yield* Ref.make(0)
      return Counter.of({
        current: Ref.get(n),
        increment: (by) =>
          by < 0 ? Effect.fail(new Denied()) : Ref.updateAndGet(n, (x) => x + by)
      })
    })
  )
}

const runtime = Atom.runtime(Counter.layerMemory)
const counterAtom = runtime.atom(Counter.use((c) => c.current)).pipe(
  Atom.withReactivity(["counter"])
)
const increment = runtime.fn<number>()(
  (by) => Counter.use((c) => c.increment(by)),
  { reactivityKeys: ["counter"] }
)

const test = Effect.gen(function*() {
  const registry = yield* AtomRegistry.AtomRegistry
  const stops = [registry.mount(counterAtom), registry.mount(increment)]

  const initial = yield* AtomRegistry.getResult(registry, counterAtom)

  registry.set(increment, 5)
  // The mutation invalidated "counter", so the query atom refetched.
  const afterIncrement = AsyncResult.getOrElse(registry.get(counterAtom), () => -1)

  registry.set(increment, -1)
  const failure = registry.get(increment)
  const denied = AsyncResult.isFailure(failure) ? AsyncResult.error(failure) : Option.none()

  for (const stop of stops) stop()
  return { initial, afterIncrement, denied: Option.map(denied, (e) => e._tag) }
}).pipe(Effect.provide(AtomRegistry.layer))

const result = await Effect.runPromise(test)
result // => { initial: 0, afterIncrement: 5, denied: Option.some("Denied") }
```

If an atom does real async work, `AtomRegistry.getResult(registry, atom)`
waits for it (it returns an Effect). Atoms run their Effects on the registry's
own fibers, so `TestClock` does **not** reach inside them. The timer-based
combinators `Atom.debounce`, `Atom.swr`'s `staleTime` and `setIdleTTL` use real
`setTimeout`: drive them with `vi.useFakeTimers()` instead.

### With `@effect/vitest`

`it.effect` wraps an Effect test (and provides `TestClock` for code *you* run
in the test). Combine it with fake timers for debounced atoms:

```ts
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { assert, describe, vi } from "vitest"

describe("search box", () => {
  it.effect("debounces keystrokes into one update", () =>
    Effect.gen(function*() {
      vi.useFakeTimers()
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()))

      const registry = yield* AtomRegistry.AtomRegistry
      const query = Atom.make("")
      const debounced = Atom.debounce(query, "300 millis")
      const seen: Array<string> = []
      registry.subscribe(debounced, (value) => seen.push(value))

      for (const typed of ["e", "ef", "eff"]) registry.set(query, typed)
      assert.deepStrictEqual(seen, []) // nothing yet: still inside the window

      vi.advanceTimersByTime(300)
      assert.deepStrictEqual(seen, ["eff"]) // one update with the last value
    }).pipe(Effect.provide(AtomRegistry.layer)))
})
```

## Boundaries

- [services](../services/guide.md) owns the services and layers the runtime builds; keep
  them framework-free. [state](../state/guide.md) owns `Ref`/`SubscriptionRef`
  (`Atom.subscriptionRef` adapts a `SubscriptionRef` into an atom).
- [http-api](../http-api/guide.md) and [rpc](../rpc/guide.md) own the contracts `AtomHttpApi` and
  `AtomRpc` consume; [schema](../schema/guide.md) owns the schemas used for hydration
  (`Atom.serializable`, `AsyncResult.Schema`).
- [eventlog](../eventlog/guide.md) feeds invalidation: `EventLog.groupReactivity` uses the
  same key scheme as `reactivityKeys` (`"key"` and `"key:id"` forms).
- [streams](../streams/guide.md) owns `Stream`; `Atom.make(stream)` and `runtime.pull` expose
  one as an atom.
- [testing](../testing/guide.md) owns `TestClock` and test layers.
- Errors cross as data: the Effect's `E` becomes the `Failure` of the
  `AsyncResult`; defects stay defects. Resources: each atom's Effect has a
  `Scope` that closes when the atom is disposed, so `acquireRelease` inside an
  atom is released on unmount.

## Changed in 4.1

- `Reactivity.Keys` / `Reactivity.KeysInput`: optional app-wide typed keys
  (step 5). `reactivityKeys` options everywhere now take `KeysInput`.
- `skipInitialRun` for seeded effect and stream atoms: third argument of
  `Atom.initialValue` (`Atom.InitialValueOptions`) and an option of
  `Atom.serializable`. Registry `initialValues` tuples may carry it.
- Hydration is more forgiving: values that fail to decode are skipped, and a
  hydrated value only replaces a node when it is newer than what it holds.
- `Reactivity.invalidate` runs each handler once per invalidation even if
  several keys match; effect atoms report finalizer failures in the log
  instead of swallowing them.
- `AsyncResult.isInterrupted` is now a plain `boolean` (no longer a type guard
  to `Failure`); `AsyncResult.flatMap`'s callback returns `AsyncResult<B, E2>`,
  and `AsyncResult.all` keeps the previous success when a failure arrives.
- `AtomRpc` and `AtomHttpApi` mutation atoms derive their serialization key
  from the service id as well, so two clients with the same endpoint names no
  longer collide; `AtomHttpApi` defaults the response mode to `"decoded-only"`.

## References

- [references/api.md](api.md): verified signatures for `Atom`,
  `AtomRegistry`, `AsyncResult`, `Reactivity`, `AtomRef` and `Hydration`.
- [Atom API](https://effect.website/docs/v4/api/effect/reactivity/Atom)
- [AtomRegistry API](https://effect.website/docs/v4/api/effect/reactivity/AtomRegistry)
- [AsyncResult API](https://effect.website/docs/v4/api/effect/reactivity/AsyncResult)
- [Reactivity API](https://effect.website/docs/v4/api/effect/reactivity/Reactivity)
- [Pinned Atom source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/reactivity/Atom.ts)
- [Pinned Reactivity source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/reactivity/Reactivity.ts)
- [React bindings](https://github.com/Effect-TS/effect/tree/effect%404.1.2/packages/atom/react)
- [Solid bindings](https://github.com/Effect-TS/effect/tree/effect%404.1.2/packages/atom/solid)
- [Vue bindings](https://github.com/Effect-TS/effect/tree/effect%404.1.2/packages/atom/vue)
