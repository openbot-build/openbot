# effect/reactivity cheat sheet

Signatures checked against `effect@4.1.2` sources
(`node_modules/effect/src/reactivity/*.ts`). Everything is imported from
`effect/reactivity`: `Atom`, `AtomRef`, `AtomRegistry`, `AsyncResult`,
`AtomHttpApi`, `AtomRpc`, `Hydration`, `Reactivity`.

## Atom constructors

| API | Meaning |
| --- | --- |
| `Atom.make(value)` | writable state atom, `Writable<A>` |
| `Atom.make((get) => a)` | derived atom; `get(other)` subscribes to `other` |
| `Atom.make(effect \| (get) => effect)` | `Atom<AsyncResult<A, E>>`; effect may need only `Scope \| AtomRegistry` |
| `Atom.make(stream \| (get) => stream)` | `Atom<AsyncResult<A, E \| NoSuchElementError>>`, latest element |
| `Atom.readable(read)` / `Atom.writable(read, write)` | low-level constructors |
| `Atom.runtime(layer)` | `AtomRuntime<R, E>`: `.atom`, `.fn`, `.pull`, `.subscriptionRef`, `.layer`; layer may use `AtomRegistry \| Reactivity` |
| `Atom.context(options?)` | create a separate runtime factory (own memo map, `addGlobalLayer`, `withReactivity`) |
| `runtime.fn<Arg>()(fn, { initialValue?, reactivityKeys?, concurrent? })` | `AtomResultFn<Arg, A, E>`; write the arg to run; also accepts `Atom.Reset` and `Atom.Interrupt` |
| `Atom.fn<Arg>()(fn, options?)` | same without services |
| `Atom.fnSync(fn, options?)` | synchronous function atom |
| `Atom.family(f)` | memoized atom factory (same arg, same atom) |
| `Atom.subscriptionRef(ref)` | writable atom over a `SubscriptionRef` |
| `Atom.pull(stream, options?)` / `runtime.pull` | paginated stream: write `void` to pull the next chunk; `PullResult` has `items` and `done` |
| `Atom.kvs({ runtime, key, schema, defaultValue, mode? })` | persisted value in a `KeyValueStore` |
| `Atom.searchParam(name, { schema? })` | URL search param atom (browser) |

## Atom combinators (all `pipe`able)

| API | Effect |
| --- | --- |
| `Atom.keepAlive(atom)` | never dispose when unobserved |
| `Atom.autoDispose(atom)` | undo `keepAlive` (default is auto-dispose) |
| `Atom.setIdleTTL(duration)` | dispose after being unobserved for that long |
| `Atom.withReactivity(keys)` | refetch when keys are invalidated |
| `Atom.map(f)` | derive a new atom, keeps writability |
| `Atom.debounce(duration)` | debounce updates (real `setTimeout`, so use `vi.useFakeTimers()` in tests) |
| `Atom.withFallback(otherAtom)` | use another `AsyncResult` while `Initial` |
| `Atom.swr({ staleTime, revalidateOnMount?, revalidateOnFocus?, focusSignal? })` | stale-while-revalidate |
| `Atom.refreshOnWindowFocus` / `Atom.makeRefreshOnSignal(signal)` | refresh triggers |
| `Atom.optimistic(atom)` + `Atom.optimisticFn({ reducer, fn })` | show an optimistic value until the real mutation settles |
| `Atom.serializable({ key, schema, skipInitialRun? })` | mark for `Hydration` (schema is decoded on hydrate; `skipInitialRun` keeps the hydrated value of an effect/stream atom instead of re-running it, 4.1) |
| `Atom.initialValue(atom, value, { skipInitialRun? })` | pair for `AtomRegistry.make({ initialValues })`; same option (4.1) |
| `Atom.withServerValue(read)` / `Atom.withServerValueInitial` | different value during SSR |
| `Atom.withLabel(name)` | debugging label |
| `Atom.batch(f)` | group writes into one notification |

Effects from `Atom.get`, `Atom.set`, `Atom.update`, `Atom.modify`,
`Atom.getResult`, `Atom.refresh`, `Atom.mount`, `Atom.toStream`,
`Atom.toStreamResult` run an atom operation inside an Effect that requires
`AtomRegistry`.

## AtomRegistry

`AtomRegistry.make(options?)` (`initialValues` as `[atom, value, options?]`
tuples, `scheduleTask`, `timeoutResolution`, `defaultIdleTTL`), `AtomRegistry.layer`,
`AtomRegistry.layerOptions(options)` (disposes with the scope),
`AtomRegistry.AtomRegistry` (the service tag).

Instance methods: `get(atom)`, `set(writable, value)`,
`update(writable, f)`, `modify(writable, f)`, `subscribe(atom, f, { immediate? })`
(returns unsubscribe), `mount(atom)` (returns unmount), `refresh(atom)`,
`reset()`, `dispose()`, `getNodes()`.

Effect-side helpers: `AtomRegistry.getResult(registry, atom, { suspendOnWaiting? })`
(waits for non-`Initial`), `toStream(registry, atom)`,
`toStreamResult(registry, atom)`, `mount(registry, atom)` (scoped).

A registry you create with `make` must be `dispose()`d; the layer versions
do it for you.

## AsyncResult

Constructors: `initial`, `success(value, { waiting? })`, `failure(cause)`,
`fail(error)`, `fromExit`, `waiting(result)` (mark waiting), `waitingFrom(Option<previous>)`.
Guards: `isInitial`, `isNotInitial`, `isSuccess`, `isFailure`, `isWaiting`,
`isInterrupted` (returns `boolean`, not a type guard).
Accessors: `value(r) : Option<A>`, `getOrElse(r, () => fallback)`,
`getOrThrow`, `error(r) : Option<E>`, `cause(r)`, `toExit(r)`.
Transforms: `map`, `flatMap`, `all`.
Rendering: `match(r, { onInitial, onFailure, onSuccess })`,
`matchWithError`, `matchWithWaiting`, and the fluent `builder(r)` with
`.onWaiting`, `.onInitial`, `.onInitialOrWaiting`, `.onSuccess(value, result)`,
`.onError(error, result)`, `.onErrorTag`, `.onErrorIf`, `.orElse`, `.orNull`,
`.render`, `.exhaustive` (only once every case is handled).
Schema: `AsyncResult.Schema({ success, error })` (used with
`Atom.serializable`).

## Reactivity service

`Reactivity.layer` provides it; atoms get it automatically. Functions:
`Reactivity.mutation(effect, keys)` (invalidate after success only),
`Reactivity.query(effect, keys)` (Queue of results, re-runs on
invalidation, scoped), `Reactivity.stream(effect, keys)`,
`Reactivity.invalidate(keys)`. Keys are an array (`["todos"]`) or a record
`{ todos: [id] }`, which invalidates both `"todos"` and `"todos:<id>"`. The
type of the `keys` argument everywhere is `Reactivity.KeysInput`; an app can
declare `Reactivity.Keys` by module augmentation to make unknown key names and
wrong id types a compile error (see the guide, step 5).

## AtomRef

`AtomRef.make(value)` -> `AtomRef<A>` with `.value`, `.set`, `.update`,
`.prop(key)` (child ref), `.map`, `.subscribe(f)` (returns unsubscribe), `.key`. `AtomRef.collection(items)`
adds `push`, `insertAt`, `remove`, `toArray`. Use for object-shaped form
state that components bind field by field.

```ts import.meta.vitest name="references/reactivity/api.md#1"
import { Atom, AtomRef, AtomRegistry } from "effect/reactivity"

// A writable atom, a derived atom and an AtomRef, driven by a plain registry.
const count = Atom.make(0)
const doubled = Atom.map(count, (n) => n * 2)
const form = AtomRef.make({ name: "Ada", age: 36 })

const registry = AtomRegistry.make()
const seen: Array<number> = []
const stop = registry.subscribe(doubled, (n) => seen.push(n))

registry.set(count, 2)
registry.update(count, (n) => n + 1)
// Notifications are scheduled, so intermediate values may be coalesced.
const last = seen[seen.length - 1]

form.prop("age").set(37)

stop()
const result = { doubled: registry.get(doubled), last, age: form.value.age }
registry.dispose()
result // => { doubled: 6, last: 6, age: 37 }
```
