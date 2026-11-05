# HttpApi API cheat sheet and how to read the types (effect@4.1)

All names verified against `node_modules/effect/src/http-api/*.ts`. Import
everything from `"effect/http-api"`.

## Endpoint constructors

`HttpApiEndpoint.get | query | post | put | patch | head | options | delete`
(`delete` is a reserved word, so call it as `HttpApiEndpoint.delete(...)`), or
`HttpApiEndpoint.make("PATCH")`. Signature:

```text
HttpApiEndpoint.post(identifier, path, {
  params?, query?, headers?, payload?, success?, error?
})
```

| Option | Accepts | Notes |
| --- | --- | --- |
| `params` | a struct fields record or schema | path params (`:id`); string forms are coerced by the schema |
| `query` | fields record or schema | values decoded from the query string |
| `headers` | fields record or schema | request headers (lower-case keys) |
| `payload` | schema; for GET/HEAD/OPTIONS it is read from the **query string**; for body methods it is JSON unless wrapped (`asText`, `asFormUrlEncoded`, `asMultipart`, `asUint8Array`) | an array of schemas offers several content types |
| `success` | a schema or an array of schemas (default `HttpApiSchema.NoContent`) | `.pipe(HttpApiSchema.status(201))`, `Created`, `Accepted`, `NoContent`, `asText`, `StreamSse`, `withHeaders` |
| `error` | a schema or an array | classes with `httpApiStatus` or `HttpApiSchema.status(n)`; `HttpApiError.*` built-ins |

The identifier is the method name on the generated client and the key in
`handlers.handle("identifier", ...)`.

## Groups and the API

- `HttpApiGroup.make("name", { topLevel?: true })` then `.add(endpoint, ...)`,
  `.prefix("/p")`, `.middleware(Tag)`, `.annotateMerge(OpenApi.annotations({...}))`.
  Extend it as a class (`class G extends HttpApiGroup.make(...)...{}`) so the
  group has a name you can reference.
- `HttpApi.make("id").add(group)`, `.annotateMerge(...)`, `.middleware(Tag)`
  (applies to every group), `.prefix("/v1")`.
- A group with `topLevel: true` puts its endpoints at the client root.
- Endpoint-level middleware: `endpoint.middleware(Tag)`; prefix per endpoint:
  `endpoint.prefix(...)`.

## Responses

| Want | Write |
| --- | --- |
| 204 | `HttpApiSchema.NoContent` |
| 201 / 202 with body | `Schema.pipe(HttpApiSchema.status(201))` |
| 201 / 202 empty | `HttpApiSchema.Created` / `Accepted` |
| plain text or CSV | `Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" }))` |
| bytes | `Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array())` |
| headers with body | `HttpApiSchema.withHeaders(...)` (see source JSDoc) |
| server-sent events | `HttpApiSchema.StreamSse({ events, error })` |
| error without a body | `Err.pipe(HttpApiSchema.asNoContent({ decode: () => new Err() }))` |
| raw control | return an `HttpServerResponse` from the handler, or use `handleRaw` |

`HttpApiError` ships paired variants: `NotFound` (JSON) and `NotFoundNoContent`,
`BadRequest`, `Unauthorized`, `Forbidden`, `Conflict`, `UnprocessableEntity`,
`InternalServerError`, `ServiceUnavailable`, `RequestTimeout`, and more.

## Builder

| API | Use |
| --- | --- |
| `HttpApiBuilder.group(Api, "group", build)` | Layer providing one group's handlers. `build` may be an Effect (`Effect.fn(function*(handlers) {...})`) so it can `yield*` services. |
| `handlers.handle("id", fn)` / `.handleAll({ id: fn, ... })` | register handlers. `fn({ params, query, payload, headers, request })` receives only the parts the endpoint declares. |
| `handlers.handleRaw("id", fn)` | receive the undecoded request (`RequestRaw`), e.g. to stream a body |
| `HttpApiBuilder.layer(Api, { openapiPath })` | Layer of routes for all groups; needs every group's handlers |
| `HttpApiBuilder.securityDecode`, `securitySetCookie` | advanced: decode or set credentials yourself |

The return type of the `build` function must be the full set of handlers, or
the compiler reports `Endpoint not handled: <name>`.

## Docs

- `HttpApiScalar.layer(Api, { path: "/docs" })` embeds the UI; `layerCdn` loads
  it from a CDN. `HttpApiSwagger.layer(Api, { path })` is the Swagger UI.
- `OpenApi.fromApi(Api)` returns the spec object (use it in tests to assert
  status codes and security schemes). Annotate with
  `OpenApi.annotations({ title, description, summary, deprecated, servers, override, transform, exclude })`.

## Reading the types

- `HttpApiEndpoint<Id, Method, Path, Params, Query, Payload, Headers, Success, Error, Middleware, ...>`:
  hover an endpoint to see what the handler will receive (`Request<Endpoint>`)
  and what it may return (`Success["Type"]` or an `HttpServerResponse`) and
  fail with (`Error["Type"] | MiddlewareError`).
- `HttpApiGroup.ToService<Id, Groups>` is the requirement `HttpApiBuilder.layer`
  has; each `HttpApiBuilder.group` layer provides one `HttpApiGroup.Service`.
- A handler's `R` surfaces as a `HttpRouter.Request<"Requires", ...>` marker
  until you `Layer.provide` the services onto the **handlers layer**
  (`HttpApiBuilder.group(...)` output) as in `guide.md`.
- Middleware `provides` are removed from the handler's requirements;
  `requires` and middleware *service* requirements are added.
- `HttpApiClient.ForApi<typeof Api>` is the client's type; `Client.Group` for one
  group. Its methods take only `{ params, query, payload, headers }` that the
  endpoint declares, plus optional `responseMode`.

## Status behaviour verified against a running server

| Case | Result |
| --- | --- |
| Payload fails schema | 400, empty body (`HttpApiSchemaError`) |
| Declared error with `httpApiStatus: 404` | that status; JSON body is the encoded error |
| Middleware error `Unauthorized` (401) | JSON `{ "_tag": "Unauthorized", ... }` |
| `HttpApiSchema.status(201)` on success | 201 |
| `NoContent` | 204 |
| Undeclared failure or defect | 500, no details |
