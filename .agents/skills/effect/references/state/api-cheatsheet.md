# State API families (effect@4.1.2)

Signatures verified in `node_modules/effect/dist/{Ref,SynchronizedRef,SubscriptionRef,ScopedRef,RcRef,RcMap,MutableRef,TxRef}.d.ts`.

## Naming rules shared by Ref, SynchronizedRef and SubscriptionRef

| Family | Shape | Returns |
| --- | --- | --- |
| `get` | `Effect<A>` | the current value |
| `set(value)` / `setAndGet(value)` / `getAndSet(value)` | replace | `void` / new / old |
| `update(f)` / `updateAndGet(f)` / `getAndUpdate(f)` | `f: A => A` | `void` / new / old |
| `modify(f)` | `f: A => readonly [B, A]` | `B` (the result you computed) |
| `...Some` (`updateSome`, `modifySome`, ...) | `f` returns `Option` of the next state; `None` leaves it unchanged | as above |
| `...Effect` (`updateEffect`, `modifyEffect`, ...) | `f` returns an `Effect`; **only on SynchronizedRef and SubscriptionRef** | adds `E` and `R` of `f` |
| `makeUnsafe(value)` / `getUnsafe` | synchronous, outside Effect | for module-internal wiring only |

`Ref` has no `...Effect` variants. All functions are dual: `Ref.update(ref, f)` or
`ref.pipe(Ref.update(f))`. The v3 `unsafeMake` is `makeUnsafe` in v4.

`Ref.make(v)`, `SynchronizedRef.make(v)` and `SubscriptionRef.make(v)` are
`Effect`s: create them inside a Layer or `Effect.gen`, never at module scope.

## SubscriptionRef

`SubscriptionRef.changes(ref)` is `Stream<A>`: current value first, then every
update. Writes are serialized by a semaphore and published to an unbounded
`PubSub` with `replay: 1`, so a slow subscriber never blocks writers but its
backlog grows and it sees every intermediate value. If you need only "wait until predicate", use
`changes` + `Stream.filter` + `Stream.take(1)` + `Stream.runDrain`.

## ScopedRef

| API | Meaning |
| --- | --- |
| `ScopedRef.make(() => initial)` | holds a plain initial value (needs `Scope`) |
| `ScopedRef.fromAcquire(acquire)` | holds the result of a scoped acquire |
| `ScopedRef.get(ref)` | current value |
| `ScopedRef.set(ref, acquire)` | acquire new, then release old; `R` excludes `Scope` |

## RcRef and RcMap

| API | Meaning |
| --- | --- |
| `RcRef.make({ acquire, idleTimeToLive? })` | `Effect<RcRef<A, E>, never, R \| Scope>` |
| `RcRef.get(ref)` | `Effect<A, E, Scope>`; acquires on first use, shares afterwards, releases when the last scope using it closes (after `idleTimeToLive`) |
| `RcRef.invalidate(ref)` | force re-acquire on next `get` |
| `RcMap.make({ lookup, idleTimeToLive?, capacity? })` | keyed variant; with `capacity` the error type gains `Cause.ExceededCapacityError` |
| `RcMap.get(map, key)`, `getOption`, `has`, `keys`, `touch`, `invalidate` | |

## MutableRef and other mutable collections

`MutableRef.make`, `get`, `set`, `update`, `updateAndGet`, `getAndSet`,
`compareAndSet(ref, old, new)`, `increment`/`decrement` (and `AndGet`/`getAnd`
variants), `toggle`. These are plain synchronous mutations. Also available:
`MutableHashMap`, `MutableHashSet`, `MutableList`. They are safe only because JS
runs one synchronous step at a time; you must not hold a read across a `yield*`.

## Transactional family (since 4.0.0)

`TxRef`, `TxChunk`, `TxHashMap`, `TxHashSet`, `TxQueue`, `TxPubSub`, `TxPriorityQueue`,
`TxDeferred`, `TxSemaphore`, `TxReentrantLock`, `TxSubscriptionRef`. Operations on
them are ordinary `Effect`s that join an enclosing `Effect.tx(...)`; `Effect.txRetry`
aborts the attempt and re-runs it when any accessed Tx value changes. See
[rc-and-transactions.md](rc-and-transactions.md).
