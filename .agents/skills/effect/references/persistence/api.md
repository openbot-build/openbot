# effect/persistence: verified reference

Checked against `node_modules/effect/src/persistence/*.ts` (effect@4.1.2). All
modules are `@stability unstable`; import as
`import { CircuitBreaker, KeyValueStore, Persistable, PersistedCache, PersistedQueue, Persistence, RateLimiter, Redis, UserDirectories } from "effect/persistence"`.

## Store layer matrix

| Tool | Requires | Memory (tests) | File / local | SQL (needs `SqlClient`) | Redis (needs `Redis`) |
| --- | --- | --- | --- | --- | --- |
| `KeyValueStore` | none | `layerMemory` | `layerFileSystem(dir)` (needs `FileSystem`, `Path`), `layerStorage(() => Storage)` | `layerSql({ table? })` (default table `effect_key_value_store`) | none |
| `Persistence` (for `PersistedCache`) | a backing store | `layerMemory` | `layerKvs` (over any `KeyValueStore`) | `layerSql` (shared table), `layerSqlMultiTable` (table per storeId) | `layerRedis` |
| `PersistedQueueStore` -> `PersistedQueue.layer` | store | `layerStoreMemory` | none | `layerStoreSql({ tableName?, pollInterval?, lockRefreshInterval?, lockExpiration? })` | `layerStoreRedis({ prefix?, pollInterval?, lockRefreshInterval?, lockExpiration? })` |
| `RateLimiterStore` -> `RateLimiter.layer` | store | `layerStoreMemory` | none | none | `layerStoreRedis({ prefix? })`, `layerStoreRedisConfig(Config.Wrap<...>)` |

Redis client: `NodeRedis.layer(options?)` / `NodeRedis.layerConfig(...)` from
`@effect/platform-node` provide `Redis.Redis`. The `Redis` service itself
(`send`, `subscribe`, `eval`) is in `effect/persistence/Redis`.

Composition shape: `PersistedQueue.layer` is `Layer<PersistedQueueFactory, never,
PersistedQueueStore>`, so `PersistedQueue.layer.pipe(Layer.provide(PersistedQueue.layerStoreSql()))`.
Same for `RateLimiter.layer` / `RateLimiterStore`.

## KeyValueStore

Service `KeyValueStore.KeyValueStore` (a `Context.Service`). Members:
`get(key): string | undefined`, `getUint8Array`, `set(key, string | Uint8Array)`,
`remove`, `clear`, `size`, `has`, `isEmpty`, `modify(key, f)`,
`modifyUint8Array`. All fail with `KeyValueStoreError { message, method, key?, cause? }`.

- `prefix(p)(store)` / `prefix(store, p)`: key-namespaced view. `keys`, `size`,
  `isEmpty` and `clear` see only the prefixed entries (`keys` strips the prefix;
  `clear` delegates to `clearPrefix`).
- `toSchemaStore(store, schema)`: `SchemaStore` with `get -> Option<T>`,
  `set`, `modify`, `remove`, `has`, ... Errors add `SchemaError`. Values are
  stored as a JSON string using the schema's JSON codec.
- `make(options)` / `makeStringOnly(options)`: build your own backend; `has`,
  `isEmpty`, `clearPrefix`, `modify` are derived (`clearPrefix` from `keys` +
  `remove`, so provide `keys`).
- `layerFileSystem`: one file per key, key percent-encoded; `.`/`..`/empty keys
  rejected; `clear` deletes the directory recursively.

`modify` is get-then-set in the default implementation: not atomic across
processes. On a missing key it does nothing and returns `undefined`.

## Persistable and PersistedCache

```ts skip
class GetUser extends Persistable.Class<{ payload: { readonly id: string } }>()("GetUser", {
  primaryKey: (payload) => `user/${payload.id}`,
  success: User,        // Schema, default Schema.Void
  error: UserNotFound   // Schema, default Schema.Never
}) {}
```

The class is also a `Request.Request`, with error channel
`E | PersistenceError | SchemaError` unless `requestError` is configured.

`PersistedCache.make(lookup, { storeId, timeToLive, inMemoryCapacity?, inMemoryTTL?, requireServicesAt? })`
returns `Effect<PersistedCache<K>, never, Persistence | Scope | R>`:

- `timeToLive: (exit, request) => Duration.Input`; zero or negative skips the write.
- Two tiers: an in-memory `Cache` (default capacity 1024, TTL 10 seconds,
  override with `inMemoryTTL`) in front of the `Persistence` store. A hit in
  neither calls `lookup`, and the resulting `Exit` (success *or* typed
  failure) is stored.
- A stored entry that fails to decode (for example after a schema change) is
  treated as a miss and the lookup runs again.
- `get(request)`, `invalidate(request)` (removes from store and memory),
  `inMemory` (the underlying `Cache`).
- Keep `lookup` failures typed (`E`): the cache stores the whole `Exit`, and what
  it does with defects was not verified here.

`Persistence.Persistence.make({ storeId, timeToLive? })` gives a lower-level
scoped `PersistenceStore` with `get/getMany/set/setMany/remove/clear` over
`Exit` values. Errors: `PersistenceError { message, cause? }`.

## PersistedQueue

- `PersistedQueue.make({ name, schema, maxAttempts?, retrySchedule? })`: needs
  `PersistedQueueFactory`. `maxAttempts` default 10. Default `retrySchedule`:
  exponential from 1 second, capped at 5 minutes. The schedule's input is the
  attempt number and is replayed from the persisted attempt count, so delays
  are consistent across processes.
- `queue.offer(value, { id?, delay? })`: returns the id. `delay` (Duration
  input) postpones the first delivery; it is ignored when the `id` already
  exists, a zero/negative delay means immediate, and an infinite delay stores
  nothing. A supplied id is the dedupe
  key: re-offering an existing id (even a completed one) is ignored until
  cleanup removes it. Without an id, a random UUID is used.
- `queue.take((value, { id, attempts }) => effect)`: waits for an item, runs
  the handler; success acknowledges, failure (typed error, defect) requeues
  after the retry delay or marks the item failed after `maxAttempts`.
  `attempts` is 1-based and counted at claim time, so a crash still consumes
  an attempt (interrupting a running handler releases the item without
  consuming one). Items that fail to decode are marked failed immediately and
  skipped. The handler's error type flows out of `take`.
- `PersistedQueue.layerCleanup({ interval? (1h), timeToLive? (30 days),
  failedTimeToLive? })`: run in one instance. Failed items are the dead-letter
  record and are never removed unless `failedTimeToLive` is set.
- Error: `PersistedQueueError { message, cause? }`.
- The memory store scans delayed elements on every take loop: fine for tests,
  not for large delayed backlogs.

## RateLimiter

`RateLimiter.RateLimiter` service: `consume({ key, limit, window, tokens?,
algorithm?: "fixed-window" | "token-bucket", onExceeded?: "fail" | "delay" })`
returns `{ delay, limit, remaining, resetAfter }`.

- `onExceeded: "fail"` (default) fails with `RateLimiterError` whose `reason`
  is `RateLimitExceeded { key, retryAfter, limit, remaining }` or
  `RateLimitStoreError`.
- `"delay"` returns the `delay` you must wait; `RateLimiter.sleep(limiter, opts)`
  sleeps it for you; `yield* RateLimiter.makeWithRateLimiter` gives
  `withLimiter(opts)(effect)` that delays the effect.
- `algorithm` defaults to `"fixed-window"`, `onExceeded` to `"fail"`, `tokens` to 1.
- A request for more `tokens` than `limit` can never succeed. `limit <= 0`
  skips the store: `"fail"` mode with `tokens > limit` fails with
  `RateLimitExceeded`; `"delay"` mode returns an infinite `delay`.
- Also present: `adaptiveConsume` / `adaptiveFeedback` for server-driven
  limits (read `AdaptiveConsumeOptions` in the source before using).

## CircuitBreaker (experimental, since 4.0.7)

- `CircuitBreaker.make({ tripPolicy, openDuration, maxOpenDuration?, onStoreError? })`
  (needs `CircuitBreakerStore | Scope`; `maxOpenDuration` default 1 hour,
  `onStoreError` default `"allow"`) or `CircuitBreaker.layer(sameOptions)`
  (provides the `CircuitBreaker` service).
- `tripPolicy`: `CircuitBreaker.consecutive(n)` or
  `CircuitBreaker.rate({ threshold?, size?, minimumCalls? })` (defaults 0.5, 100,
  `size`; invalid values throw `RangeError`). `openDuration` is a
  Duration or a `Schedule` over the opening count (cap it with `Schedule.upTo`).
- `breaker.execute({ key, classify?, onRejection?: "fail" | "allow" })(effect)`
  fails with `CircuitBreakerError` whose `reason` is `CircuitOpen { key, retryAfter }`,
  `CircuitHalfOpen`, or `CircuitBreakerStoreError`. `classify` returns
  `CircuitBreaker.success | ignored | failure({ retryAfter? })`.
- `breaker.state(key)` (`Closed | Open | HalfOpen`) and `breaker.transitions`
  (a `Stream`).
- Stores: `layerStoreMemory()`; `layerStoreRedis(...)` / `layerStoreRedisConfig(...)`.

## Redis additions

`reserve` (a member of the `Redis` service, `Effect<Connection, RedisError, Scope>`) yields a dedicated pooled `Connection { send, eval }` for the
scope (blocking commands); configure the pool with `PoolOptions`
(`maxConnections` 10, `minConnections` 0, `idleTimeout` 60 s, `acquireTimeout`).

## UserDirectories

`UserDirectories` service members: `home` and `config(app)`, `data(app)`,
`cache(app)`, `state(app)`, each an `Effect<string, PlatformError>`. Absolute
`XDG_*_HOME` variables win on every platform; otherwise `~/.config`,
`~/.local/share`, `~/.cache`, `~/.local/state` on Linux and the native
locations on macOS/Windows. Layers: `UserDirectories.layer`,
`layerPlatform(platform)`; `make(options?)`.

## SQL store notes

`Persistence.layerSqlMultiTable` derives table names `effect_persistence_${storeId}`
from the id with no escaping: no dots, no case-only differences, and ids short
enough for the database identifier limit (44 bytes on PostgreSQL). Aliased
stores share and clear each other's entries; `layerSql` (one shared table)
has no such limit.
