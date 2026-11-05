# Effect EventLog: events as the source of truth

## How to think about it

An event log inverts the usual database design. Instead of storing the
*current* state and overwriting it, you store the *facts that happened*
("TaskAdded", "TaskRenamed") in an append-only **journal**, and derive
current state by running those facts through **handlers**. State is a
projection; the log is the truth. That buys you history, replay, and, the
real reason this module exists, **replication**: two devices can each append
events while offline, exchange journals later, and both run the same
handlers over the union to converge.

Four consequences drive every design decision:

- **A handler is the only way state changes.** `write` encodes the payload,
  runs your handler inside the journal's write, and commits the entry *only
  if the handler succeeds*. A handler that fails with the event's typed
  error rejects the write and leaves no entry behind. So handlers are both
  validators and projectors.
- **Handlers run again elsewhere.** Entries arriving from a remote replica
  are decoded and sent through the same handler, possibly late and out of
  order. A handler must therefore depend only on its payload, the entry and
  its `conflicts`, and must not send an email, charge a card or call an API.
  Side effects that must happen once belong in a workflow or on a server
  after sync, not in the projection.
- **`primaryKey` says "these events are about the same thing".** It is
  required on every event. It groups entries for conflict detection,
  compaction and reactivity invalidation. Use the aggregate id (task id,
  document id), never a constant.
- **Time is in the entry id.** Entry ids are time-ordered; the journal sorts
  by creation time. When a remote entry arrives that is *older* than a local
  entry with the same event and primary key, the handler receives that local
  entry in `conflicts`. That is your hook for last-writer-wins or a merge.

If you come from SQL: do not model "UPDATE task SET title" as a mutating
call that bypasses the log, and do not treat the read-model table as the
source of truth. If you come from Kafka/EventStore: this is client-first
and offline-first; the journal lives next to the app (memory, IndexedDB, SQL)
and a remote is just another replica. If you come from Redux: handlers are
reducers whose input is persisted and synced.

`effect/eventlog` is unstable. Event names, payload schemas and primary
keys are persisted forever, so treat them as a public contract. This guide
is written for `effect@4.1.x`; see [Changed in 4.1](#changed-in-41).

## Choose

| Situation | Use | Why |
| --- | --- | --- |
| Offline-first or multi-device state that must converge | `EventLog` + remote | journal, replay and conflict hook built in |
| Audit trail / history of domain facts, rebuildable read models | `EventLog` | handlers can be re-run |
| Need to query current rows with joins | keep a read model (SQL or Ref) fed by handlers, query that ([sql](../sql/guide.md)) | the log is not a query engine |
| Single-writer state per key on a server cluster | `Entity` in [cluster](../cluster/guide.md) | one owner, no merge needed |
| Long multi-step process with retries and sleeps | [workflow](../workflow/guide.md) | activities and durable timers; log events are not a scheduler |
| In-process pub/sub of ephemeral notifications | `PubSub` ([concurrency](../concurrency/guide.md)) | no durability needed |
| Cache with TTL | [persistence](../persistence/guide.md) / `Cache` | not facts, just memoization |
| Plain CRUD with no sync or history | a table in [sql](../sql/guide.md) | event sourcing is overhead you do not need |

Journals: `EventJournal.layerMemory` (tests, ephemeral), `EventJournal.layerIndexedDb`
(browser), `SqlEventJournal.layer` (any `SqlClient`; tables
`effect_event_journal`, `effect_event_remotes` by default).

## Recipe

### 1. Describe the facts

Events are schemas. `EventGroup.empty.add({...})` is immutable and returns a
new group, so chain it. Put the failure the handler may raise on the event
(`error`) so callers of `write` can branch on it.

```ts import.meta.vitest name="references/eventlog/guide.md#1"
import { Schema } from "effect"
import { EventGroup, EventLog } from "effect/eventlog"

// A domain failure: part of the signature of writing TaskAdded.
export class TitleTaken extends Schema.TaggedError<TitleTaken>()("TitleTaken", {
  title: Schema.String
}) {}

// Events are past tense facts, not commands. They carry what handlers need
// to be deterministic (ids, timestamps) so replay never has to guess.
export const Tasks = EventGroup.empty
  .add({
    tag: "TaskAdded",
    primaryKey: (payload) => payload.id, // all events about task X group together
    payload: Schema.Struct({ id: Schema.String, title: Schema.String }),
    error: TitleTaken
  })
  .add({
    tag: "TaskRenamed",
    primaryKey: (payload) => payload.id,
    payload: Schema.Struct({ id: Schema.String, title: Schema.String })
  })
  .add({
    tag: "TaskCompleted",
    primaryKey: (payload) => payload.id,
    payload: Schema.Struct({ id: Schema.String })
  })

// The schema bundles groups; the client and the layer are both typed by it.
export const TaskLog = EventLog.schema(Tasks)

Object.keys(Tasks.events) // => ["TaskAdded", "TaskRenamed", "TaskCompleted"]
```

### 2. Handlers project facts into a read model

The read model is an ordinary service so it can be a `Ref` in tests, SQL in
production, or a UI store. Handlers get `payload`, the `entry` (id, time),
and `conflicts` (newer local entries for the same event and key, only
non-empty when replaying remote entries).

```ts import.meta.vitest name="references/eventlog/guide.md#2"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { EventGroup, EventLog } from "effect/eventlog"

class TitleTaken extends Schema.TaggedError<TitleTaken>()("TitleTaken", {
  title: Schema.String
}) {}
const Tasks = EventGroup.empty
  .add({
    tag: "TaskAdded",
    primaryKey: (payload) => payload.id,
    payload: Schema.Struct({ id: Schema.String, title: Schema.String }),
    error: TitleTaken
  })
  .add({
    tag: "TaskRenamed",
    primaryKey: (payload) => payload.id,
    payload: Schema.Struct({ id: Schema.String, title: Schema.String })
  })
  .add({
    tag: "TaskCompleted",
    primaryKey: (payload) => payload.id,
    payload: Schema.Struct({ id: Schema.String })
  })

export interface Task {
  readonly id: string
  readonly title: string
  readonly done: boolean
}

// The projection target. Handlers write it; readers query it.
export class TaskModel extends Context.Service<TaskModel, {
  readonly all: Effect.Effect<ReadonlyArray<Task>>
  upsert(task: Task): Effect.Effect<void>
  get(id: string): Effect.Effect<Task | undefined>
}>()("app/TaskModel") {
  static readonly layerMemory = Layer.effect(
    TaskModel,
    Effect.gen(function*() {
      const rows = yield* Ref.make<ReadonlyMap<string, Task>>(new Map())
      return TaskModel.of({
        all: Ref.get(rows).pipe(Effect.map((m) => [...m.values()])),
        upsert: (task) => Ref.update(rows, (m) => new Map(m).set(task.id, task)),
        get: (id) => Ref.get(rows).pipe(Effect.map((m) => m.get(id)))
      })
    })
  )
}

// EventLog.group returns a Layer that registers one handler per event. The
// builder tracks which tags are still unhandled: a missing handler is a type
// error, not a runtime surprise.
export const TaskHandlers = EventLog.group(Tasks, (handlers) =>
  handlers
    .handle("TaskAdded", ({ payload }) =>
      Effect.gen(function*() {
        const model = yield* TaskModel
        const existing = yield* model.all
        // Typed failure: the write is rejected and nothing is journaled. This
        // check reads the local read model, so it is a local-write validation:
        // on remote replay a failure here is only logged, and replicas that
        // saw writes in a different order may disagree. Use it for guards, not
        // for invariants replicas must agree on.
        if (existing.some((task) => task.title === payload.title)) {
          return yield* new TitleTaken({ title: payload.title })
        }
        yield* model.upsert({ id: payload.id, title: payload.title, done: false })
      }))
    .handle("TaskRenamed", ({ payload, conflicts }) =>
      Effect.gen(function*() {
        // Last-writer-wins: a newer rename of the same task is already in the
        // journal, so this older replayed one must not overwrite it.
        if (conflicts.length > 0) return
        const model = yield* TaskModel
        const task = yield* model.get(payload.id)
        if (task) yield* model.upsert({ ...task, title: payload.title })
      }))
    .handle("TaskCompleted", ({ payload }) =>
      Effect.gen(function*() {
        const model = yield* TaskModel
        const task = yield* model.get(payload.id)
        // Idempotent and commutative: completing twice is the same as once.
        if (task) yield* model.upsert({ ...task, done: true })
      }))
)
```

### 3. Assemble: journal, identity, registry, and a domain service

`EventLog.layer(schema, handlersLayer)` produces `EventLog | Registry` and
requires `EventJournal` and `Identity`. The client from `makeClient` takes one
`{ event, payload }` item per call; `TaskBoard.add` below is what callers see. The handlers layer needs a
`Registry`, which `EventLog.layerRegistry` supplies. Hide `makeClient`
behind a service so the rest of the app writes `tasks.add(...)`, not event
tags.

```ts import.meta.vitest name="references/eventlog/guide.md#3"
import { Context, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { EventGroup, EventJournal, EventLog } from "effect/eventlog"

class TitleTaken extends Schema.TaggedError<TitleTaken>()("TitleTaken", {
  title: Schema.String
}) {}
const Tasks = EventGroup.empty
  .add({
    tag: "TaskAdded",
    primaryKey: (payload) => payload.id,
    payload: Schema.Struct({ id: Schema.String, title: Schema.String }),
    error: TitleTaken
  })
  .add({
    tag: "TaskCompleted",
    primaryKey: (payload) => payload.id,
    payload: Schema.Struct({ id: Schema.String })
  })
const TaskLog = EventLog.schema(Tasks)

class Titles extends Context.Service<Titles, Ref.Ref<ReadonlyArray<string>>>()("app/Titles") {
  static readonly layer = Layer.effect(Titles, Ref.make<ReadonlyArray<string>>([]))
}

const TaskHandlers = EventLog.group(Tasks, (handlers) =>
  handlers
    .handle("TaskAdded", ({ payload }) =>
      Effect.gen(function*() {
        const titles = yield* Titles
        if ((yield* Ref.get(titles)).includes(payload.title)) {
          return yield* new TitleTaken({ title: payload.title })
        }
        yield* Ref.update(titles, (all) => [...all, payload.title])
      }))
    .handle("TaskCompleted", () => Effect.void)
)

// The use-case API. Callers see a domain error and infrastructure as defects.
export class TaskBoard extends Context.Service<TaskBoard, {
  add(id: string, title: string): Effect.Effect<void, TitleTaken>
  complete(id: string): Effect.Effect<void>
}>()("app/TaskBoard") {
  static readonly layer = Layer.effect(
    TaskBoard,
    Effect.gen(function*() {
      const write = yield* EventLog.makeClient(TaskLog)
      return TaskBoard.of({
        // Failure channel: TitleTaken | EventJournalError. A journal failure is
        // storage trouble, so it becomes a defect and callers see only the
        // domain error.
        add: (id, title) =>
          write({ event: "TaskAdded", payload: { id, title } }).pipe(
            Effect.catchTag("EventJournalError", Effect.die)
          ),
        complete: (id) => write({ event: "TaskCompleted", payload: { id } }).pipe(Effect.orDie)
      })
    })
  )
}

// A fixed identity keeps tests deterministic. Real apps generate one with
// EventLog.makeIdentity (needs EventLogEncryption) and persist it securely.
const TestIdentity = Layer.succeed(EventLog.Identity)({
  publicKey: "test-key",
  privateKey: Redacted.make(new Uint8Array(32))
})

export const TaskBoardTest = TaskBoard.layer.pipe(
  Layer.provideMerge(
    EventLog.layer(TaskLog, TaskHandlers.pipe(Layer.provide(EventLog.layerRegistry)))
  ),
  Layer.provide(EventJournal.layerMemory),
  Layer.provide(TestIdentity),
  Layer.provideMerge(Titles.layer)
)

const duplicate = Effect.gen(function*() {
  const board = yield* TaskBoard
  yield* board.add("1", "write docs")
  return yield* board.add("2", "write docs").pipe(Effect.flip)
})

const failure = await Effect.runPromise(duplicate.pipe(Effect.provide(TaskBoardTest)))
failure._tag // => "TitleTaken"
```

### 4. Remote replication, compaction and reactivity (wiring)

A remote is a service that registers itself with the `Registry`; when it is
in the layer graph, the log pushes uncommitted entries to it and replays what
it sends. Compaction runs while replaying remote entries and lets you
replace many entries per primary key with fewer. Reactivity keys tell
[reactivity](../reactivity/guide.md) what to invalidate when an event is written or replayed.
This fence is typechecked, not executed, because it opens a network client.

```ts
import { Effect, Layer, Schema } from "effect"
import { EventGroup, EventLog, EventLogRemote } from "effect/eventlog"
import { FetchHttpClient } from "effect/http"
import { RpcClient, RpcSerialization } from "effect/rpc"

const Tasks = EventGroup.empty.add({
  tag: "TaskRenamed",
  primaryKey: (payload) => payload.id,
  payload: Schema.Struct({ id: Schema.String, title: Schema.String })
})

// Keep only the newest rename per task when merging a remote backlog.
// `entries` are the journal entries for one primary key, oldest first.
export const RenameCompaction = EventLog.groupCompaction(
  Tasks,
  ({ entries, forward }) => Effect.forEach(entries.slice(-1), forward, { discard: true })
)

// Any write or replay of TaskRenamed invalidates the "tasks" key, parameterised
// by the entry's primaryKey.
export const RenameReactivity = EventLog.groupReactivity(Tasks, ["tasks"])

// The transport is yours. This one is request/response over HTTP with JSON
// framing; RpcClient.layerProtocolSocket is the WebSocket alternative. The
// server must use the same serialization.
export const ProtocolLayer = RpcClient.layerProtocolHttp({ url: "https://sync.example.com/events" }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerJson)
)

// Encrypted by default: entries are encrypted with keys derived from the
// Identity before they leave the device. Use layerUnencrypted only on a
// trusted transport or in tests.
export const Remote = EventLogRemote.layerEncrypted.pipe(
  Layer.provide(ProtocolLayer)
)
```

The remote layer needs `Registry`, so it composes next to `EventLog.layer`
(which provides it), for example
`Layer.merge(logLayer, Remote.pipe(Layer.provide(logLayer)))`. The server side
is `EventLogServerEncrypted` or `EventLogServerUnencrypted` with
SQL-backed storage (`SqlEventLogServerEncrypted.layerStorage`,
`SqlEventLogServerUnencrypted.layerStorage`); see
[references/replication.md](replication.md). Batched writes
(`log.writeMany`), mutable rows (`EventRow`), `HandlerTransaction` and
server-side snapshot compaction (`remote: true`) are in
[rows-and-compaction.md](rows-and-compaction.md).

## Anti-patterns

**Mutating the read model directly, bypassing the log.** The model and the
journal diverge, and replicas cannot reproduce the change.

```ts skip
// WRONG: state changes with no event
yield* model.upsert({ id, title, done: true })
```

Right: `yield* write({ event: "TaskCompleted", payload: { id } })` and let the handler call
`upsert`.

**Side effects in handlers.** Handlers re-run on every replica and on every
replay, so the email goes out once per device.

```ts skip
// WRONG: runs on every replica
.handle("TaskCompleted", ({ payload }) => sendCongratsEmail(payload.id))
```

Right: keep handlers to deterministic state changes; trigger the side effect
from a server-side process after sync, or an [workflow](../workflow/guide.md) keyed by the
event's primary key.

**A constant or missing primary key.** Conflicts, compaction and reactivity
all group by it, so one key merges unrelated tasks.

```ts skip
// WRONG: every task is "the same thing"
primaryKey: () => "task"
```

Right: `primaryKey: (payload) => payload.id`.

**Non-deterministic handlers.** `Date.now()`, random ids or reading external
state inside a handler gives different results on each replica.

```ts skip
// WRONG: id differs per replica
.handle("TaskAdded", ({ payload }) => model.upsert({ ...payload, id: crypto.randomUUID() }))
```

Right: generate ids and timestamps when *writing* and put them in the
payload; handlers only read payload and entry.

**Ignoring `conflicts` for overwriting events.** A late-arriving older
rename clobbers a newer one and replicas disagree.

```ts skip
// WRONG: last replayed wins, not last written
.handle("TaskRenamed", ({ payload }) => model.rename(payload.id, payload.title))
```

Right: `if (conflicts.length > 0) return` (last-writer-wins) or merge using
the conflicting payloads.

**Changing a payload schema in place.** Stored entries are decoded with the
current schema; an incompatible change makes old entries undecodable.

```ts skip
// WRONG: renames a persisted field
payload: Schema.Struct({ id: Schema.String, name: Schema.String })
```

Right: add a new event (`TaskRenamedV2`) or make the new field optional with
a default, and keep handling the old shape.

**Unhandled event tags.** A write with no registered handler is a defect
(`Event handler not found`), and replayed entries with no handler are only
logged. Use `EventLog.group` for every group in the schema so the compiler
checks completeness.

**Treating the log as the query API.** Scanning `EventLog.entries` for the
current state on each render is O(history).

Right: query a read model that handlers maintain.

## Testing it

Everything above is deterministic with an in-memory journal and a fixed
identity. Test through the domain service; assert on the read model and on
the journal.

```ts import.meta.vitest name="references/eventlog/guide.md#11"
import { Context, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { EventGroup, EventJournal, EventLog } from "effect/eventlog"

class TitleTaken extends Schema.TaggedError<TitleTaken>()("TitleTaken", {
  title: Schema.String
}) {}
const Tasks = EventGroup.empty.add({
  tag: "TaskAdded",
  primaryKey: (payload) => payload.id,
  payload: Schema.Struct({ id: Schema.String, title: Schema.String }),
  error: TitleTaken
})
const TaskLog = EventLog.schema(Tasks)

class Titles extends Context.Service<Titles, Ref.Ref<ReadonlyArray<string>>>()("app/Titles") {
  static readonly layer = Layer.effect(Titles, Ref.make<ReadonlyArray<string>>([]))
}

const Handlers = EventLog.group(Tasks, (handlers) =>
  handlers.handle("TaskAdded", ({ payload }) =>
    Effect.gen(function*() {
      const titles = yield* Titles
      if ((yield* Ref.get(titles)).includes(payload.title)) {
        return yield* new TitleTaken({ title: payload.title })
      }
      yield* Ref.update(titles, (all) => [...all, payload.title])
    }))
)

const TestLayer = EventLog.layer(TaskLog, Handlers.pipe(Layer.provide(EventLog.layerRegistry))).pipe(
  Layer.provide(EventJournal.layerMemory),
  Layer.provide(Layer.succeed(EventLog.Identity)({
    publicKey: "test",
    privateKey: Redacted.make(new Uint8Array(32))
  })),
  Layer.provideMerge(Titles.layer)
)

const test = Effect.gen(function*() {
  const write = yield* EventLog.makeClient(TaskLog)
  const log = yield* EventLog.EventLog

  yield* write({ event: "TaskAdded", payload: { id: "1", title: "write docs" } })
  const failure = yield* write({ event: "TaskAdded", payload: { id: "2", title: "write docs" } }).pipe(
    Effect.flip
  )

  // The rejected write left no entry in the journal.
  const entries = yield* log.entries
  return {
    // The typed error comes back to the caller...
    failure: failure._tag,
    // ...and only the accepted write is journaled.
    journal: entries.map((entry) => [entry.event, entry.primaryKey])
  }
})

const result = await Effect.runPromise(test.pipe(Effect.provide(TestLayer)))
result // => { failure: "TitleTaken", journal: [["TaskAdded", "1"]] }
```

To test replay and `conflicts` without a network, build a `RemoteEntry` and
feed it to the journal; see
[references/replication.md](replication.md). With
`@effect/vitest`, wrap `test` in `it.effect` (see [testing](../testing/guide.md)).

## Boundaries

- [schema](../schema/guide.md) owns payload, success and error schemas, including
  versioning strategies and `Schema.TaggedError`.
- [services](../services/guide.md) owns `Context.Service`/`Layer` composition used for the
  read model, journal and identity.
- [sql](../sql/guide.md) owns the `SqlClient` behind `SqlEventJournal.layer` and the
  server storage layers, and the read-model tables themselves.
- [reactivity](../reactivity/guide.md) owns `Reactivity`/atoms; `EventLog.groupReactivity`
  only declares which keys an event invalidates.
- [workflow](../workflow/guide.md) owns once-only side effects and long-running processes
  triggered by events; [cluster](../cluster/guide.md) owns single-writer server-side state.
- [rpc](../rpc/guide.md) owns the transport (`RpcClient.layerProtocolSocket`,
  `layerProtocolHttp`) under the remote and server.
- Errors: typed event errors reach the writer; `EventJournalError`
  (storage) is infrastructure. Replay errors are logged, not returned.

## Changed in 4.1

- `makeClient` writers take one item, `write({ event, payload })`, not
  `write(tag, payload)`. `EventLog.EventLog.write` takes `{ schema, event, payload }`.
- New `log.writeMany({ schema, events })`: one journal lock and one
  `HandlerTransaction`, all-or-nothing.
- New `EventLog.HandlerTransaction` reference to wrap each batch of handlers
  in a SQL or IndexedDB transaction (4.0.6).
- New `EventRow` module (`make`, `handler`, `compaction`) for rows that
  converge per field (4.0.6).
- Compaction: `groupBatchCompaction` for cross-key batches, and a
  `{ remote: true }` option so encrypted remotes can store compacted
  snapshots; `log.compact()` forces a run.
- Replay hands the journal batches: `EventJournal.writeFromRemote`'s `effect`
  receives an array of `{ entry, conflicts }`.
- Encrypted transport moved from per-entry to per-batch records
  (`EncryptedBatch`), the server acknowledges writes with `WriteAck`
  sequences, and `EventLogServerAuthorization.authorizeIdentity` also gets
  `signingPublicKey`.
- `SqlEventLogServerEncrypted` needs a `Digest` from `effect/crypto` instead
  of `EventLogEncryption`; the `insertBatchSize` option is gone there.
- `EventLog.groupReactivity` keys are checked against `Reactivity.Keys` if
  your app declares it (see [reactivity](../reactivity/guide.md)).

## References

- [references/replication.md](replication.md): remote and server
  wiring, identity and encryption, store ids, simulating a remote peer in tests.
- [references/rows-and-compaction.md](rows-and-compaction.md): `EventRow`,
  `writeMany`, `HandlerTransaction`, compaction and remote snapshots.
- [EventLog API](https://effect.website/docs/v4/api/effect/eventlog/EventLog)
- [EventGroup API](https://effect.website/docs/v4/api/effect/eventlog/EventGroup)
- [EventJournal API](https://effect.website/docs/v4/api/effect/eventlog/EventJournal)
- [Pinned EventLog source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/eventlog/EventLog.ts)
- [Pinned EventJournal source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/eventlog/EventJournal.ts)
