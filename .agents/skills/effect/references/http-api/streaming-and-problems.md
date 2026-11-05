# Streaming bodies and problem details (4.0.6+)

Two capabilities added after 4.0.0, both exercised below through
`HttpRouter.toWebHandler`, so the requests and responses are real HTTP messages
with no socket.

- **Streaming payloads and responses.** `HttpApiSchema.StreamNdjson({ schema })`
  and `HttpApiSchema.StreamUint8Array()` work in either direction: in the
  `payload` slot the handler receives a `Stream` as the body is read; in
  `success` the handler returns one. `maxBytes` caps the whole body (no
  default); `maxElementBytes` caps one NDJSON line (default 1 MiB). Limit
  breaches are an `HttpApiPayloadTooLarge`; malformed lines an `HttpApiSchemaError`.
  `StreamSse` stays response-only.
- **RFC 9457 problem details.** `HttpApiSchema.asProblem({ title })` renders a
  class error as `application/problem+json`; `HttpApiError.Problem` defines new
  problem classes; `HttpApiMiddleware.ProblemDetails` +
  `layerProblemDetails({ includeDetails? })` renders request-decoding failures
  as a `400` problem instead of an empty `400`.

```ts import.meta.vitest name="references/http-api/streaming-and-problems.md#1"
import assert from "node:assert/strict"
import { Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema
} from "effect/http-api"

const Reading = Schema.Struct({ sensor: Schema.String, celsius: Schema.Number })

class Api extends HttpApi.make("telemetry").add(
  HttpApiGroup.make("readings").add(
    // The handler receives Stream<{ sensor, celsius }>.
    HttpApiEndpoint.post("import", "/readings", {
      payload: HttpApiSchema.StreamNdjson({ schema: Reading, maxBytes: "1 MiB" }),
      success: Schema.Struct({ imported: Schema.Number }),
      error: HttpApiError.NotFound.pipe(HttpApiSchema.asProblem({ title: "Not Found" }))
    }),
    // FiniteFromString rejects "abc" (NumberFromString would decode it to NaN).
    HttpApiEndpoint.get("page", "/readings", {
      query: { page: Schema.FiniteFromString },
      success: Schema.Number
    })
  )
).middleware(HttpApiMiddleware.ProblemDetails) {}

const Handlers = HttpApiBuilder.group(
  Api,
  "readings",
  Effect.fn(function*(handlers) {
    return handlers
      .handle("import", ({ payload }) => Stream.runCount(payload).pipe(Effect.map((imported) => ({ imported }))))
      .handle("page", ({ query }) => Effect.succeed(query.page))
  })
)

const { dispose, handler } = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(Handlers),
    Layer.provide(HttpApiMiddleware.layerProblemDetails()),
    Layer.provide(HttpServer.layerServices)
  ),
  { disableLogger: true }
)

const ndjson = "{\"sensor\":\"a\",\"celsius\":20}\n{\"sensor\":\"b\",\"celsius\":19}\n"
const imported = await handler(
  new Request("http://localhost/readings", {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: ndjson
  })
)
assert.equal(imported.status, 200)
assert.deepEqual(await imported.json(), { imported: 2 })

// A query that fails decoding is now a generic problem, not an empty 400.
const bad = await handler(new Request("http://localhost/readings?page=abc"))
assert.equal(bad.status, 400)
assert.equal(bad.headers.get("content-type"), "application/problem+json")
assert.deepEqual(await bad.json(), {
  detail: "Request validation failed",
  type: "about:blank",
  status: 400,
  title: "Bad Request"
})

await dispose()
```

Pass `layerProblemDetails({ includeDetails: true })` to add an `errors` array
(request slot + path + message per issue) to the `400`; leave it off for public
APIs. Generated clients decode a problem with the matching `type` back into the
original error class, and the OpenAPI document lists both problem responses.
