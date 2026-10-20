---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when recording append-only domain events for replay, registered handlers, conflict handling, or remote replication with Effect EventLog.
metadata:
  github-path: skills/effect-eventlog
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: ee696efff3ecbbe49e60e7b35dd93e6918910e61
name: effect-eventlog
---

# Effect event log

Use `effect/eventlog` for append-only facts with registered handlers
and a journal. A SQL table of current records is not itself an event log;
SQL owns queries and transactions, while EventLog owns event identity,
replay, and replication. These v4 modules are unstable.

## Schema, journal, and handlers

```ts
import { Effect, Layer, Schema } from "effect";
import {
  EventGroup,
  EventJournal,
  EventLog,
  EventLogEncryption,
} from "effect/eventlog";

const Users = EventGroup.empty.add({
  tag: "UserCreated",
  primaryKey: (payload: { readonly id: string }) => payload.id,
  payload: Schema.Struct({ id: Schema.String }),
});
const UserSchema = EventLog.schema(Users);

const Handlers = EventLog.group(Users, (handlers) =>
  handlers.handle("UserCreated", ({ payload }) =>
    Effect.log(`rebuild user ${payload.id}`).pipe(Effect.asVoid),
  ),
).pipe(Layer.provide(EventLog.layerRegistry));

const LogLayer = EventLog.layer(UserSchema, Handlers).pipe(
  Layer.provide(EventJournal.layerMemory),
  Layer.provide(
    Layer.effect(EventLog.Identity, EventLog.makeIdentity).pipe(
      Layer.provide(EventLogEncryption.layerSubtle),
    ),
  ),
);

const append = Effect.gen(function* () {
  const write = yield* EventLog.makeClient(UserSchema);
  yield* write("UserCreated", { id: "user-1" });
}).pipe(Effect.provide(LogLayer));
```

The memory journal only tests the wiring. For durable use, select a journal,
register all event tags, version payload schemas, and make handlers safe on
replay. Remote identity and encryption need explicit scoped layers; plan
conflict resolution before enabling replication. Workflow stores execution
state, not the domain event stream.

## Sources

- [EventLog API](https://effect.website/docs/v4/api/effect/eventlog/EventLog)
- [Pinned EventLog source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/eventlog/EventLog.ts)
