# RPC cheat sheet, transports and a middleware test (effect@4.1)

All names verified against `node_modules/effect/src/rpc/*.ts` and
`@effect/platform-node`. Import from `"effect/rpc"`:
`Rpc, RpcClient, RpcClientError, RpcGroup, RpcMessage, RpcMiddleware, RpcSchema, RpcSerialization, RpcServer, RpcTest, RpcWorker`.

## Defining procedures

```text
Rpc.make(tag, {
  payload?,   // Schema, or a fields record (becomes Schema.Struct); default Void
  success?,   // Schema; default Void
  error?,     // Schema; default Never
  defect?,    // Schema for defects; default Schema.Defect()
  stream?,    // true => success is a Stream<success, error>
  primaryKey? // (payload) => string; only with a fields-record payload; used for dedupe/cluster
})
```

- `rpc.annotate(Key, value)`, `rpc.annotateMerge(context)`: attach metadata
  (cluster uses `ClusterSchema.Persisted`).
- `RpcGroup.make(...rpcs)`, `.add(...)`, `.merge(...groups)`, `.omit(...tags)`,
  `.prefix("users.")` (tags become `users.GetUser`), `.middleware(Tag)`.
- Handlers: `Group.toLayer(handlersOrEffect)`, `Group.toHandlers(...)` (returns a
  `Context`), `Group.toLayerHandler(tag, handler)` (one procedure),
  `Group.of(handlers)` (type-check a handler object), `Group.accessHandler(tag)`.
- A handler is `(payload, { client, requestId, headers, rpc }) => Effect | Stream`.
  For stream procedures return a `Stream` (or an Effect of a `Queue.Dequeue`).
- Wrap a handler result with `Rpc.fork(effect)` to run it outside the server's
  concurrency limit, `Rpc.uninterruptible(effect)` to run it uninterruptibly.

## Server

| Need | API |
| --- | --- |
| HTTP endpoint on an `HttpRouter` | `RpcServer.layerHttp({ group, path, protocol: "http" })` (omit `protocol` for WebSocket) |
| Same, but get the handler Effect | `RpcServer.toHttpEffect(group)` / `toHttpEffectWebsocket(group)` |
| Raw socket server | `RpcServer.layer(group)` + `RpcServer.layerProtocolSocketServer` (needs `SocketServer`) |
| Worker thread / child process | `RpcServer.layerProtocolWorkerRunner` |
| stdio | `RpcServer.layerProtocolStdio` |
| Tuning | options `concurrency` (default `"unbounded"`), `disableTracing`, `spanPrefix`, `spanAttributes`, `disableFatalDefects`, `streamBufferSize` (http) |

`RpcServer.layerHttp` requires `RpcSerialization`, `HttpRouter`, the group's
handlers and the middleware implementations. Provide them with `Layer.provide`
and serve with `HttpRouter.serve(...)`.

## Client

| Need | API |
| --- | --- |
| Build the client | `RpcClient.make(Group)` (needs a `Protocol`, middleware client layers, and a `Scope`) |
| HTTP protocol | `RpcClient.layerProtocolHttp({ url, transformClient? })` (needs `HttpClient`, `RpcSerialization`) |
| Socket / WebSocket protocol | `RpcClient.layerProtocolSocket({ retryTransientErrors?, retryPolicy?, onTransientError? })` (needs `Socket`, `RpcSerialization`) |
| Worker protocol | `RpcClient.layerProtocolWorker({ size } \| { minSize, maxSize, timeToLive })` |
| One function instead of an object | `RpcClient.make(Group, { flatten: true })` => `client("GetUser", payload)` |
| Headers on a call | `client.Proc(payload, { headers })` or `RpcClient.withHeaders(effect, headers)` |
| Fire and forget | `client.Proc(payload, { discard: true })` (Effect<void>) |
| Stream as a queue | `client.Stream(payload, { asQueue: true })` |
| Service type | `RpcClient.FromGroup<typeof Group, RpcClientError.RpcClientError>` |

Client method types: unary `Effect<Success, Error | MiddlewareError | E>`;
streaming `Stream<A, E | Error | ...>`. `E` is the protocol error
(`RpcClientError` for the built-in protocols).

## Serialization (`RpcSerialization` service)

`layerJson`, `layerNdjson`, `layerNdjsonWith(options)`, `layerJsonRpc()`
(JSON-RPC 2.0 framing), `layerSchemaBinary(options?)` (binary envelopes). Use the same layer on both ends.

## Over WebSocket (typechecked; binds a port, so not run as a doc test)

```ts
import { NodeHttpServer, NodeSocket } from "@effect/platform-node"
import { Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter } from "effect/http"
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import { createServer } from "node:http"

class Rpcs extends RpcGroup.make(
  Rpc.make("Ticks", { payload: { count: Schema.Int }, success: Schema.Int, stream: true })
) {}

const Handlers = Rpcs.toLayer({
  Ticks: ({ count }) => Stream.range(1, count)
})

// protocol defaults to "websocket"; the route is upgraded on /rpc.
export const Server = HttpRouter.serve(
  RpcServer.layerHttp({ group: Rpcs, path: "/rpc" }).pipe(
    Layer.provide(Handlers),
    Layer.provide(RpcSerialization.layerJson)
  )
).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: 3004 })))

// The client protocol is a Socket. retryTransientErrors reconnects on
// transient connection errors; the reconnect loop lives in the layer's Scope.
export const ClientProtocol = RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
  Layer.provide(NodeSocket.layerWebSocket("ws://localhost:3004/rpc")),
  Layer.provide(RpcSerialization.layerJson)
)

export const program = Effect.gen(function*() {
  const client = yield* RpcClient.make(Rpcs)
  return yield* Stream.runCollect(client.Ticks({ count: 3 })) // [1, 2, 3]
}).pipe(Effect.provide(ClientProtocol), Effect.scoped)
```

## Batching over the HTTP protocol (4.0.x+)

`layerProtocolHttp({ url, batch: { window, maxSize? } })` groups calls made
within `window` into one HTTP request (`maxSize` flushes early). Measured against
a real ephemeral-port server: three concurrent `Square` calls cost one HTTP
request with `batch`, three without. Typechecked, not a doc test (it serves).

```ts
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Ref, Schema } from "effect"
import { HttpClient, HttpRouter } from "effect/http"
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"

class Rpcs extends RpcGroup.make(
  Rpc.make("Square", { payload: { n: Schema.Int }, success: Schema.Int })
) {}

const Handlers = Rpcs.toLayer({ Square: ({ n }) => Effect.succeed(n * n) })

const Server = RpcServer.layerHttp({ group: Rpcs, path: "/", protocol: "http" }).pipe(
  Layer.provide(Handlers),
  Layer.provide(RpcSerialization.layerJson)
)

// NodeHttpServer.layerTest serves on an ephemeral port and provides an
// HttpClient already pointed at it, hence the empty client url.
export const run = (batch: boolean) =>
  Effect.gen(function*() {
    const wire = yield* Ref.make(0)
    const client = yield* RpcClient.make(Rpcs).pipe(
      Effect.provide(
        RpcClient.layerProtocolHttp({
          url: "",
          transformClient: (c) => HttpClient.tapRequest(c, () => Ref.update(wire, (n) => n + 1)),
          ...(batch ? { batch: { window: "10 millis", maxSize: 10 } } : {})
        }).pipe(Layer.provide(RpcSerialization.layerJson))
      )
    )
    const results = yield* Effect.all([2, 3, 4].map((n) => client.Square({ n })), { concurrency: "unbounded" })
    return { results, httpRequests: yield* Ref.get(wire) } // batch: { [4, 9, 16], 1 }; otherwise 3
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(HttpRouter.serve(Server, { disableLogger: true }), NodeHttpServer.layerTest))
  )
```

## Middleware end to end, tested in memory

```ts import.meta.vitest name="references/rpc/rpc-cheatsheet.md#2"
import assert from "node:assert/strict"
import { Context, Effect, Layer, Schema } from "effect"
import { Rpc, RpcClient, RpcGroup, RpcMiddleware, RpcTest } from "effect/rpc"

class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
class CurrentUser extends Context.Service<CurrentUser, { readonly name: string }>()("app/CurrentUser") {}

class Auth extends RpcMiddleware.Service<Auth, { provides: CurrentUser }>()("app/Auth", {
  error: Unauthorized,
  requiredForClient: true
}) {}

class Rpcs extends RpcGroup.make(
  Rpc.make("WhoAmI", { success: Schema.String })
).middleware(Auth) {}

// Server: reads headers, provides CurrentUser or fails with the declared error.
const AuthLive = Layer.succeed(Auth)((effect, { headers }) =>
  headers["authorization"] === "Bearer ada"
    ? Effect.provideService(effect, CurrentUser, { name: "ada" })
    : Effect.fail(new Unauthorized())
)

// Client: runs before the request leaves; here a pass-through. A real client
// would set a header on the request via `next(...)`.
const AuthClient = RpcMiddleware.layerClient(Auth, ({ request, next }) => next(request))

// `CurrentUser` is available because Auth is attached to the group.
const HandlersLive = Rpcs.toLayer({
  WhoAmI: () => Effect.map(CurrentUser, (user) => user.name)
})

const program = Effect.gen(function*() {
  const client = yield* RpcTest.makeClient(Rpcs)
  const ok = yield* RpcClient.withHeaders(client.WhoAmI(), { authorization: "Bearer ada" })
  assert.equal(ok, "ada")
  const denied = yield* Effect.flip(client.WhoAmI())
  assert.equal(denied._tag, "Unauthorized")
}).pipe(
  Effect.scoped,
  Effect.provide(Layer.mergeAll(HandlersLive, AuthLive, AuthClient))
)

await Effect.runPromise(program)
```

## Reading the types

- `Rpc<Tag, Payload, Success, Error, Middleware, Requires>`: hover an Rpc to see
  the encoding and decoding services; `Rpc.ToHandler<R>` is the context key a
  handlers layer provides and `RpcServer` requires.
- `RpcGroup.HandlersFrom<R>` is the handler object type; the compiler rejects a
  missing or misspelled tag.
- A handler's `R` surfaces in the type of the layer that `toLayer` returns; any
  service that remains must be provided before `RpcServer.layerHttp` is run.
- `Rpc.Middleware<Rpcs>` is the set of middleware tags the server must have
  implementations for; `Rpc.MiddlewareClient<Rpcs>` is the set clients with
  `requiredForClient: true` must implement.
