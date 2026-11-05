# Effect HTTP API: contract first

## How to think about it

A hand-written HTTP service says the same thing four times: the router
(path and method), the validation (what a body or param must look like), the
error mapping (which failure is which status), and the docs or client (what
callers may send). They drift. `HttpApi` collapses the four into one value, the
**contract**, built from `Schema`s. From that single value the library derives
the server routes (decode request, encode response, render errors), a typed
client, and the OpenAPI document. If it compiles, the client, server and docs
agree.

The second idea is a hard split between **definition** and **implementation**.
The contract (`HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`, error and
middleware *tags*) imports nothing from your server, so a client package can
import it without dragging in the database. The implementation
(`HttpApiBuilder.group` handlers, middleware *layers*) is ordinary Effect code
whose `R` is your services. Handlers receive already-decoded values and return
domain values or fail with the endpoint's declared errors; they never see JSON.

The third idea is that **errors are part of the contract**. An endpoint
declares its failure schemas, each with a status code; a handler can only fail
with those (plus middleware errors). Everything else is a defect, rendered as a
500 with no details. People coming from Express expect `res.status(404)` in the
handler, and people coming from NestJS expect exception filters. Here you
`return yield* new TaskNotFound({ id })`, the status lives on the error class,
and the same error class decodes on the client.

## Choose

| Situation | Use | Why |
| --- | --- | --- |
| Public or shared JSON API with several endpoints | `HttpApi` + groups + endpoints | one contract yields server, client and OpenAPI |
| Share the contract with a browser or another service | contract in its own module/package | clients import types and schemas only |
| Failure with a status the client should handle | `Schema.TaggedError<Self>()(tag, fields, { httpApiStatus: 404 })` in `error:` | status travels with the error; client gets the typed class back |
| Common HTTP errors (401/403/404/409...) with no custom fields | built-ins in `HttpApiError` (e.g. `HttpApiError.NotFound`) | no new class to write |
| Infra failure (db down) | `Effect.orDie` in the handler | becomes 500, not part of the contract |
| Auth on a group or endpoint | `HttpApiMiddleware.Service` with `security:` + `.middleware(Auth)` | credentials decoded for you, OpenAPI gets the scheme, the current user is provided via `R` |
| Typed client | `HttpApiClient.make(Api)` | mirrors the contract; `client.group.endpoint({ params, query, payload })` |
| Docs UI | `HttpApiScalar.layer(Api, { path })` (or `HttpApiSwagger.layer`) and `HttpApiBuilder.layer(Api, { openapiPath })` | derived from the contract |
| Tests without a socket | `HttpApiTest.groups(Api, [...])` | same codecs and middleware, in memory |
| A webhook, proxy, file stream or one route | `HttpRouter` (see [http](../http/guide.md)) | a contract is overhead for one-offs |
| Internal service-to-service calls you own both ends of | [rpc](../rpc/guide.md) | no URL or status design |

## Recipe

### Pitfall first

```ts skip
// Validation, status mapping and docs are separate and can disagree.
router.get("/tasks/:id", async (req, res) => {
  const task = await db.find(req.params.id)          // id never validated
  if (!task) return res.status(404).json({ error: "nope" }) // shape documented nowhere
  res.json(task)                                      // leaks internal fields, unchecked
})
```

### The whole shape, end to end

One file here for readability; in a real project the contract section is its
own module and the rest is the server.

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Context, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { HttpRouter } from "effect/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiScalar,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi
} from "effect/http-api"
import { createServer } from "node:http"

// ---------- contract (no server imports below this line until "server") ----------

// Brand ids so a TaskId cannot be confused with any other string.
export const TaskId = Schema.String.pipe(Schema.brand("TaskId"))
export type TaskId = typeof TaskId.Type

// The WIRE shape. Deliberately has no `owner`: internal fields never reach a
// success schema, because whatever the handler returns is encoded through it.
export class Task extends Schema.Class<Task>("Task")({
  id: TaskId,
  title: Schema.String,
  done: Schema.Boolean
}) {}

export const CreateTask = Schema.Struct({ title: Schema.NonEmptyString })

// Expected failures are tagged data; the status lives on the class. The same
// class is decoded by the generated client, so callers can `catchTag` it.
export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()(
  "TaskNotFound",
  { id: TaskId },
  { httpApiStatus: 404 }
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 }
) {}

// What authentication gives to handlers. The middleware PROVIDES it, so a
// handler that does `yield* CurrentUser` type-checks only behind the middleware.
export class CurrentUser extends Context.Service<CurrentUser, { readonly name: string }>()("app/CurrentUser") {}

export class Authorization extends HttpApiMiddleware.Service<Authorization, {
  provides: CurrentUser
  requires: never
}>()("app/Authorization", {
  // The CLIENT must supply a matching implementation (it adds the token).
  requiredForClient: true,
  // Declares the scheme: OpenAPI documents it and the router decodes the
  // Authorization header into `credential` for you.
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized
}) {}

export class TasksGroup extends HttpApiGroup.make("tasks")
  .add(
    HttpApiEndpoint.get("list", "/", {
      // Query values arrive as strings and are coerced by the schema.
      query: { done: Schema.optional(Schema.Boolean) },
      success: Schema.Array(Task)
    }),
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: TaskId },
      success: Task,
      error: TaskNotFound
    }),
    HttpApiEndpoint.post("create", "/", {
      payload: CreateTask, // POST payload is the JSON body
      success: Task.pipe(HttpApiSchema.status(201))
    }),
    HttpApiEndpoint.post("complete", "/:id/complete", {
      params: { id: TaskId },
      success: HttpApiSchema.NoContent, // 204
      error: TaskNotFound
    })
  )
  .middleware(Authorization) // every endpoint above requires auth
  .prefix("/tasks")
{}

// `topLevel: true` puts `health` at the root of the generated client.
export class SystemGroup extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent })
) {}

export class Api extends HttpApi.make("tasks-api")
  .add(TasksGroup)
  .add(SystemGroup)
  .annotateMerge(OpenApi.annotations({ title: "Tasks" }))
{}

// ---------- server ----------

// The domain service knows nothing about HTTP. `owner` scopes data per user.
export class Tasks extends Context.Service<Tasks, {
  list(owner: string, done: boolean | undefined): Effect.Effect<ReadonlyArray<Task>>
  get(owner: string, id: TaskId): Effect.Effect<Task, TaskNotFound>
  create(owner: string, title: string): Effect.Effect<Task>
  complete(owner: string, id: TaskId): Effect.Effect<void, TaskNotFound>
}>()("app/Tasks") {
  static readonly layerMemory = Layer.effect(
    Tasks,
    Effect.gen(function*() {
      const store = yield* Ref.make(new Map<TaskId, { readonly owner: string; readonly task: Task }>())
      const find = Effect.fnUntraced(function*(owner: string, id: TaskId) {
        const row = (yield* Ref.get(store)).get(id)
        // Someone else's task is "not found", not "forbidden": do not leak existence.
        return row !== undefined && row.owner === owner ? row.task : yield* new TaskNotFound({ id })
      })
      return Tasks.of({
        list: (owner, done) =>
          Ref.get(store).pipe(
            Effect.map((rows) =>
              [...rows.values()]
                .filter((row) => row.owner === owner && (done === undefined || row.task.done === done))
                .map((row) => row.task)
            )
          ),
        get: find,
        create: Effect.fn("Tasks.create")(function*(owner, title) {
          const task = new Task({ id: TaskId.make(crypto.randomUUID()), title, done: false })
          yield* Ref.update(store, (rows) => new Map(rows).set(task.id, { owner, task }))
          return task
        }),
        complete: Effect.fn("Tasks.complete")(function*(owner, id) {
          const task = yield* find(owner, id)
          yield* Ref.update(store, (rows) => new Map(rows).set(id, { owner, task: new Task({ ...task, done: true }) }))
        })
      })
    })
  )
}

// Middleware IMPLEMENTATION is a separate layer from its declaration, so the
// declaration can live in the shared contract. One function per security scheme.
export const AuthorizationLayer = Layer.succeed(Authorization)({
  bearer: (httpEffect, { credential }) => {
    const token = Redacted.value(credential) // credentials are Redacted: they do not log
    return token.startsWith("user:")
      ? Effect.provideService(httpEffect, CurrentUser, { name: token.slice(5) })
      : Effect.fail(new Unauthorized({ message: "invalid token" }))
  }
})

// Handlers: decoded request in, domain value or declared error out. The
// requirement `Tasks` is acquired once, when the layer is built.
export const TasksHandlers = HttpApiBuilder.group(
  Api,
  "tasks",
  Effect.fn(function*(handlers) {
    const tasks = yield* Tasks
    return handlers.handleAll({
      list: Effect.fn(function*({ query }) {
        const user = yield* CurrentUser
        return yield* tasks.list(user.name, query.done)
      }),
      get: Effect.fn(function*({ params }) {
        const user = yield* CurrentUser
        return yield* tasks.get(user.name, params.id)
      }),
      create: Effect.fn(function*({ payload }) {
        const user = yield* CurrentUser
        return yield* tasks.create(user.name, payload.title)
      }),
      complete: Effect.fn(function*({ params }) {
        const user = yield* CurrentUser
        yield* tasks.complete(user.name, params.id)
      })
    })
  })
)

export const SystemHandlers = HttpApiBuilder.group(
  Api,
  "system",
  Effect.fn(function*(handlers) {
    return handlers.handle("health", () => Effect.void)
  })
)

// Assembly. The compiler fails if a group has no handlers or a handler's
// requirements are not provided.
const ApiRoutes = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([TasksHandlers, SystemHandlers]),
  Layer.provide([Tasks.layerMemory, AuthorizationLayer])
)
const Docs = HttpApiScalar.layer(Api, { path: "/docs" })

export const ServerLayer = HttpRouter.serve(Layer.mergeAll(ApiRoutes, Docs)).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

if (process.argv[1]?.endsWith("main.ts")) {
  Layer.launch(ServerLayer).pipe(NodeRuntime.runMain)
}
```

What the compiler now enforces for you: a handler returning a field the
success schema lacks is an error; failing with an error not declared on the
endpoint (and not a middleware error) is an error; forgetting a group's
handlers is an error (`Endpoint not handled: ...`); `CurrentUser` is available
exactly in endpoints behind `Authorization`.

Behaviours worth knowing (checked against a running server): a body that fails
the payload schema returns **400 with an empty body**; a missing or bad token
returns the `Unauthorized` schema as JSON with status 401; `NoContent` is 204;
`Task.pipe(HttpApiSchema.status(201))` makes the success status 201.
`HttpApiMiddleware.layerSchemaErrorTransform` customises the 400 body.

### A typed client

`HttpApiClient.make(Api, { baseUrl })` returns an object mirroring the
contract (`client.tasks.get({ params: { id } })`), whose `E` is the endpoint's
declared errors plus `HttpClientError | SchemaError`. Branch on declared errors
with `Effect.catchTag`. Build it once in a service layer, with
`HttpApiMiddleware.layerClient(Authorization, ...)` supplying the token when
the middleware is `requiredForClient`. Complete compiled examples, including
`transformClient` retries and `responseMode`, are in
[references/client-and-testing.md](client-and-testing.md).

## Anti-patterns

1. **Returning the domain object straight to the wire.**

   ```ts skip
   success: UserRow  // includes passwordHash
   ```

   Every field of the success schema is public API. Define a wire schema
   (`User.json`-style projection) and return only that.

2. **Untyped, ad-hoc errors.**

   ```ts skip
   handle("get", ({ params }) => Effect.fail(new Error("not found")))
   ```

   Not assignable to the endpoint's `E`; if forced with `as`, it renders a 500.
   Declare `error: TaskNotFound` (with `httpApiStatus`) and fail with it.

3. **Exposing internal errors.** Putting `SqlError` or a provider SDK error in
   `error:` leaks messages and couples clients to your database. Keep infra
   failures out with `Effect.orDie` and expose only domain errors.

4. **Re-checking auth in every handler.** Copy-pasted `if (!token)` checks get
   forgotten on one endpoint. Put it in `HttpApiMiddleware.Service` and attach
   with `.middleware(Auth)` on the group; the identity arrives as a typed
   service.

5. **Implementing the contract with a one-off Router.** Mixing `HttpRouter.add`
   routes for endpoints that are also declared in the contract means two
   sources of truth. Use `HttpApiBuilder.group`; reserve `HttpRouter` for what
   the contract cannot express.

6. **Authorization by trusting an id from the client.** `get(id)` without
   scoping by the current user lets user A read user B's row. Pass
   `CurrentUser` into the service and return `NotFound` for rows that are not
   theirs (as `Tasks.find` does).

7. **Sending a body with GET.**

   ```ts skip
   HttpApiEndpoint.get("search", "/search", { payload: { q: Schema.String } })
   ```

   For methods without a body, `payload` is read from the query string, so the
   name misleads. Write `query:` and keep the contract honest.

8. **Hand-writing the OpenAPI.** A separate YAML drifts. Annotate with
   `OpenApi.annotations({...})` on the api, group, endpoint or schema and serve
   `openapiPath`. Review the output; do not fork it.

## Testing it

`HttpApiTest.groups(Api, [...])` builds a typed client wired straight to your
handlers, with the real routing, codecs and middleware, and no socket.
Swap the real service for an in-memory layer.

```ts import.meta.vitest name="references/http-api/guide.md#3"
import assert from "node:assert/strict"
import { Effect, Layer, Schema } from "effect"
import { HttpServer } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiTest } from "effect/http-api"

class NoteMissing extends Schema.TaggedError<NoteMissing>()("NoteMissing", { id: Schema.String }, {
  httpApiStatus: 404
}) {}
const Note = Schema.Struct({ id: Schema.String, text: Schema.String })
class Api extends HttpApi.make("notes").add(
  HttpApiGroup.make("notes").add(
    HttpApiEndpoint.get("get", "/notes/:id", { params: { id: Schema.String }, success: Note, error: NoteMissing })
  )
) {}

// Handlers under test; swap their dependencies by providing other layers.
const NotesHandlers = HttpApiBuilder.group(
  Api,
  "notes",
  Effect.fn(function*(handlers) {
    return handlers.handle("get", ({ params }) =>
      params.id === "1" ? Effect.succeed({ id: "1", text: "hello" }) : Effect.fail(new NoteMissing({ id: params.id })))
  })
)

const makeClient = HttpApiTest.groups(Api, ["notes"])

const program = Effect.gen(function*() {
  const client = yield* makeClient
  const note = yield* client.notes.get({ params: { id: "1" } })
  assert.equal(note.text, "hello")
  // The error channel is typed: flip it to assert on it.
  const error = yield* Effect.flip(client.notes.get({ params: { id: "2" } }))
  assert.equal(error._tag, "NoteMissing")
}).pipe(
  // layerServices supplies the platform services the HTTP pipeline needs.
  Effect.provide(Layer.mergeAll(NotesHandlers, HttpServer.layerServices)),
  Effect.scoped
)

await Effect.runPromise(program)
```

With an auth middleware, provide its implementation to the handlers
(`Layer.provideMerge(AuthorizationLayer)`) and a client-side
`HttpApiMiddleware.layerClient(Authorization, ...)` that sets (or omits, or
corrupts) the bearer token, then assert `Unauthorized`; a full version is in
[references/client-and-testing.md](client-and-testing.md). For a
black-box check including wire status codes and bodies, serve with
`NodeHttpServer.layerTest` as shown in [http](../http/guide.md). With `@effect/vitest`
wrap each body in `it.effect` (see the worked test in [rpc](../rpc/guide.md#testing-it)
and the upstream `ai-docs/src/51_http-server/20_testing.ts`).

## Boundaries

- [http](../http/guide.md) owns the transport below this: `HttpRouter`, `HttpClient`,
  `HttpServerResponse`, `NodeHttpServer`. `HttpApiBuilder.layer` produces
  routes that `HttpRouter.serve` serves.
- [schema](../schema/guide.md) owns how request and response schemas decode (branding,
  `Schema.Class`, `optional`, transformations, `Schema.TaggedError`).
- [services](../services/guide.md) owns the `Context.Service` + layer pattern behind `Tasks`
  and `Authorization`, and `provide` vs `provideMerge`.
- [core](../core/guide.md) owns the error philosophy: what is a typed error vs a defect
  (`orDie`), `catchTag`.
- [sql](../sql/guide.md) owns the database service your handlers should call; keep SQL
  errors out of the contract.
- [rpc](../rpc/guide.md) is the alternative when both ends are yours and you do not need
  REST semantics or OpenAPI.
- [testing](../testing/guide.md) owns `it.effect` and `TestClock`.
- Errors cross here: domain errors become status codes via `httpApiStatus`;
  everything undeclared is a 500. Resources cross here: the server is a Layer,
  so its socket is closed with the Scope; handlers need no cleanup.

## Changed in 4.1

Verified against the 4.0.0 and 4.1.2 sources (most arrived in 4.0.6):

- `HttpApiSchema.StreamNdjson({ schema, maxBytes?, maxElementBytes? })` and
  `StreamUint8Array({ maxBytes? })` now work as request `payload` (the handler
  gets a `Stream`) as well as `success`; `StreamSse` stays response-only.
- `HttpApiSchema.asProblem({ title })`, `HttpApiError.Problem`,
  `HttpApiMiddleware.ProblemDetails` and `layerProblemDetails` give RFC 9457
  `application/problem+json` errors; see
  [streaming-and-problems](streaming-and-problems.md).
- `HttpApiSchema.status(code)` stores the status as a key annotation unless the
  schema already has an ordinary `httpApiStatus`, which wins.
- `HttpApiSchema.Upgrade({ protocol, headers? })` declares a `101 Switching
  Protocols` response; the generated client returns `HttpApiClient.Upgraded`
  (`headers`, `socket`), narrowed with `HttpApiClient.isUpgraded` when the
  endpoint also declares ordinary successes. `HttpApiClient.decodeResponse`
  decodes a raw `HttpClientResponse` for one endpoint.

## References

- [Client, middleware and testing in depth](client-and-testing.md)
- [Reading the HttpApi types and API cheat sheet](api-cheatsheet.md)
- [Streaming bodies and problem details](streaming-and-problems.md)
- [HttpApi API](https://effect.website/docs/v4/api/effect/http-api/HttpApi)
- [HttpApiBuilder API](https://effect.website/docs/v4/api/effect/http-api/HttpApiBuilder)
- [HttpApiEndpoint API](https://effect.website/docs/v4/api/effect/http-api/HttpApiEndpoint)
- [HttpApiClient API](https://effect.website/docs/v4/api/effect/http-api/HttpApiClient)
- [OpenApi API](https://effect.website/docs/v4/api/effect/http-api/OpenApi)
- [HttpApi source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/http-api/HttpApi.ts)
- [Upstream walkthrough](https://github.com/Effect-TS/effect/blob/effect%404.1.2/ai-docs/src/51_http-server/10_basics.ts)
