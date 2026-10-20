---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when implementing transport-level HTTP clients, servers, middleware, request bodies, routing, or connection lifecycles in Effect.
metadata:
  github-path: skills/effect-http
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: 51cf0d679703bd27f1ef0931815db18ce7914890
name: effect-http
---

# Effect HTTP

Use the effect/http entrypoint for transport-level HTTP work. It covers
HttpClient, HttpClientRequest/Response, HttpServer, HttpServerRequest/Response,
HttpRouter, HttpMiddleware, HttpBody, Headers, Cookies, Url, Mime, Multipart,
FetchHttpClient, status and method types, and trace context.

## Keep transport and domain separate

Construct a request with typed headers, URL parameters, and a body. Decode
untrusted input with the Schema skill, map transport errors at one boundary,
and keep domain Effects independent of Fetch or Node APIs.

```ts
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

const ResponseBody = Schema.Struct({ id: Schema.String });

const getUser = (id: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get("/users/" + id);
    const response = yield* client.execute(request);
    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ResponseBody)),
    );
  });
```

Check the installed v4 declarations for the exact client service and body
helpers. The important boundaries are request cancellation, response body
finalization, status handling, and schema decoding.

## Server workflow

1. Define routes and middleware as Effects with explicit requirements.
2. Validate path, query, headers, and body before invoking a service.
3. Map typed domain failures to status and response bodies in one handler
   layer.
4. Provide platform-specific server and logging Layers at startup.
5. Test cancellation while reading a body and shutdown while accepting a
   connection.

Streaming and multipart bodies must remain scoped. Do not read an unbounded
upload into memory, and do not return a response that still references a
closed stream.

## HTTP client review

Define retry rules by status and error class. Never retry a non-idempotent
request without an idempotency key or an application-level guarantee. Apply
timeouts and size limits, redact Authorization headers, and propagate trace
context intentionally.

## Common mistakes

- Calling JSON.parse directly on a response and skipping Schema.
- Treating every non-2xx response as the same error.
- Creating a new client and connection pool per request.
- Retrying a POST after a timeout without knowing whether the server committed.
- Logging full URLs that contain credentials or personal data.

## References

- [Effect HTTP modules](https://effect.website/docs/v4/api/effect)
- [HttpClient API](https://effect.website/docs/v4/api/effect/http/HttpClient)
- [HttpServer API](https://effect.website/docs/v4/api/effect/http/HttpServer)
- [Effect HTTP source](https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/effect/src/http)
