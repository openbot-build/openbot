# Client, middleware and testing in depth

The contract below has a secured group, a built-in error, a header-bearing
success, text and no-content variants. Everything is checked against
`effect@4.1`.

## A complete secured API with client and tests

```ts import.meta.vitest name="references/http-api/client-and-testing.md#1"
import assert from "node:assert/strict"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClientRequest, HttpServer } from "effect/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  HttpApiTest
} from "effect/http-api"

// ---- contract ----
class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}, { httpApiStatus: 401 }) {}
class CurrentUser extends Context.Service<CurrentUser, { readonly id: string }>()("app/CurrentUser") {}

class Auth extends HttpApiMiddleware.Service<Auth, { provides: CurrentUser; requires: never }>()("app/Auth", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized
}) {}

const Report = Schema.Struct({ id: Schema.String, total: Schema.Number })

class Reports extends HttpApiGroup.make("reports").add(
  HttpApiEndpoint.get("get", "/:id", {
    params: { id: Schema.String },
    success: Report,
    // Built-ins from HttpApiError have a status and an empty-body variant.
    error: HttpApiError.NotFound
  }),
  HttpApiEndpoint.get("csv", "/:id/csv", {
    params: { id: Schema.String },
    // A different content type; the client decodes it back to a string.
    success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" }))
  }),
  HttpApiEndpoint.delete("remove", "/:id", {
    params: { id: Schema.String },
    success: HttpApiSchema.NoContent
  })
).middleware(Auth).prefix("/reports") {}

class Api extends HttpApi.make("reports-api").add(Reports) {}

// ---- implementation ----
const AuthLive = Layer.succeed(Auth)({
  bearer: (httpEffect, { credential }) =>
    Redacted.value(credential) === "secret"
      ? Effect.provideService(httpEffect, CurrentUser, { id: "u1" })
      : Effect.fail(new Unauthorized())
})

const ReportsLive = HttpApiBuilder.group(
  Api,
  "reports",
  Effect.fn(function*(handlers) {
    return handlers
      .handle("get", ({ params }) =>
        params.id === "r1"
          ? Effect.succeed({ id: "r1", total: 3 })
          : Effect.fail(new HttpApiError.NotFound()))
      .handle("csv", () => Effect.succeed("id,total\nr1,3"))
      .handle("remove", () => Effect.void)
  })
)

// ---- tests ----
// Provide handlers and the middleware implementation. provideMerge keeps
// AuthLive in the output because the HTTP pipeline resolves it as well.
const Server = ReportsLive.pipe(Layer.provideMerge(AuthLive), Layer.merge(HttpServer.layerServices))

// The CLIENT-side middleware decides which token the test sends.
const withToken = (token: string) =>
  HttpApiMiddleware.layerClient(Auth, ({ next, request }) => next(HttpClientRequest.bearerToken(request, token)))

const makeClient = HttpApiTest.groups(Api, ["reports"])

const authorized = Effect.gen(function*() {
  const client = yield* makeClient
  const report = yield* client.reports.get({ params: { id: "r1" } })
  assert.equal(report.total, 3)
  assert.equal(yield* client.reports.csv({ params: { id: "r1" } }), "id,total\nr1,3")
  yield* client.reports.remove({ params: { id: "r1" } })

  // Declared errors are values in E. Flip to assert on them.
  const missing = yield* Effect.flip(client.reports.get({ params: { id: "zzz" } }))
  assert.equal(missing._tag, "NotFound")

  // "decoded-and-response" also returns the raw response for status/header checks.
  const [, response] = yield* client.reports.get({
    params: { id: "r1" },
    responseMode: "decoded-and-response"
  })
  assert.equal(response.status, 200)
}).pipe(Effect.provide(withToken("secret")))

const unauthorized = Effect.gen(function*() {
  const client = yield* makeClient
  const error = yield* Effect.flip(client.reports.get({ params: { id: "r1" } }))
  assert.equal(error._tag, "Unauthorized")
}).pipe(Effect.provide(withToken("wrong")))

await Effect.runPromise(
  Effect.all([authorized, unauthorized]).pipe(Effect.provide(Server), Effect.scoped)
)
```

## How the pieces fit

- `HttpApiMiddleware.Service<Self, { provides, requires }>()(id, { security, error, requiredForClient })`
  declares the middleware; the declaration is part of the contract.
  `provides` is a service handlers may then `yield*`; `requires` are services
  other middleware must supply first. With `security`, the implementation is an
  object with one function per scheme key; without it, a single function
  `(httpEffect, { endpoint, group }) => Effect`.
- The implementation is a `Layer` of the same tag (`Layer.succeed(Auth)({...})`
  or `Layer.effect(Auth, ...)` when it needs services). It is provided where
  the handlers are provided, not in the contract.
- `requiredForClient: true` makes `HttpApiClient.make` (and `HttpApiTest`)
  require `HttpApiMiddleware.layerClient(Tag, ({ next, request }) => ...)`,
  where you set headers and call `next(request)`. Without that flag the client
  never sees the middleware.
- Security schemes: `HttpApiSecurity.bearer`, `.basic`, `.apiKey({ key, in })`,
  `.http({ scheme })`. Credentials arrive as `Redacted` (bearer, api key,
  basic).
- `Effect.provideService(httpEffect, CurrentUser, value)` is how middleware
  hands data to everything downstream.

## Client configuration

```ts import.meta.vitest name="references/http-api/client-and-testing.md#2"
import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApi, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

class Api extends HttpApi.make("ping").add(
  HttpApiGroup.make("ping", { topLevel: true }).add(
    HttpApiEndpoint.get("ping", "/ping", { success: Schema.String })
  )
) {}

// The generated client type is HttpApiClient.ForApi<typeof Api>. Expose it as
// a service so the rest of the app never builds clients itself.
export class PingClient extends Context.Service<PingClient, HttpApiClient.ForApi<typeof Api>>()("app/PingClient") {
  static readonly layer = Layer.effect(
    PingClient,
    // baseUrl is an alternative to HttpClient.mapRequest(prependUrl(...)).
    HttpApiClient.make(Api, { baseUrl: "http://localhost:3000" })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

export const run = Effect.gen(function*() {
  const client = yield* PingClient
  return yield* client.ping() // topLevel group: no `client.ping.ping`
}).pipe(Effect.provide(PingClient.layer))

// transformClient configures the underlying HttpClient once: base URL, headers,
// and retries. Only retry idempotent calls; this contract has only a GET.
export const PingClientRetrying = Layer.effect(
  PingClient,
  HttpApiClient.make(Api, {
    transformClient: (client) =>
      client.pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl("http://localhost:3000")),
        HttpClient.retryTransient({ schedule: Schedule.exponential(100), times: 3 })
      )
  })
).pipe(Layer.provide(FetchHttpClient.layer))
```

`responseMode` per call: `"decoded-only"` (default), `"decoded-and-response"`
(tuple `[value, response]`), `"response-only"` (raw `HttpClientResponse`, no
decoding).

## Error design patterns

- One error class per outcome the client should branch on, with
  `{ httpApiStatus }` (or `HttpApiSchema.status(n)` on a schema).
- Several related reasons: wrap them in one `Schema.TaggedError` with a
  `reason` union inside the *service* (as the upstream `UsersError` does), then
  in the handler unwrap with `Effect.catchReason("UsersError", "NotFound", Effect.fail, Effect.die)`
  or `Effect.catchReasons`. The contract then lists only the leaf errors.
- No-body errors: `MyError.pipe(HttpApiSchema.asNoContent({ decode: () => new MyError() }))`.
- Payload validation failures are `HttpApiSchemaError` (400, empty body). To
  return your own body, declare an error on a middleware and provide
  `HttpApiMiddleware.layerSchemaErrorTransform(Tag, (schemaError, { endpoint, group }) => ...)`.
