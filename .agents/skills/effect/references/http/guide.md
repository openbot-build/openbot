# Effect HTTP: client and router

## How to think about it

An HTTP call is the place where the three things Effect makes visible all
show up at once: it **fails in many different ways** (DNS, timeout, 503, a body
that is not the JSON you expected), it **needs ambient things** (a base URL,
credentials, a connection pool), and it **holds a resource** (a socket and an
unread body). Promise-style `fetch` hides all three: it resolves on a 500,
rejects with an untyped `TypeError`, and leaves the body dangling.

The model has two halves that mirror each other:

- **Client.** `HttpClient.HttpClient` is a *service* (an interface in `R`), not
  a function you import. You obtain it with `yield* HttpClient.HttpClient`,
  derive a configured copy with combinators (`mapRequest`, `filterStatusOk`,
  `retryTransient`), and wrap it in a small domain service of your own. Every
  failure is an `HttpClientError` whose `reason._tag` says what happened;
  decoding the body is a separate step that fails with `SchemaError`. Your
  domain service converts both into one typed error of your own.
- **Server.** `HttpRouter` is built from *layers*: each route is a `Layer` that
  registers itself with the router when the app layer is built. A handler is an
  ordinary Effect whose result is an `HttpServerResponse`. The things a handler
  needs (`HttpServerRequest`, `RouteContext`, your services) are just `R`. A
  failure that implements `Respondable` renders itself; anything else is a 500
  and the cause is logged. So the transport mapping lives on the *error*, not
  in a try/catch in each handler.

If you come from Express, the surprise is that there is no `next(err)` and no
`req`/`res` pair: handlers return a response value, errors are values in `E`,
and middleware is a function from "the handler Effect" to "a handler Effect".
If you come from `fetch`/axios, the surprise is that a 404 is a *success* of the
transport until you ask for `filterStatusOk`, and that retrying is a policy you
attach to the client, not a loop you write.

## Choose

| Situation | Use | Why |
| --- | --- | --- |
| Call a JSON API from a use case | a domain service over `HttpClient.HttpClient` | one place for base URL, auth, retry and error mapping; domain code never sees HTTP |
| Non-2xx must be an error | `HttpClient.filterStatusOk` (or `filterStatus(pred)`) | otherwise 404/500 come back as successful responses |
| Transient network or 5xx failures | `HttpClient.retryTransient({ schedule, times })` on idempotent calls only | classifies what is safe to retry; you supply the backoff |
| Decode a response body | `HttpClientResponse.schemaBodyJson(Schema)` | `unknown` becomes a typed value or a `SchemaError` |
| Send JSON | `HttpClientRequest.bodyJsonUnsafe(value)` (sync) or `bodyJson` (Effect) | sets content-type and body |
| Hand-written routes (webhooks, health, proxies, static) | `HttpRouter.add` / `addAll` layers | routes compose as layers and get their services from `R` |
| Typed contract, generated client, OpenAPI | [http-api](../http-api/guide.md) instead | the contract replaces hand-written decoding and status mapping |
| Typed internal calls between your own processes | [rpc](../rpc/guide.md) instead | no URLs or status codes to design |
| Serve on Node | `HttpRouter.serve(app)` + `NodeHttpServer.layer(createServer, { port })` + `Layer.launch` | the server is a Layer with a Scope |
| Serverless / framework handler | `HttpRouter.toWebHandler(app)` | returns `{ handler(Request): Promise<Response>, dispose }` |
| A single throwaway `fetch` in a script | still `FetchHttpClient.layer` + `HttpClient` | you keep tracing, interruption and a test seam |

## Recipe

### The client: pitfall first

```ts skip
// Pitfall: every concern is smeared across the call site.
async function getForecast(city: string) {
  const res = await fetch(`https://api.example.com/forecast?city=${city}`) // not encoded
  const body = await res.json() // runs on a 500 too; `any`
  return body.temperatureC as number // a cast, not a check
}
```

Nothing here is typed: not the failure, not the body, not the dependency on the
network. The idiomatic version is a service whose interface mentions only the
domain, with one typed error.

```ts import.meta.vitest name="references/http/guide.md#2"
import { Context, Effect, flow, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

// The wire format. Decoding it is the only place we trust remote data.
const ForecastBody = Schema.Struct({
  city: Schema.String,
  temperatureC: Schema.Number
})

// One error for "the weather provider did not give us a forecast". Callers can
// branch on `kind` without learning HTTP. `cause` keeps the original for logs.
export class WeatherUnavailable extends Schema.TaggedError<WeatherUnavailable>()("WeatherUnavailable", {
  city: Schema.String,
  cause: Schema.Defect()
}) {}

// The service says WHAT we need, not HOW (no HttpClient in the interface).
export class Weather extends Context.Service<Weather, {
  forecast(city: string): Effect.Effect<{ readonly city: string; readonly temperatureC: number }, WeatherUnavailable>
}>()("app/Weather") {
  // `layerNoDeps` still needs an HttpClient, so tests can provide a stub one.
  static readonly layerNoDeps = Layer.effect(
    Weather,
    Effect.gen(function*() {
      const base = yield* HttpClient.HttpClient
      // Configure once. Each combinator returns a new client; the original is untouched.
      const client = base.pipe(
        HttpClient.mapRequest(flow(
          HttpClientRequest.prependUrl("https://api.example.com"),
          HttpClientRequest.acceptJson
        )),
        // Without this a 503 is a *successful* response and decoding fails
        // later with a confusing error.
        HttpClient.filterStatusOk,
        // Safe only because forecast is a GET. Retries transport errors and
        // transient statuses (e.g. 503) with exponential backoff.
        HttpClient.retryTransient({ schedule: Schedule.exponential(100), times: 3 })
      )

      const forecast = Effect.fn("Weather.forecast")(function*(city: string) {
        yield* Effect.annotateCurrentSpan({ city })
        // `urlParams` encodes the value; never splice user input into the URL.
        return yield* client.get("/forecast", { urlParams: { city } }).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ForecastBody)),
          // HttpClientError | SchemaError are both "provider problem" to our callers.
          Effect.mapError((cause) => new WeatherUnavailable({ city, cause }))
        )
      })

      return Weather.of({ forecast })
    })
  )

  // The production layer closes the dependency. Swap FetchHttpClient for
  // NodeHttpClient (platform-node) if you need Node's agent pooling.
  static readonly layer = this.layerNoDeps.pipe(Layer.provide(FetchHttpClient.layer))
}
```

Design notes: the client is built **once in the layer**, not per call; the
retry policy sits next to the status filter because both are decisions about
"what counts as a failed attempt"; and the only thing a use case sees is
`Weather`. A POST that creates something does not get `retryTransient` unless
you carry an idempotency key, because a timeout does not tell you whether the
server committed.

Sending bodies, idempotency keys and `reason._tag` handling are in
[references/more-recipes.md](more-recipes.md).

### The server: routes as layers

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerRespondable, HttpServerResponse } from "effect/http"
import { createServer } from "node:http"

// 1. A domain error that knows its own transport mapping. Implementing
//    Respondable means any handler can `return yield* new NoteNotFound(...)`
//    and the router renders a 404 without a catch block per route.
export class NoteNotFound extends Schema.TaggedError<NoteNotFound>()("NoteNotFound", {
  id: Schema.String
}) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.json({ error: this._tag, id: this.id }, { status: 404 })
  }
}

// 2. Business logic is a service; the routes below know nothing about storage.
export class Notes extends Context.Service<Notes, {
  get(id: string): Effect.Effect<{ readonly id: string; readonly title: string }, NoteNotFound>
  create(title: string): Effect.Effect<{ readonly id: string; readonly title: string }>
}>()("app/Notes") {
  static readonly layerMemory = Layer.effect(
    Notes,
    Effect.gen(function*() {
      const store = yield* Ref.make(new Map<string, { readonly id: string; readonly title: string }>())
      return Notes.of({
        get: Effect.fn("Notes.get")(function*(id) {
          const note = (yield* Ref.get(store)).get(id)
          return note ?? (yield* new NoteNotFound({ id }))
        }),
        create: Effect.fn("Notes.create")(function*(title) {
          const note = { id: crypto.randomUUID(), title }
          yield* Ref.update(store, (m) => new Map(m).set(note.id, note))
          return note
        })
      })
    })
  )
}

// 3. Wire-level schemas decode untrusted input at the edge.
const CreateNote = Schema.Struct({ title: Schema.NonEmptyString })
const NoteParams = Schema.Struct({ id: Schema.String })

// 4. Each route is a Layer. Its R (Notes) is checked when the app is assembled.
const GetNote = HttpRouter.add(
  "GET",
  "/notes/:id",
  Effect.gen(function*() {
    const { id } = yield* HttpRouter.schemaPathParams(NoteParams)
    const notes = yield* Notes
    return yield* HttpServerResponse.json(yield* notes.get(id))
  })
)

const PostNote = HttpRouter.add(
  "POST",
  "/notes",
  Effect.gen(function*() {
    // A bad body fails with SchemaError, which the router renders as a 400.
    const { title } = yield* HttpServerRequest.schemaBodyJson(CreateNote)
    const notes = yield* Notes
    return yield* HttpServerResponse.json(yield* notes.create(title), { status: 201 })
  })
)

const Health = HttpRouter.add("GET", "/health", HttpServerResponse.text("ok"))

// 5. Compose routes. Their service needs are *request-level* requirements, so
//    they stay on the app layer until the layer is served.
export const AppLayer = Layer.mergeAll(GetNote, PostNote, Health)

// 6. Serving is a Layer too: the listening socket is released with the Scope.
//    Provide services here, once, at the composition root.
export const ServerLayer = HttpRouter.serve(AppLayer).pipe(
  Layer.provide(Notes.layerMemory),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

// 7. Run exactly once, at the edge.
if (process.argv[1]?.endsWith("server.ts")) {
  Layer.launch(ServerLayer).pipe(NodeRuntime.runMain)
}
```

Notes on the choices above. `HttpRouter.add` requires only `Notes` because
`HttpServerRequest`, `Scope`, `RouteContext` and `ParsedSearchParams` are
provided by the router (`HttpRouter.Provided`). Failures that are not
`Respondable` and not `SchemaError` become a 500 and the cause is logged, which
is what you want for bugs; if a failure should be visible to clients, give it a
`Respondable` implementation. For an endpoint family with many routes, return
`HttpRouter.addAll([HttpRouter.route(...), ...], { prefix: "/v1" })`.

### Middleware

Route middleware is a function from the handler Effect to a handler Effect, and
`HttpRouter.cors(...)` / `HttpRouter.middleware(fn, { global: true })` apply to
every route. See [references/more-recipes.md](more-recipes.md) for a
compiled example; authentication that must appear in an OpenAPI document
belongs in [http-api](../http-api/guide.md).

## Anti-patterns

1. **Treating a non-2xx as success.**

   ```ts skip
   const user = yield* client.get("/users/1").pipe(Effect.flatMap((r) => r.json))
   ```

   A 404 body gets parsed as if it were a user. Add `HttpClient.filterStatusOk`
   (or match with `HttpClientResponse.matchStatus`) before decoding.

2. **`as T` on a body.**

   ```ts skip
   const user = (yield* response.json) as User
   ```

   Compiles, proves nothing, and fails far from the cause. Use
   `HttpClientResponse.schemaBodyJson(User)`.

3. **A new client or layer per call.** Calling `HttpClient.mapRequest(...)`,
   `Effect.provide(FetchHttpClient.layer)` or `Effect.provide(Notes.layerMemory)`
   inside a function or handler rebuilds configuration (and a store, or a
   connection pool) on every request. Build once in a service layer and provide
   at the root.

4. **Retrying everything.** `retryTransient` on a POST that creates a payment can
   charge twice after a timeout. Retry only idempotent requests, or send an
   idempotency key and say so in a comment next to the retry.

5. **Leaking `HttpClientError` into the domain.**

   ```ts skip
   forecast(city: string): Effect.Effect<Forecast, HttpClientError | SchemaError>
   ```

   Every caller now depends on your transport. Map to a domain error at the
   service boundary (`Effect.mapError`), as in the recipe.

6. **Catching all errors in a handler to build a 500.**

   ```ts skip
   Effect.catch(() => HttpServerResponse.json({ error: "oops" }, { status: 500 }))
   ```

   You hide bugs and the logged cause. Let unexpected failures propagate (the
   router returns 500 and logs), and give expected errors a `Respondable`
   rendering.

7. **`Effect.runPromise` inside a handler** to call another service. You lose
   interruption (a client abort no longer cancels the work) and the request's
   context. `yield*` the Effect.

8. **Splicing user input into URLs.** `` `/search?q=${q}` `` breaks on `&` and
   `#`. Use `urlParams`, `HttpClientRequest.setUrlParam`, or `appendUrl` for
   path segments you have validated.

## Testing it

Do not start a server or hit the network. Use a stub `HttpClient` for the
client side and a web handler for the router.

```ts import.meta.vitest name="references/http/guide.md#4"
import assert from "node:assert/strict"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

// The code under test: any Effect that needs HttpClient in R.
const Forecast = Schema.Struct({ city: Schema.String, temperatureC: Schema.Number })
const forecast = (city: string) =>
  HttpClient.get("https://api.example.com/forecast", { urlParams: { city } }).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Forecast))
  )

// A stub client answers from a function of the request. `make` receives the
// request plus the resolved URL, so you can assert on what was sent.
const stub = (status: number, body: unknown, seen: Array<string> = []) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest, url) => {
      seen.push(url.toString())
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status }))
      )
    })
  )

const seen: Array<string> = []
const happy = Effect.gen(function*() {
  const result = yield* forecast("Oslo")
  assert.equal(result.temperatureC, 3)
  assert.equal(seen[0], "https://api.example.com/forecast?city=Oslo")
}).pipe(Effect.provide(stub(200, { city: "Oslo", temperatureC: 3 }, seen)))

// A malformed body is a typed failure in E, not a thrown TypeError.
const malformed = Effect.gen(function*() {
  const error = yield* Effect.flip(forecast("Oslo"))
  assert.equal(error._tag, "SchemaError")
}).pipe(Effect.provide(stub(200, { city: "Oslo" })))

await Effect.runPromise(Effect.all([happy, malformed]))
```

The same stub layer works under your domain service: provide it to
`Weather.layerNoDeps` instead of `FetchHttpClient.layer`, and `Weather` is tested
without any network and with the production retry and status rules in place.

For routes that need no services, build a web handler from the app layer and
call it with a standard `Request`:

```ts import.meta.vitest name="references/http/guide.md#5"
import assert from "node:assert/strict"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

// toWebHandler is the in-process equivalent of serving: same routing, same
// middleware, same error rendering, no sockets.
const Routes = HttpRouter.add("GET", "/health", HttpServerResponse.text("ok"))

const program = Effect.acquireUseRelease(
  Effect.sync(() => HttpRouter.toWebHandler(Routes, { disableLogger: true })),
  ({ handler }) =>
    Effect.gen(function*() {
      const response = yield* Effect.promise(() => handler(new Request("http://localhost/health")))
      assert.equal(response.status, 200)
      assert.equal(yield* Effect.promise(() => response.text()), "ok")
      const missing = yield* Effect.promise(() => handler(new Request("http://localhost/nope")))
      assert.equal(missing.status, 404)
    }),
  ({ dispose }) => Effect.promise(dispose)
)

await Effect.runPromise(program)
```

For routes that need services, serve them on an ephemeral port with
`HttpRouter.serve(app).pipe(Layer.provide(testServices), Layer.provideMerge(NodeHttpServer.layerTest))`
and use the `HttpClient` that `layerTest` provides, already pointed at the
server; a complete compiled example is at the end of
[references/http-cheatsheet.md](http-cheatsheet.md).

With `@effect/vitest`, run each test body as `it.effect` (it provides a `Scope`
and `TestClock`) and replace real services with in-memory layers such as
`Notes.layerMemory`; see the worked `it.effect` test in [rpc](../rpc/guide.md) and
[testing](../testing/guide.md).

## Boundaries

- [http-api](../http-api/guide.md) owns schema-first endpoint contracts, typed handlers,
  generated clients, security middleware and OpenAPI. Reach for it as soon as
  more than a couple of routes share validation and error mapping.
- [schema](../schema/guide.md) owns the decoding you do here (`schemaBodyJson`,
  `schemaPathParams`, `Schema.TaggedError`, `Schema.Defect`).
- [services](../services/guide.md) owns the service and layer pattern used by `Weather` and
  `Notes`, and how `Layer.provide` vs `provideMerge` change what is exposed.
- [core](../core/guide.md) owns typed error design, `catchTag`, `orDie`, and the run
  boundary (`NodeRuntime.runMain`).
- [time](../time/guide.md) owns `Schedule` for backoff and timeouts; [testing](../testing/guide.md) owns
  `TestClock` and `@effect/vitest`.
- [platform](../platform/guide.md) owns `NodeHttpServer`/`NodeHttpClient` package selection
  and file-system backed responses.
- [rpc](../rpc/guide.md) owns typed procedure calls between your own services.
- Errors cross here: `HttpClientError`/`SchemaError` become your domain error
  at the client service; domain errors become responses via `Respondable` at the
  router. Resources cross here: the listening socket is owned by the server
  layer's Scope; request bodies are owned by the request fiber, so interruption
  (client abort) cancels the handler.

## Changed in 4.1

Verified against the 4.0.0 and 4.1.2 sources (several arrived in 4.0.6):

- `HttpClientRequest.compressBody("gzip" | "deflate", { minSize? })` compresses a
  request body and sets `content-encoding`; see [more-recipes](more-recipes.md).
- `HttpClientRequest.upgrade(protocol)` plus `response.upgrade` (a `Socket`)
  for `Connection: Upgrade` raw streams.
- `Headers.parseRetryAfter`, `retryAfterDelay`, `formatRetryAfter`,
  `parseHttpDate`, `formatHttpDate`; parse failures are a `HeaderParseError`.
- `HttpClientRequest.make` and `HttpClientRequest.HttpClientRequest["method"]`
  are typed `string`, so non-standard methods no longer need a cast.
- `HttpClientError` JSON/inspect output redacts the URL (`UrlParams.redactUrl`),
  so credentials in query strings stay out of logs.
- `FetchHttpClient.StreamBodyFallback` (`"error"` default | `"buffer"`) decides what
  happens when the runtime cannot stream request bodies (stable Safari/Firefox).
- `Cookies.toRequestCookieHeader` and `mergeIntoArray` apply domain, path,
  `Secure` and expiry matching to the cookie jar (`withCookiesRef`); there is no
  public-suffix list.
- RPC batching over the HTTP protocol and HttpApi streaming payloads/problem
  details are in [rpc](../rpc/rpc-cheatsheet.md) and
  [http-api](../http-api/streaming-and-problems.md).

## References

- [HttpClient cheat sheet and signatures](http-cheatsheet.md)
- [More recipes: bodies, idempotency, middleware, compression, Retry-After](more-recipes.md)
- [HttpClient API](https://effect.website/docs/v4/api/effect/http/HttpClient)
- [HttpRouter API](https://effect.website/docs/v4/api/effect/http/HttpRouter)
- [HttpServerResponse API](https://effect.website/docs/v4/api/effect/http/HttpServerResponse)
- [HttpClient source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/http/HttpClient.ts)
- [HttpRouter source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/http/HttpRouter.ts)
- [Upstream HttpClient example](https://github.com/Effect-TS/effect/blob/effect%404.1.2/ai-docs/src/50_http-client/10_basics.ts)
