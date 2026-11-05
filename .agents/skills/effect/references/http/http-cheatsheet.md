# HttpClient and HttpRouter cheat sheet (effect@4.1)

Every name below exists in `effect/http` at 4.1 (checked against
`node_modules/effect/src/http/*.ts`). The module is `@stability unstable`: pin
`effect` and `@effect/platform-*` to the same exact version.

## Reading the types

- `HttpClient.HttpClient` is both the **service tag** and the **interface**.
  `HttpClient.get(url)` (the accessor) has type
  `Effect<HttpClientResponse, HttpClientError, HttpClient>`; `client.get(url)`
  on a captured client has no `R`.
- Combinators work on `HttpClient.With<E, R>`. `filterStatusOk` adds
  `HttpClientError` to `E`; `retryTransient` may add the schedule's error;
  `withScope` adds `Scope` to `R`. Read the resulting type of your configured
  client: if `E` still says only `HttpClientError`, you have not added domain
  errors yet, which is correct.
- A response is **not** decoded. `response.json` is `Effect<Json, HttpClientError>`;
  `HttpClientResponse.schemaBodyJson(S)` returns a function
  `(response) => Effect<S.Type, SchemaError | HttpClientError, S.DecodingServices>`.
- Router handlers return `Effect<HttpServerResponse, E, R>`. Route layers carry
  `R` as **request-level markers** (`HttpRouter.Request<"Requires", X>`); they
  are discharged by `HttpRouter.serve` / `toWebHandler` / `provideRequest`,
  not by `Layer.provide` on the route layer. If you see
  `Request<"Requires", Notes>` in an error message, provide `Notes` on the
  *served* layer.

## Client: building requests (`HttpClientRequest`)

| Need | API |
| --- | --- |
| Start | `get`, `post`, `put`, `patch`, `head`, `options`, `trace`, `make(method)` |
| URL | `setUrl`, `prependUrl(base)`, `appendUrl(path)`, `updateUrl`, `setHash` |
| Query | `setUrlParam(k, v)`, `setUrlParams({...})`, `appendUrlParam(s)` |
| Headers | `setHeader`, `setHeaders`, `updateHeaders`, `removeHeader`, `accept`, `acceptJson` |
| Auth | `bearerToken(string \| Redacted)`, `basicAuth(user, pass)` |
| Body | `bodyJsonUnsafe(v)`, `bodyJson(v)` (Effect), `schemaBodyJson(S)(v)`, `bodyText`, `bodyUint8Array`, `bodyUrlParams`, `bodyFormData`, `bodyFormDataRecord`, `bodyStream`, `bodyFile`, `setBody(HttpBody)` |
| Convert | `toUrl`, `toWeb`, `fromWeb` |

Per-call options accepted by `client.get(url, options)`: `urlParams`, `headers`,
`body` (an `HttpBody`), `hash`, `accept`, `acceptJson`. (`HttpClientRequest.Options.NoUrl`).

## Client: configuring (`HttpClient`)

| Need | API |
| --- | --- |
| Edit every request | `mapRequest(f)`, `mapRequestEffect(f)`, `mapRequestInput` |
| Fail on bad status | `filterStatusOk`, `filterStatus(pred)`, `filterOrFail`, `filterOrElse` |
| Retry | `retryTransient({ retryOn?, while?, schedule?, times? })`, `retry(schedule \| options)` |
| React to responses | `tap`, `tapError`, `tapRequest`, `transformResponse`, `transform` |
| Handle client errors | `catchTag`, `catchTags` (on `HttpClientError`) |
| Rate limit | `withRateLimiter({ limiter, window, limit, ... })` (retries 429 until `times`) |
| Cookies | `withCookiesRef(ref)` |
| Redirects | `followRedirects(max)` |
| Stream the body safely | `withScope` (response ownership is then a `Scope`) |
| Build a stub | `HttpClient.make((request, url, signal, fiber) => Effect<HttpClientResponse, HttpClientError>)` |
| Tracing knobs | `TracerPropagationEnabled`, `TracerDisabledWhen`, `SpanNameGenerator` (Context references) |

`TracerPropagationEnabled` defaults to `true`: outgoing requests carry trace
headers, including to third parties. Turn it off with
`Effect.provideService(HttpClient.TracerPropagationEnabled, false)` if that is not wanted.

`retryTransient` options: `retryOn` is `"errors-only" | "response-only" |
"errors-and-responses"`; `schedule` is a `Schedule` (use `Schedule.exponential`,
see [time](../time/guide.md)); `times` caps attempts.

## Client: reading failures

`HttpClientError` has `reason`, a union tagged by `_tag`:
`TransportError`, `EncodeError`, `InvalidUrlError`, `StatusCodeError`,
`DecodeError`, `EmptyBodyError`. `e.request` and `e.response` (if any) are
available for logging. Use `Effect.catchTag("HttpClientError", ...)` then
switch on `e.reason._tag`.

## Server

| Need | API |
| --- | --- |
| One route | `HttpRouter.add(method, path, handler \| response \| (request) => Effect)` (a Layer) |
| Many routes | `HttpRouter.addAll([HttpRouter.route(...)], { prefix })` |
| Path params | `HttpRouter.params`, `HttpRouter.schemaPathParams(S)` |
| Path + query | `HttpRouter.schemaParams(S)` |
| Body | `HttpServerRequest.schemaBodyJson(S)`, `schemaBodyForm`, `schemaBodyUrlParams`, `schemaBodyMultipart`, `request.json`, `request.text`, `request.stream` |
| Headers, cookies, query | `HttpServerRequest.schemaHeaders`, `schemaCookies`, `schemaSearchParams` |
| Responses | `HttpServerResponse.text`, `json` (Effect), `jsonUnsafe`, `schemaJson(S)`, `html`, `redirect`, `empty`, `stream`, `file`, `setHeader`, `setStatus`, `setCookie` |
| Custom error rendering | implement `[HttpServerRespondable.symbol]()` returning `Effect<HttpServerResponse>` |
| Route middleware | `HttpRouter.middleware(fn).layer`, `.combine(other)` |
| Global middleware | `HttpRouter.middleware(fn, { global: true })`, `HttpRouter.cors(options)` |
| Per-request services | `HttpRouter.provideRequest(layer)` |
| Serve | `HttpRouter.serve(appLayer, { disableLogger?, middleware? })` + a server layer + `Layer.launch` |
| Web handler | `HttpRouter.toWebHandler(appLayer)` returns `{ handler, dispose }` |
| Test server | `NodeHttpServer.layerTest` (ephemeral port + client) or `HttpServer.layerTestClient` |

`PathInput` is a string starting with `/` (or `"*"`), with `:param` segments.
Router-provided services you may use in a handler without declaring a layer:
`HttpServerRequest`, `Scope`, `ParsedSearchParams`, `RouteContext`.

Default rendering: a `Respondable` failure or defect renders itself;
`SchemaError` becomes 400; `NoSuchElementError` becomes 404; everything else
is a 500 and the cause is logged. Interrupts become 499 (client abort) or 503.

## Worked example: status matching and timeouts

```ts import.meta.vitest name="references/http/http-cheatsheet.md#1"
import { Duration, Effect, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

const Profile = Schema.Struct({ id: Schema.String, name: Schema.String })

export class ProfileNotFound extends Schema.TaggedError<ProfileNotFound>()("ProfileNotFound", {
  id: Schema.String
}) {}

// `matchStatus` is exhaustive over classes via `orElse`; use it when different
// statuses mean different domain outcomes (404 is data, 5xx is a failure).
export const fetchProfile = (token: Redacted.Redacted, id: string) =>
  HttpClientRequest.get(`https://api.example.com/profiles/${encodeURIComponent(id)}`).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClient.execute,
    Effect.flatMap(HttpClientResponse.matchStatus({
      200: (response) => HttpClientResponse.schemaBodyJson(Profile)(response),
      404: () => Effect.fail(new ProfileNotFound({ id })),
      orElse: (response) => Effect.die(new Error(`unexpected status ${response.status}`))
    })),
    // A deadline on the whole attempt, including reading the body.
    Effect.timeout(Duration.seconds(5)),
    Effect.withSpan("fetchProfile")
  )
```

## Worked example: a service-backed router test with a real server

```ts import.meta.vitest name="references/http/http-cheatsheet.md#2"
import { NodeHttpServer } from "@effect/platform-node"
import assert from "node:assert/strict"
import { Context, Effect, Layer } from "effect"
import { HttpClient, HttpRouter, HttpServerResponse } from "effect/http"

class Greeter extends Context.Service<Greeter, { greet(name: string): Effect.Effect<string> }>()("app/Greeter") {
  static readonly layerTest = Layer.succeed(Greeter)({ greet: (name) => Effect.succeed(`hi ${name}`) })
}

const Greet = HttpRouter.add(
  "GET",
  "/greet/:name",
  Effect.gen(function*() {
    const { name } = yield* HttpRouter.params
    const greeter = yield* Greeter
    return HttpServerResponse.text(yield* greeter.greet(name ?? "anonymous"))
  })
)

// Serve on an ephemeral port and expose an HttpClient already pointed at it.
// The test double for Greeter is provided on the *served* layer.
const TestServer = HttpRouter.serve(Greet, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provide(Greeter.layerTest),
  Layer.provideMerge(NodeHttpServer.layerTest)
)

const program = Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.get("/greet/ada")
  assert.equal(response.status, 200)
  assert.equal(yield* response.text, "hi ada")
}).pipe(Effect.provide(TestServer), Effect.scoped)

await Effect.runPromise(program)
```
