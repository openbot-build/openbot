# Effect RPC: typed calls between your own processes

## How to think about it

REST makes you design URLs, verbs, status codes and a documentation format.
When both ends are yours, that is accidental work. RPC removes it: you declare
**procedures** (`Rpc.make("GetUser", { payload, success, error })`), group them
(`RpcGroup.make(...)`), and the group is the whole contract. A server turns the
group plus handlers into a protocol endpoint; a client turns the same group
into an object with one method per procedure. Both sides encode and decode with
the schemas, so a payload that does not match never reaches a handler, and a
result the handler produces is checked before it is sent.

Three separations make it work, and you should keep them separate in code:

1. **Contract** (the `RpcGroup`, its schemas, error classes, middleware tags)
   knows nothing about transport. Put it in a module both sides import.
2. **Handlers** are an ordinary Layer (`Group.toLayer(...)`) whose `R` is your
   services. A handler takes the decoded payload and returns an Effect (or a
   `Stream` for streaming procedures).
3. **Transport and serialization** are two more layers: a *protocol*
   (`RpcServer.layerHttp`, `RpcClient.layerProtocolHttp`, sockets, workers) and an
   `RpcSerialization` (`layerJson`, `layerNdjson`, ...). Changing from HTTP to
   WebSocket changes layers, not contract or handlers.

What people coming from tRPC/gRPC/REST get wrong:

- **There are three failure channels on the client.** The typed error you
  declared (`UserNotFound`), `RpcClientError` (the transport failed: connection
  lost, protocol decode error), and defects. Only the first is domain logic.
- **Defects cross the wire.** Unlike [http-api](../http-api/guide.md) (undeclared failure is a
  bare 500), an RPC defect is serialized with `Schema.Defect` and **its message
  reaches the client**. Redact it in middleware (recipe below).
- **A disconnect is ambiguous.** The client cannot know whether the server ran
  a non-idempotent call. Do not blindly retry mutations.
- **Streaming procedures are values, not callbacks.** A procedure declared with
  `stream: true` returns a `Stream` on both sides; interrupting the client's
  stream interrupts the server's.

## Choose

| Situation | Use | Why |
| --- | --- | --- |
| Backend-to-backend or browser-to-your-backend calls where you own both ends | `RpcGroup` + `RpcServer.layerHttp` | typed, no URL/status design |
| Public API, third-party consumers, OpenAPI | [http-api](../http-api/guide.md) | resources, status codes and docs are the product |
| Request/response over plain HTTP | `layerHttp({ protocol: "http" })` + `RpcClient.layerProtocolHttp` | simplest; works through proxies |
| Long-lived connection, many calls or streams | WebSocket (`layerHttp` default, client `layerProtocolSocket` + `NodeSocket.layerWebSocket`) | one connection, server push |
| Child process or worker thread | `RpcServer.layerProtocolWorkerRunner` / `RpcClient.layerProtocolWorker` | same contract over a worker port |
| Streaming results | `Rpc.make(tag, { success, error, stream: true })` | handler returns `Stream`, client gets `Stream` |
| Cross-cutting auth or tenant context | `RpcMiddleware.Service` + `Group.middleware(Tag)` | provides a service to handlers; client side sends headers |
| Sharding / entities by id | [cluster](../cluster/guide.md) | entities are Rpc groups routed by key |
| Durable multi-step jobs | [workflow](../workflow/guide.md) | RPC calls alone are not durable |
| In-process calls | a plain service | RPC adds encoding and failure modes you do not need |

## Recipe

### Pitfall first

```ts skip
// A TypeScript interface is not a protocol: nothing validates the wire,
// errors are strings, and client and server drift silently.
interface UserApi { getUser(id: string): Promise<{ id: string; name: string }> }
const user = (await (await fetch("/rpc/getUser", { method: "POST", body: JSON.stringify({ id }) })).json()) as User
```

### Contract, handlers, server and client

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { Rpc, RpcClient, RpcClientError, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import { createServer } from "node:http"

// ---------- contract: import-able by client and server, no transport code ----------

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export class User extends Schema.Class<User>("User")({
  id: UserId,
  name: Schema.String
}) {}

// A declared error is data the client can `catchTag`. It crosses the wire.
export class UserNotFound extends Schema.TaggedError<UserNotFound>()("UserNotFound", {
  id: UserId
}) {}

export class UserRpcs extends RpcGroup.make(
  // payload as a fields record becomes a Struct; success/error are schemas.
  Rpc.make("GetUser", { payload: { id: UserId }, success: User, error: UserNotFound }),
  // stream: true => handler returns Stream<User>, client receives Stream<User>.
  Rpc.make("ListUsers", { success: User, stream: true }),
  // no payload, void success: a fire-and-check health probe.
  Rpc.make("Ping")
) {}

// ---------- server side ----------

// Handlers talk to a domain service, never to storage directly.
export class Users extends Context.Service<Users, {
  get(id: UserId): Effect.Effect<User, UserNotFound>
  readonly all: Effect.Effect<ReadonlyArray<User>>
}>()("app/Users") {
  static readonly layerMemory = Layer.succeed(Users)({
    get: (id) => id === "1" ? Effect.succeed(new User({ id, name: "Ada" })) : Effect.fail(new UserNotFound({ id })),
    all: Effect.succeed([new User({ id: UserId.make("1"), name: "Ada" })])
  })
}

// `toLayer` takes an Effect so the handlers can `yield*` their services once,
// at layer build time. The object must have exactly one handler per Rpc tag.
export const UserHandlers = UserRpcs.toLayer(Effect.gen(function*() {
  const users = yield* Users
  return {
    GetUser: ({ id }) => users.get(id), // may fail only with UserNotFound
    ListUsers: () => Stream.unwrap(Effect.map(users.all, Stream.fromIterable)),
    Ping: () => Effect.void
  }
}))

// Serving: the protocol endpoint is a route on an HttpRouter, so it is served
// like any other app layer. "http" = request/response; omit for WebSocket.
export const RpcRoutes = RpcServer.layerHttp({ group: UserRpcs, path: "/rpc", protocol: "http" }).pipe(
  Layer.provide(UserHandlers),
  Layer.provide(Users.layerMemory),
  // NDJSON frames each message on its own line, which suits streams;
  // layerJson also works. Client and server must pick the same one.
  Layer.provide(RpcSerialization.layerNdjson)
)

export const ServerLayer = HttpRouter.serve(RpcRoutes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3001 }))
)

// ---------- client side ----------

// `RpcClient.FromGroup<Group, E>`: E is the transport error every call may add.
export class UsersClient extends Context.Service<
  UsersClient,
  RpcClient.FromGroup<typeof UserRpcs, RpcClientError.RpcClientError>
>()("app/UsersClient") {
  static readonly layer = Layer.effect(UsersClient, RpcClient.make(UserRpcs)).pipe(
    Layer.provide(RpcClient.layerProtocolHttp({ url: "http://localhost:3001/rpc" })),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(FetchHttpClient.layer)
  )
}

// Types: GetUser: Effect<User, UserNotFound | RpcClientError>,
//        ListUsers: Stream<User, RpcClientError>.
export const demo = Effect.gen(function*() {
  const client = yield* UsersClient
  return yield* client.GetUser({ id: UserId.make("1") }).pipe(
    // Domain failure handled by tag; RpcClientError (transport) stays in E.
    Effect.catchTag("UserNotFound", () => Effect.succeed(new User({ id: UserId.make("0"), name: "nobody" })))
  )
}).pipe(Effect.provide(UsersClient.layer))

// Run once, at the edge.
if (process.argv[1]?.endsWith("main.ts")) {
  Layer.launch(ServerLayer).pipe(NodeRuntime.runMain)
}
```

Checked against a running server: `GetUser` returns the `User`, an unknown id
fails with a decoded `UserNotFound` instance, `ListUsers` yields users,
`Ping` returns `undefined`.

### Middleware: identity in, secrets out

```ts import.meta.vitest name="references/rpc/guide.md#3"
import { Context, Effect, Layer, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
export class CurrentUser extends Context.Service<CurrentUser, { readonly name: string }>()("app/CurrentUser") {}

// Declaration (part of the contract). `provides` is what handlers may `yield*`
// once this middleware is attached; `requiredForClient` forces every client to
// supply a client-side implementation (it sends the credential).
export class Auth extends RpcMiddleware.Service<Auth, { provides: CurrentUser }>()("app/Auth", {
  error: Unauthorized,
  requiredForClient: true
}) {}

// Cross-cutting redaction: defects would otherwise reach clients verbatim.
export class Redact extends RpcMiddleware.Service<Redact>()("app/Redact") {}

export class SecureRpcs extends RpcGroup.make(
  Rpc.make("WhoAmI", { success: Schema.String })
).middleware(Redact).middleware(Auth) {}

// Implementations are layers, provided only where the server is assembled.
export const AuthLive = Layer.succeed(Auth)((effect, { headers }) =>
  headers["authorization"] === "Bearer ada"
    ? Effect.provideService(effect, CurrentUser, { name: "ada" })
    : Effect.fail(new Unauthorized())
)

export const RedactLive = Layer.succeed(Redact)((effect) =>
  Effect.catchDefect(effect, (defect) =>
    // Log the real defect server-side, send a generic one to the client.
    Effect.logError("rpc defect", defect).pipe(Effect.andThen(Effect.die(new Error("Internal error")))))
)

export const SecureHandlers = SecureRpcs.toLayer({
  WhoAmI: () => Effect.map(CurrentUser, (user) => user.name)
})

// Client side: `RpcMiddleware.layerClient(Auth, ({ request, next }) => next(request))`
// must be provided to RpcClient.make; send credentials per call with
// RpcClient.withHeaders(effect, { authorization: "Bearer ..." }).
```

## Anti-patterns

1. **Unvalidated wire types.** A shared TypeScript `interface` with
   `fetch(...).json() as T` (see the pitfall). Use an `RpcGroup`: both sides
   decode with the same schemas.

2. **Leaking defects.**

   ```ts skip
   GetUser: ({ id }) => db.query(id).pipe(Effect.orDie) // message and stack reach the client
   ```

   `Effect.orDie` is right for the *type*, but the defect is then serialized to
   the caller. Add a redaction middleware (`Effect.catchDefect`) or map to a
   generic die at the boundary.

3. **Retrying mutations on any failure.**

   ```ts skip
   client.CreateOrder(order).pipe(Effect.retry(Schedule.recurs(3)))
   ```

   An `RpcClientError` after the server committed creates duplicates. Retry only
   idempotent procedures, or carry an idempotency key in the payload and make
   the handler honour it.

4. **Mismatched serialization.** The server's `RpcSerialization` layer and the
   client's must be the same, and the compiler cannot check that they are. Pick one
   serialization per transport and share it next to the contract.

5. **Fat errors.** Putting `SqlError` or provider SDK errors in `error:` couples
   clients to your internals and exposes details. Declare small domain errors
   and `orDie` the rest (with the redaction above).

6. **Opening a client per call.** `RpcClient.make` holds a connection/protocol
   and needs a `Scope`. Build it once in a service layer (as `UsersClient`),
   not inside the function that uses it.

7. **Assuming handlers run one at a time.** The server runs requests
   concurrently (`concurrency` defaults to `"unbounded"`). Shared state in a
   plain `let` races; use `Ref` or a service ([state](../state/guide.md)), or bound the
   server with `RpcServer.layerHttp({ ..., concurrency: 1 })`. Opt single
   handlers out of the limit with `Rpc.fork`.

8. **Making the contract depend on the server.** Importing the handler
   module's types in the contract drags your database into the browser bundle.
   Keep contract files free of service imports.

## Testing it

`RpcTest.makeClient(Group)` wires a client directly to the handlers in memory,
with no serialization and no network. Provide your handlers layer (with test
doubles for its services) and any middleware implementations.

```ts import.meta.vitest name="references/rpc/guide.md#4"
import assert from "node:assert/strict"
import { Effect, Layer, Schema, Stream } from "effect"
import { Rpc, RpcGroup, RpcTest } from "effect/rpc"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }) {}

class Rpcs extends RpcGroup.make(
  Rpc.make("Get", { payload: { id: Schema.String }, success: Schema.String, error: NotFound }),
  Rpc.make("Count", { payload: { to: Schema.Int }, success: Schema.Int, stream: true })
) {}

const Handlers = Rpcs.toLayer({
  Get: ({ id }) => id === "a" ? Effect.succeed("alpha") : Effect.fail(new NotFound({ id })),
  Count: ({ to }) => Stream.range(1, to)
})

const program = Effect.gen(function*() {
  const client = yield* RpcTest.makeClient(Rpcs)
  assert.equal(yield* client.Get({ id: "a" }), "alpha")
  // The declared error is in E; flip it to assert on it.
  const error = yield* Effect.flip(client.Get({ id: "z" }))
  assert.equal(error._tag, "NotFound")
  // Streams come back as Stream.
  assert.deepEqual(Array.from(yield* Stream.runCollect(client.Count({ to: 3 }))), [1, 2, 3])
}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(Handlers)))

await Effect.runPromise(program)
```

Because `RpcTest` skips serialization, it cannot catch a payload that does not
encode (for example a `Date` where the schema expects a string). For wire
behaviour, serve the real layer on an ephemeral port and use the HTTP
protocol (see [http](../http/guide.md) for `NodeHttpServer.layerTest`), or run the
contract once through `RpcSerialization.layerJson` in a smoke test. With a
middleware in the group, also provide its server layer and its
`RpcMiddleware.layerClient(...)`; the worked example in
[references/rpc-cheatsheet.md](rpc-cheatsheet.md) does this. 

With `@effect/vitest`, each case is an `it.effect` (it supplies the `Scope`
that `RpcTest.makeClient` needs, and a `TestClock`). Run it with `vitest`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { Rpc, RpcGroup, RpcTest } from "effect/rpc"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }) {}

class Rpcs extends RpcGroup.make(
  Rpc.make("Get", { payload: { id: Schema.String }, success: Schema.String, error: NotFound }),
  Rpc.make("Count", { payload: { to: Schema.Int }, success: Schema.Int, stream: true })
) {}

const Handlers = Rpcs.toLayer({
  Get: ({ id }) => id === "a" ? Effect.succeed("alpha") : Effect.fail(new NotFound({ id })),
  Count: ({ to }) => Stream.range(1, to)
})

describe("Rpcs", () => {
  it.effect("returns a value and a typed failure", () =>
    Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(Rpcs)
      assert.strictEqual(yield* client.Get({ id: "a" }), "alpha")
      const error = yield* Effect.flip(client.Get({ id: "z" }))
      assert.strictEqual(error._tag, "NotFound")
    }).pipe(Effect.provide(Handlers)))

  it.effect("streams", () =>
    Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(Rpcs)
      assert.deepStrictEqual(Array.from(yield* Stream.runCollect(client.Count({ to: 3 }))), [1, 2, 3])
    }).pipe(Effect.provide(Handlers)))
})
```

## Boundaries

- [http-api](../http-api/guide.md) is the alternative for resource-style APIs with OpenAPI and
  status codes. Both serve through `HttpRouter` (see [http](../http/guide.md)).
- [schema](../schema/guide.md) owns payload, success and error schemas, `Schema.TaggedError`,
  `Schema.Defect`, branding.
- [streams](../streams/guide.md) owns what you do with the `Stream` a streaming procedure
  gives you (backpressure, `Stream.runCollect`, `take`).
- [services](../services/guide.md) owns the service/layer pattern (`Users`, `UsersClient`) and
  how middleware tags are provided.
- [cluster](../cluster/guide.md) builds entities on `Rpc.make` and `RpcGroup`; it adds
  routing by entity id, persistence and passivation.
- [workflow](../workflow/guide.md) owns durable multi-step execution that survives restarts.
- [platform](../platform/guide.md) owns Node sockets, workers and `NodeSocket.layerWebSocket`.
- [testing](../testing/guide.md) owns `it.effect`, `TestClock`.
- Errors cross here: declared errors encode and decode as data, transport
  failures become `RpcClientError`, defects cross with their message unless you
  redact. Resources cross here: server protocol layers and `RpcClient.make` own
  connections via `Scope`; an interrupted client call interrupts the server
  fiber.

## Changed in 4.1

Verified against the 4.0.0 and 4.1.2 sources:

- `RpcClient.layerProtocolHttp({ url, batch: { window, maxSize? } })` (and
  `makeProtocolHttp(client, { batch })`) send concurrent calls from one client as
  a single HTTP request; see the batching example in the
  [cheat sheet](rpc-cheatsheet.md).
- Fire-and-forget (`discard`) requests are now carried on the request message
  itself and answered with a decoded discard exit, so they behave the same over
  every protocol.
- HTTP protocol client failures stay `RpcClientError` (`HttpError` /
  `RpcClientDefect`); handle them with `catchTag("RpcClientError")` as before.

## References

- [RPC cheat sheet, transports and a middleware test](rpc-cheatsheet.md)
- [Rpc API](https://effect.website/docs/v4/api/effect/rpc/Rpc)
- [RpcGroup API](https://effect.website/docs/v4/api/effect/rpc/RpcGroup)
- [RpcServer API](https://effect.website/docs/v4/api/effect/rpc/RpcServer)
- [RpcClient API](https://effect.website/docs/v4/api/effect/rpc/RpcClient)
- [RpcMiddleware API](https://effect.website/docs/v4/api/effect/rpc/RpcMiddleware)
- [Rpc source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/rpc/Rpc.ts)
- [RpcServer source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/rpc/RpcServer.ts)
- [Socket source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/socket/Socket.ts)
