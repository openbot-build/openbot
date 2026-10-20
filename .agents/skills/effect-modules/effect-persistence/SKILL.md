---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when choosing an Effect-backed key-value store, persisted cache or queue, shared rate limiter, TTL, or storage adapter across restarts.
metadata:
  github-path: skills/effect-persistence
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: d6c0ff41590fc9e7e0ef04e36e32d75293c3e96f
name: effect-persistence
---

# Effect persistence primitives

Use `effect/persistence` for key-value operations, encoded cached
exits, persisted background queues, and shared rate limits. SQL owns relational
queries and transactions; Ref owns in-process state. A memory store is useful
for tests but does not survive a restart or coordinate processes. These v4
modules are unstable and do not share v3 import paths.

## Provide the store at the application boundary

```ts
import { Effect } from "effect";
import { KeyValueStore } from "effect/persistence";

const program = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  yield* store.set("users/u1", "Ada");
  return yield* store.get("users/u1");
}).pipe(Effect.provide(KeyValueStore.layerMemory));
```

Select a shared file, SQL, or Redis-backed layer for the required durability
and process topology; store keys need stable namespaces. PersistedCache stores
encoded success and failure exits with TTL, so choose which failures deserve
caching. PersistedQueue can redeliver work after a crash: make handlers
idempotent, define retries and dead-letter handling, and scope the cleanup
worker. For multi-process rate limits, all processes must share the same
underlying store.

Use Schema to version stored values. Workflow uses these primitives for its
engine or worker queues but defines the durable execution contract separately.

## Sources

- [KeyValueStore API](https://effect.website/docs/v4/api/effect/persistence/KeyValueStore)
- [PersistedQueue API](https://effect.website/docs/v4/api/effect/persistence/PersistedQueue)
- [Pinned KeyValueStore source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/persistence/KeyValueStore.ts)
