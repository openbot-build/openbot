# More HTTP recipes

## Sending a body and reading failures precisely

```ts import.meta.vitest name="references/http/more-recipes.md#1"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

const Created = Schema.Struct({ id: Schema.String })

// Typed as Effect<{ id: string }, HttpClientError | SchemaError, HttpClient>.
export const createNote = (title: string) =>
  HttpClientRequest.post("https://api.example.com/notes").pipe(
    HttpClientRequest.bodyJsonUnsafe({ title }),
    // An Idempotency-Key makes a later retry safe.
    HttpClientRequest.setHeader("idempotency-key", crypto.randomUUID()),
    HttpClient.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Created))
  )

// Branch on the *reason*, not on message text. `reason._tag` is one of
// TransportError | EncodeError | InvalidUrlError | StatusCodeError | DecodeError | EmptyBodyError.
export const createNoteOrNull = (title: string) =>
  createNote(title).pipe(
    Effect.catchTag("HttpClientError", (e) =>
      e.reason._tag === "TransportError" ? Effect.succeed(null) : Effect.fail(e))
  )
```

`HttpClient.execute` here is the *accessor* that reads the service from `R`;
inside a layer you instead call methods on the client you already captured.

## Middleware

```ts import.meta.vitest name="references/http/more-recipes.md#2"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

// Route-scoped middleware: a function from the handler Effect to a handler
// Effect. It only affects routes the middleware layer is provided to.
const RequestIdHeader = HttpRouter.middleware((handler) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const response = yield* handler
    return HttpServerResponse.setHeader(response, "x-seen-path", request.url)
  })
).layer

export const Ping = HttpRouter.add("GET", "/ping", HttpServerResponse.text("pong")).pipe(
  Layer.provide(RequestIdHeader)
)

// Global middleware applies to every route in the app (CORS is the built-in example).
export const Cors = HttpRouter.cors({ allowedOrigins: ["https://app.example.com"] })

export const App = Layer.mergeAll(Ping, Cors)
```

Use `HttpRouter.middleware(fn, { global: true })` for cross-cutting behaviour,
and `HttpRouter.middleware<{ provides: Service }>()(...)` when middleware
supplies a service to the handlers it wraps. Authentication that must appear in
an OpenAPI document belongs in [http-api](../http-api/guide.md), not here.


## Compressing a request body (4.0.6+)

`HttpClientRequest.compressBody(algorithm, { minSize? })` returns an
`Effect<HttpClientRequest>` (not a plain request), uses the Web
`CompressionStream`, and sets `content-encoding`. Bodies smaller than
`minSize` (default 1024 bytes) and requests that already carry a
`content-encoding` are returned unchanged. To compress every request of a
client, use `HttpClient.mapRequestEffect(HttpClientRequest.compressBody("gzip"))`.

```ts import.meta.vitest name="references/http/more-recipes.md#3"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"

const post = (text: string) =>
  HttpClientRequest.post("https://api.example.com/logs").pipe(HttpClientRequest.bodyText(text))

const big = await Effect.runPromise(HttpClientRequest.compressBody("gzip")(post("log line\n".repeat(500))))
big.headers["content-encoding"] // => "gzip"
Number(big.headers["content-length"]) < 4500 // => true

// Under the default 1024-byte minimum nothing changes.
const small = await Effect.runPromise(HttpClientRequest.compressBody("gzip")(post("hi")))
small.headers["content-encoding"] // => undefined
```

`retryTransient` re-runs `mapRequestEffect`, so a client-wide compressor
recompresses on every retry; for large bodies compress once before `execute`.

## Honouring `Retry-After` (4.0.6+)

`Headers.parseRetryAfter` turns the header (delta-seconds or an HTTP date) into a
`Result`; `Headers.retryAfterDelay(value, nowMillis)` turns either form into a
`Duration` you can sleep on.

```ts import.meta.vitest name="references/http/more-recipes.md#4"
import { Duration, Result } from "effect"
import { Headers } from "effect/http"

const seconds = Result.getOrThrow(Headers.parseRetryAfter("120"))
Duration.toMillis(Headers.retryAfterDelay(seconds, 0)) // => 120000

// An absolute date is measured against the `now` you pass in.
const date = Result.getOrThrow(Headers.parseRetryAfter("Wed, 21 Oct 2015 07:28:10 GMT"))
const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT")
Duration.toMillis(Headers.retryAfterDelay(date, now)) // => 10000

Result.isFailure(Headers.parseRetryAfter("soon")) // => true
```

## Upgrading the connection (4.0.6+)

`HttpClientRequest.upgrade(protocol)` sets `Connection: Upgrade` and
`Upgrade: <protocol>`; read the raw byte stream from `response.upgrade`
(a `Socket`). Use it for things like Docker's `Upgrade: tcp` attach, and
`Socket.makeWebSocket` for WebSocket. `HttpClientRequest.make` now accepts any
string method, not only the `HttpMethod` literals.
