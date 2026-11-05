# EventLog rows, batched writes and compaction

Verified against `effect@4.1.2`. `EventRow` and `HandlerTransaction` arrived
in 4.0.6, remote compaction in 4.1. Read the main
[guide](guide.md) first; this file covers the pieces you reach for once the
basic recipe works.

## Pick the right write shape

| You want | Use | Why |
| --- | --- | --- |
| Hand-written events with their own handlers | `EventGroup.add({ tag, primaryKey, payload })` + `handlers.handle` | full control, you write the conflict rule |
| A mutable record (a row) that converges across replicas | `EventRow.make` + `EventRow.handler` | per-field last-writer-wins is built in |
| Several events that succeed or fail together | `log.writeMany` | one journal lock, one `HandlerTransaction`, all-or-nothing |
| Many handler writes in one SQL/IndexedDB transaction | provide `EventLog.HandlerTransaction` | N events commit once instead of N times |
| Shrink a long history during replay | `EventLog.groupCompaction` / `groupBatchCompaction` | drops or collapses entries per key or per batch |
| Shrink the history the *server* stores | `groupCompaction(..., { remote: true })` | clients build a compacted snapshot (encrypted remotes) |

## Rows: set, patch, remove

`EventRow.make(tag, { key, schema })` defines one event whose payload is a
`set`, `patch` or `remove` of a row. You supply three storage callbacks;
the library resolves conflicts per top-level field in entry-id order, so two
devices patching different fields of the same row both win.

```ts import.meta.vitest name="references/eventlog/rows-and-compaction.md#1"
import { Effect, Layer, Redacted, Schema } from "effect"
import { EventGroup, EventJournal, EventLog, EventRow } from "effect/eventlog"

const Grocery = EventRow.make("grocery", {
  key: "id",
  schema: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    completed: Schema.Boolean
  })
})
const Groceries = EventGroup.empty.add(Grocery)
const GroceryLog = EventLog.schema(Groceries)

// The read model: any store works. A Map keeps the example runnable.
const rows = new Map<string, typeof Grocery.schema.Type>()

const Handlers = EventLog.group(Groceries, (handlers) =>
  handlers.handle(
    "grocery",
    EventRow.handler(Grocery, {
      set: (row) => Effect.sync(() => rows.set(row.id, row)),
      // patch must do nothing when the row is missing: upserting here can
      // resurrect a removed row on only some replicas.
      patch: (id, fields) =>
        Effect.sync(() => {
          const row = rows.get(id)
          if (row !== undefined) rows.set(id, { ...row, ...fields })
        }),
      remove: (id) => Effect.sync(() => rows.delete(id))
    })
  ))

const TestLayer = EventLog.layer(
  GroceryLog,
  Handlers.pipe(Layer.provide(EventLog.layerRegistry))
).pipe(
  Layer.provide(EventJournal.layerMemory),
  Layer.provide(Layer.succeed(EventLog.Identity)({
    publicKey: "test",
    privateKey: Redacted.make(new Uint8Array(32))
  }))
)

const program = Effect.gen(function*() {
  const write = yield* EventLog.makeClient(GroceryLog)
  // `set`, `patch` and `remove` build `{ event, payload }` items.
  yield* write(Grocery.set({ id: "milk", name: "Milk", completed: false }))
  yield* write(Grocery.patch("milk", { completed: true }))
  yield* write(Grocery.set({ id: "eggs", name: "Eggs", completed: false }))
  yield* write(Grocery.remove("eggs"))
  return [...rows.values()]
})

const result = await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
result // => [{ id: "milk", name: "Milk", completed: true }]
```

Do not compact row events with `groupCompaction`; use
`EventRow.compaction(group, row)`, which only drops entries that a newer
`set` or `remove` shadows. Adding a field to a row schema needs a decoding
default (`Schema.withDecodingDefaultKey`) or old `set` entries stop decoding;
see the `EventRow` module docs for the full evolution rules.

## writeMany and HandlerTransaction

`writeMany` takes `{ schema, events }` on the `EventLog` service (the client
returned by `makeClient` writes one event at a time). All handlers run under
one `HandlerTransaction`, and if any handler fails nothing is committed.
`HandlerTransaction` is a `Context.Reference` holding a function that wraps
the batch: in production it is `sql.withTransaction` over your projection
tables; here a counter shows it wrapping N events once.

```ts import.meta.vitest name="references/eventlog/rows-and-compaction.md#2"
import { Effect, Layer, Redacted, Ref, Schema } from "effect"
import { EventGroup, EventJournal, EventLog } from "effect/eventlog"

class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {
  sku: Schema.String
}) {}

const Stock = EventGroup.empty.add({
  tag: "Reserved",
  primaryKey: (payload) => payload.sku,
  payload: Schema.Struct({ sku: Schema.String, qty: Schema.Number }),
  error: OutOfStock
})
const StockLog = EventLog.schema(Stock)

const program = Effect.gen(function*() {
  const available = yield* Ref.make(new Map([["apple", 2], ["pear", 0]]))
  const transactions = yield* Ref.make(0)

  const Handlers = EventLog.group(Stock, (handlers) =>
    handlers.handle("Reserved", ({ payload }) =>
      Effect.gen(function*() {
        const stock = yield* Ref.get(available)
        const left = (stock.get(payload.sku) ?? 0) - payload.qty
        if (left < 0) return yield* new OutOfStock({ sku: payload.sku })
        yield* Ref.set(available, new Map(stock).set(payload.sku, left))
      })))

  const layer = EventLog.layer(StockLog, Handlers.pipe(Layer.provide(EventLog.layerRegistry))).pipe(
    Layer.provide(EventJournal.layerMemory),
    Layer.provide(Layer.succeed(EventLog.Identity)({
      publicKey: "test",
      privateKey: Redacted.make(new Uint8Array(32))
    })),
    // Count how many times the batch is wrapped. A real app would pass
    // (effect) => sql.withTransaction(effect).
    Layer.provide(Layer.succeed(EventLog.HandlerTransaction)((effect) =>
      Effect.andThen(Ref.update(transactions, (n) => n + 1), effect)
    ))
  )

  return yield* Effect.gen(function*() {
    const log = yield* EventLog.EventLog

    // Both succeed: one transaction for two events.
    yield* log.writeMany({
      schema: StockLog,
      events: [
        { event: "Reserved", payload: { sku: "apple", qty: 1 } },
        { event: "Reserved", payload: { sku: "apple", qty: 1 } }
      ]
    })

    // The second reservation fails, so the first is not committed either.
    const failure = yield* log.writeMany({
      schema: StockLog,
      events: [
        { event: "Reserved", payload: { sku: "apple", qty: 0 } },
        { event: "Reserved", payload: { sku: "pear", qty: 1 } }
      ]
    }).pipe(Effect.flip)

    const entries = yield* log.entries
    return {
      failure: (failure as OutOfStock)._tag,
      journaled: entries.length,
      transactions: yield* Ref.get(transactions)
    }
  }).pipe(Effect.provide(layer))
})

const result = await Effect.runPromise(program)
result // => { failure: "OutOfStock", journaled: 2, transactions: 2 }
```

Handlers that already ran are not undone by a failed batch: only changes made
inside a transaction that rolls back disappear. Keep batch handlers
transactional (SQL) or idempotent. For replayed remote batches a failing
handler fails the whole batch, which is retried after a backoff, so a
handler that fails on every attempt stops sync from that remote.

## Compaction

Compaction runs while remote entries are replayed. `groupCompaction`
groups the batch by primary key; `groupBatchCompaction` sees the whole batch
and suits events that affect other keys. Your effect decides what survives:
`forward(entry)` keeps an entry unchanged, `write(tag, payload)` adds a
replacement anchored at the first entry, and everything else is dropped.

```ts import.meta.vitest name="references/eventlog/rows-and-compaction.md#3"
import { Effect, Layer, Redacted, Schema } from "effect"
import { EventGroup, EventJournal, EventLog } from "effect/eventlog"

const Renames = EventGroup.empty.add({
  tag: "TaskRenamed",
  primaryKey: (payload) => payload.id,
  payload: Schema.Struct({ id: Schema.String, title: Schema.String })
})
const RenameLog = EventLog.schema(Renames)

const applied: Array<string> = []
const Handlers = EventLog.group(Renames, (handlers) =>
  handlers.handle("TaskRenamed", ({ payload }) => Effect.sync(() => void applied.push(payload.title))))

// Keep only the newest rename per task. `remote: true` also lets an
// encrypted remote use this compactor to build server-side snapshots, which
// promises the result depends only on the set of input entries (it does:
// "last by id" is order independent and composes).
const KeepLastRename = EventLog.groupCompaction(
  Renames,
  ({ entries, forward }) => Effect.forEach(entries.slice(-1), forward, { discard: true }),
  { remote: true }
)

const TestLayer = Layer.mergeAll(
  EventLog.layer(RenameLog, Handlers.pipe(Layer.provide(EventLog.layerRegistry))),
  KeepLastRename.pipe(Layer.provide(EventLog.layerRegistry))
).pipe(
  Layer.provide(EventJournal.layerMemory),
  Layer.provide(Layer.succeed(EventLog.Identity)({
    publicKey: "test",
    privateKey: Redacted.make(new Uint8Array(32))
  }))
)

const program = Effect.gen(function*() {
  const registry = yield* EventLog.Registry
  const compactor = [...registry.compactors.values()][0]!

  // Three renames of task "1" with ascending entry ids, as a remote backlog.
  const encode = Schema.encodeUnknownEffect(Renames.events.TaskRenamed!.payloadSchemaBinary)
  const entries: Array<EventJournal.Entry> = []
  for (const [i, title] of ["a", "b", "c"].entries()) {
    entries.push(
      new EventJournal.Entry({
        id: EventJournal.makeEntryIdUnsafe({ msecs: 1_000 + i }),
        event: "TaskRenamed",
        primaryKey: "1",
        payload: yield* encode({ id: "1", title })
      }, { disableChecks: true })
    )
  }

  // Run the registered compactor the way replay does and collect what it keeps.
  const kept: Array<EventJournal.Entry> = []
  yield* compactor.effect({ entries, write: (entry) => Effect.sync(() => void kept.push(entry)) })
  return { remote: compactor.remote, kept: kept.length, sameAsLast: kept[0] === entries[2] }
})

const result = await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
result // => { remote: true, kept: 1, sameAsLast: true }
```

Rules that keep replicas convergent:

- Compaction never sees stored (local) entries, so collapsing several
  entries into one is only safe when no stored entry for the same event and
  key has an id between theirs.
- A `remote: true` compactor may only drop entries. A call that uses `write`
  keeps its whole input during a remote compaction, and entries that fail to
  decode are always kept.
- Compaction must be deterministic: no clock, services or input order.

### Remote compaction (encrypted remotes)

The server cannot read encrypted entries, so clients build the snapshot. A
client that registered a `remote: true` compactor checks the compaction status
on connect and about hourly. When the server wants it, and the journal has
caught up, a run starts after a random delay of a few minutes: read the input,
run the opted-in compactors, upload what they keep. One run per store holds
the stage; other devices get `Busy`. `log.compact({ remoteId? })` starts a
run immediately (for example from a worker that holds the identity) and
returns one result per remote: `"Committed" | "Superseded" | "NoOp" |
"NotWanted" | "Busy" | "Aborted"`.

A remote opts out with `EventLogRemote.layerEncryptedWith({ compaction: false })`
(a run holds every kept entry in memory, so small devices should leave it to
a worker). Server-side storage options are covered in
[replication.md](replication.md).
