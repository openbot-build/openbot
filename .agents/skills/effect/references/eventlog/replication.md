# EventLog replication, identity and replay testing

Verified against `effect@4.1.2` sources.

## Moving parts

| Piece | Module | Role |
| --- | --- | --- |
| `EventJournal` | `EventJournal.layerMemory`, `layerIndexedDb(options?)`, `SqlEventJournal.layer(options?)` | local durable list of `Entry` (id, event, primaryKey, payload bytes) |
| `Identity` | `EventLog.Identity` service `{ publicKey, privateKey: Redacted<Uint8Array> }` | who is writing; keys for auth and encryption |
| `EventLogEncryption` | `EventLogEncryption.layerSubtle` (Web Crypto) | encrypt/decrypt entries, generate identity |
| `Registry` | `EventLog.layerRegistry` | handlers, compactors, remotes, reactivity keys |
| `EventLogRemote` | `layerEncrypted`, `layerEncryptedWith({ compaction })`, `layerUnencrypted` | client side replica link; needs `RpcClient.Protocol` and `Registry` |
| Server | `EventLogServerEncrypted.layer`, `EventLogServerUnencrypted.layer(schema, handlersLayer)` | the other end; needs `RpcServer.Protocol` and a `Storage` |
| Server storage | `...layerStorageMemory`, `EventLogServerEncrypted.layerStorageMemoryWith({ compaction })`, `SqlEventLogServerEncrypted.layerStorage`/`layerStorageSubtle`, `SqlEventLogServerUnencrypted.layerStorage` | where the server keeps entries |
| `CurrentStoreId` | `EventLog.CurrentStoreId` (reference, default `"default"`) | partition of the journal; one identity may use several stores |

## Identity

Generate once and persist; losing the private key makes encrypted remote
data unreadable.

```ts import.meta.vitest name="references/eventlog/replication.md#1"
import { Effect, Layer } from "effect"
import { EventLog, EventLogEncryption } from "effect/eventlog"

// Fresh identity each time the layer is built. Fine for tests and demos;
// production loads a stored one instead.
export const GeneratedIdentity = Layer.effect(EventLog.Identity, EventLog.makeIdentity).pipe(
  Layer.provide(EventLogEncryption.layerSubtle)
)

// Persisted form: a base64url string you can store in a keychain or secret.
export const roundTrip = Effect.gen(function*() {
  const identity = yield* EventLog.makeIdentity
  const text = EventLog.encodeIdentityString(identity)
  const restored = EventLog.decodeIdentityString(text) // throws on invalid input
  return restored.publicKey === identity.publicKey
}).pipe(Effect.provide(EventLogEncryption.layerSubtle))

const restoredOk = await Effect.runPromise(roundTrip)
restoredOk // => true
```

`decodeIdentityString` throws a schema error on malformed input instead of
failing in the Effect error channel: wrap it in `Effect.try` at the
boundary where the string comes from storage.

## Server wiring (unencrypted, trusted transport)

The server is an RPC server: `EventLogServerUnencrypted.layer` registers the
event-log RPCs on an `RpcServer.Protocol`, so the transport is an ordinary
`RpcServer` protocol layer served by an `HttpRouter`. This fence is
typechecked, not executed, because it binds a port.

```ts
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { EventGroup, EventLog, EventLogServerUnencrypted } from "effect/eventlog"
import { HttpRouter } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { createServer } from "node:http"

const Tasks = EventGroup.empty.add({
  tag: "TaskCompleted",
  primaryKey: (payload) => payload.id,
  payload: Schema.Struct({ id: Schema.String })
})
const TaskLog = EventLog.schema(Tasks)

// The server runs the same handlers on entries it receives, so it needs its
// own projection target (often SQL).
const ServerHandlers = EventLog.group(Tasks, (handlers) =>
  handlers.handle("TaskCompleted", ({ payload }) => Effect.log(`completed ${payload.id}`))
)

// Authorization is a service. This one lets every identity read and write;
// a real one checks publicKey/storeId and fails with EventLogServerAuthError.
const AuthorizationLayer = Layer.succeed(EventLogServerUnencrypted.EventLogServerAuthorization)({
  authorizeWrite: () => Effect.void,
  authorizeRead: () => Effect.void,
  authorizeIdentity: () => Effect.void
})

// HTTP transport: the protocol is a route on the router, JSON framing.
const ProtocolLayer = RpcServer.layerProtocolHttp({ path: "/events" }).pipe(
  Layer.provide(RpcSerialization.layerJson)
)

export const Server = EventLogServerUnencrypted.layer(
  TaskLog,
  ServerHandlers.pipe(Layer.provide(EventLog.layerRegistry))
).pipe(
  Layer.provide(AuthorizationLayer),
  Layer.provide(EventLogServerUnencrypted.layerStorageMemory),
  Layer.provide(EventLogServerUnencrypted.layerStoreMappingStatic({ storeId: EventLog.CurrentStoreId.defaultValue() })),
  Layer.provideMerge(ProtocolLayer)
)

export const Main = HttpRouter.serve(Server).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3010 }))
)
```

Replace `layerStorageMemory` with
`SqlEventLogServerUnencrypted.layerStorage()` for durability (requires a
`SqlClient`). For the encrypted server, `EventLogServerEncrypted.layer`
needs only `RpcServer.Protocol` and a `Storage` (it never sees plaintext, so
it runs no handlers). `SqlEventLogServerEncrypted.layerStorage()` needs
`SqlClient` and a `Digest` (`effect/crypto`; `NodeCrypto` provides one on
Node); `layerStorageSubtle()` supplies the Web Crypto digest for you.
Encrypted storage takes `compaction: { grace, lag, stageTtl, thresholdFloor,
sweepInterval }` (defaults 30 days, 24 hours, 10 minutes, 1000 entries, 1
hour; `grace` must exceed `lag` and `stageTtl`) and keeps the pre-compaction
history for `grace` so a bad snapshot can be rolled back.

Authorization is a service, not a flag: implement
`EventLogServerAuthorization` (`authorizeWrite`, `authorizeRead`,
`authorizeIdentity`, the last receiving `{ publicKey, signingPublicKey }`) and
fail with `EventLogServerAuthError` to refuse.

## Simulating a remote peer in a test

`EventLog.makeReplayFromRemote` builds the same effect the log uses when a
remote delivers entries. Feeding the journal a hand-made `RemoteEntry`
exercises handlers, `conflicts` and reactivity with no network and no
clock: control time through the entry id (`makeEntryIdUnsafe({ msecs })`).

```ts import.meta.vitest name="references/eventlog/replication.md#3"
import { Context, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { EventGroup, EventJournal, EventLog } from "effect/eventlog"
import { Reactivity } from "effect/reactivity"

const Tasks = EventGroup.empty.add({
  tag: "TaskRenamed",
  primaryKey: (payload) => payload.id,
  payload: Schema.Struct({ id: Schema.String, title: Schema.String })
})
const TaskLog = EventLog.schema(Tasks)

class Titles extends Context.Service<Titles, Ref.Ref<ReadonlyMap<string, string>>>()("app/Titles") {
  static readonly layer = Layer.effect(Titles, Ref.make<ReadonlyMap<string, string>>(new Map()))
}

const Handlers = EventLog.group(Tasks, (handlers) =>
  handlers.handle("TaskRenamed", ({ payload, conflicts }) =>
    Effect.gen(function*() {
      if (conflicts.length > 0) return // a newer local rename exists: last writer wins
      const titles = yield* Titles
      yield* Ref.update(titles, (all) => new Map(all).set(payload.id, payload.title))
    }))
)

const identity = { publicKey: "test", privateKey: Redacted.make(new Uint8Array(32)) }

const TestLayer = EventLog.layer(TaskLog, Handlers.pipe(Layer.provide(EventLog.layerRegistry))).pipe(
  Layer.provideMerge(EventJournal.layerMemory),
  Layer.provide(Layer.succeed(EventLog.Identity)(identity)),
  Layer.provideMerge(Titles.layer),
  Layer.provideMerge(Reactivity.layer)
)

const test = Effect.gen(function*() {
  const write = yield* EventLog.makeClient(TaskLog)
  const registry = yield* EventLog.Registry
  const journal = yield* EventJournal.EventJournal
  const titles = yield* Titles
  const reactivity = yield* Reactivity.Reactivity

  const replay = EventLog.makeReplayFromRemote({
    handlers: registry.handlers,
    storeId: EventLog.CurrentStoreId.defaultValue(),
    identity,
    reactivity,
    reactivityKeys: registry.reactivityKeys,
    logAnnotations: { service: "test", effect: "replay" }
  })

  // 1. A local write, stamped "now".
  yield* write({ event: "TaskRenamed", payload: { id: "1", title: "local" } })

  // 2. A remote peer's entry for the same task, created a minute earlier but
  //    delivered late.
  const payload = yield* Schema.encodeUnknownEffect(
    Tasks.events.TaskRenamed!.payloadSchemaBinary // `events` is a string-keyed record
  )({ id: "1", title: "remote (older)" })
  const entry = new EventJournal.Entry({
    id: EventJournal.makeEntryIdUnsafe({ msecs: Date.now() - 60_000 }),
    event: "TaskRenamed",
    primaryKey: "1",
    payload
  }, { disableChecks: true })

  yield* journal.writeFromRemote({
    remoteId: EventJournal.makeRemoteIdUnsafe(),
    entries: [new EventJournal.RemoteEntry({ remoteSequence: 0, entry })],
    // The journal passes the whole batch with each entry's newer local entries.
    effect: (batch) => Effect.forEach(batch, replay, { discard: true }).pipe(Effect.orDie)
  })

  // The older remote rename was journaled but did not overwrite the model.
  return {
    journaled: (yield* journal.entries).length,
    title: (yield* Ref.get(titles)).get("1")
  }
})

const result = await Effect.runPromise(test.pipe(Effect.provide(TestLayer)))
result // => { journaled: 2, title: "local" }
```

This relies on `makeReplayFromRemote` and `EventJournal.writeFromRemote`,
which are lower-level than the day-to-day API; keep such tests few and
prefer asserting on handler outcomes.
