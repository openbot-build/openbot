# Effect observability

## How to think about it

Telemetry in Effect is not a library you call; it is **ambient context** that
the runtime already carries. Every fiber knows its current span, its log
annotations, its log spans, its logger set, its tracer and its metric registry.
`Effect.log`, `Effect.withSpan` and `Metric.update` read that context; an
exporter is just a `Layer` that replaces one of those references. So the code
that does the work never mentions Datadog, OTLP or Prometheus. You instrument
*operations* (a named span, a log with structured fields, a counter) and decide
*where it goes* once, in the layer graph at the edge. Tests then provide a
different layer and read the telemetry back as plain data.

Three consequences people from Winston/pino/prom-client/OpenTelemetry-SDK
habits get wrong:

- **Context propagates for free, so do not thread it.** Do not pass a logger,
  a trace id or a `requestId` as a parameter. Annotate once at the entry
  (`Effect.annotateLogs`, `Effect.withSpan`) and every nested effect, including
  forked fibers, inherits it. `Effect.fn("Name")` already opens a span per call.
- **Cause, not message, is the unit of failure.** A typed error, a defect and an
  interruption are all `Cause`s. Log or report the `Cause` (which keeps stack
  and span trace), never `String(error)`, and never log the same failure at
  every layer.
- **Metrics are descriptors; state lives in a registry.** `Metric.counter(...)`
  is a cheap value you define at module level. Values accumulate in the
  `Metric.MetricRegistry` reference, so a test can give itself a fresh `Map`.

What to instrument: boundaries (request in, job start, outbound call, queue
publish, DB query), each with a span; decisions worth explaining, each with one
log line; rates, errors and durations, each with a metric. Not every line.

## Choose

| You need | Use | Why / notes |
| --- | --- | --- |
| A human or machine readable event | `Effect.logInfo`/`logWarning`/`logError` (+ `logDebug`/`logTrace`) | level-filtered by `References.MinimumLogLevel`; accepts several values and a `Cause` |
| Fields on every log line of a request | `Effect.annotateLogs({ requestId })` at the entry | inherited by children and forked fibers |
| Elapsed time on log lines | `Effect.withLogSpan("checkout")` | adds `checkout=12ms` style metadata, not a trace span |
| JSON logs in prod, pretty in dev | `Logger.layer([Logger.consoleJson])` chosen in a `Layer.unwrap` over `Config` | loggers are replaced, not appended, unless `mergeWithExisting: true` |
| Timing and causality across calls/services | `Effect.fn("Svc.method")`, `Effect.withSpan(name, { attributes })` | spans nest by fiber context; `Effect.annotateCurrentSpan` adds attributes after the fact |
| Counting events / current value / latency | `Metric.counter` / `gauge` / `timer` or `histogram` | `Metric.timer` takes a `Duration`; dimensions via `Metric.withAttributes` |
| Distinct values of a small enum | `Metric.frequency` | counts occurrences per string |
| Ship logs+metrics+traces to a collector | `Otlp.layerJson({ baseUrl, resource })` or `Otlp.layerFromConfig()` from `effect/observability` | needs an `HttpClient` layer; `layerFromConfig` reads standard `OTEL_*` env vars |
| Browser telemetry without shipping vendor keys | `OtlpProxy.layer({ baseUrl, headers, prefix })` | mounts `POST /v1/{traces,logs,metrics}` on your `HttpRouter`; the browser uses `Otlp.layer({ baseUrl: "/otlp" })` |
| Smaller OTLP payloads | `Otlp.layerJson({ baseUrl, compression: "gzip" })` | or `OTEL_EXPORTER_OTLP_COMPRESSION=gzip` with `layerFromConfig`; bodies under 1KB are sent as is |
| Drop a labelled series you no longer report | `Metric.remove(metric)` | per-attribute-set removal, e.g. a closed pool's gauge |
| Prometheus scrape endpoint | `PrometheusMetrics.layerHttp({ path })` | adds a route to an existing `HttpRouter`; `PrometheusMetrics.format()` gives the text |
| Send failures to Sentry-like tools | `ErrorReporter.make(...)` + `ErrorReporter.layer([...])`, trigger with `Effect.withErrorReporting` | skips interruption; honours `ErrorReporter.ignore`/`severity`/`attributes` on the error |
| Reuse an existing OpenTelemetry SDK | `@effect/opentelemetry` `NodeSdk` | not installed in this repo; check its README and versions before using |
| NOT for: audit trails, business events a customer sees | persist them as data ([sql](../sql/guide.md), [eventlog](../eventlog/guide.md)) | telemetry is lossy and sampled by design |

## Recipe

### A service that is observable without knowing about exporters

The naive version mixes concerns: `console.log`, a counter keyed by user id, a
catch that stringifies the error and loses the cause.

```ts skip
// PITFALL: unstructured, unbounded label, loses Cause, not testable
const checkout = async (userId: string, orderId: string) => {
  console.log(`checkout ${orderId} for ${userId}`)
  try {
    await charge(orderId)
    counter.labels({ user: userId }).inc() // one time series per user
  } catch (e) {
    console.error("failed: " + e)
  }
}
```

The idiomatic version: typed failure, one span per call, request-scoped log
annotations, metrics with a bounded `outcome` label, duration recorded on both
success and failure.

```ts import.meta.vitest name="references/observability/guide.md#2"
import { Context, Effect, Layer, Metric, Schema } from "effect"

// Expected failure: a caller can branch on it (retry, show a message).
export class PaymentDeclined extends Schema.TaggedError<PaymentDeclined>()("PaymentDeclined", {
  orderId: Schema.String,
  reason: Schema.String
}) {}

// Descriptors are plain module-level values; the registry holds the state.
// Labels are small closed sets ("ok" | "declined"), never ids or URLs.
const checkouts = Metric.counter("checkout_total", {
  description: "Completed checkout attempts by outcome",
  incremental: true
})
const checkoutDuration = Metric.timer("checkout_duration", {
  description: "Wall time of a checkout attempt"
})

export class Payments extends Context.Service<Payments, {
  charge(orderId: string, cents: number): Effect.Effect<void, PaymentDeclined>
}>()("app/Payments") {
  // A deterministic double: used by tests and local runs.
  static readonly layerDeclineOver = (limitCents: number) =>
    Layer.succeed(
      Payments,
      Payments.of({
        charge: (orderId, cents) =>
          cents > limitCents
            ? Effect.fail(new PaymentDeclined({ orderId, reason: "over limit" }))
            : Effect.void
      })
    )
}

export class Checkout extends Context.Service<Checkout, {
  run(orderId: string, cents: number): Effect.Effect<void, PaymentDeclined>
}>()("app/Checkout") {
  static readonly layer = Layer.effect(
    Checkout,
    Effect.gen(function*() {
      const payments = yield* Payments
      return Checkout.of({
        run: Effect.fn("Checkout.run")(
          function*(orderId: string, cents: number) {
            // Attributes on the span (high cardinality is fine on spans/logs,
            // never on metric labels).
            yield* Effect.annotateCurrentSpan({ "order.id": orderId, "order.cents": cents })
            yield* Effect.logInfo("charging card")

            // Time the attempt whether it succeeds or fails: capture the Exit,
            // record, then re-raise the exact same outcome.
            const [elapsed, exit] = yield* Effect.timed(Effect.exit(payments.charge(orderId, cents)))
            yield* Metric.update(checkoutDuration, elapsed)
            yield* Metric.update(
              Metric.withAttributes(checkouts, { outcome: exit._tag === "Success" ? "ok" : "declined" }),
              1
            )
            if (exit._tag === "Failure") {
              // Warn with the typed error as data; the caller decides what next.
              yield* Effect.logWarning("payment declined", exit.cause)
            }
            return yield* exit
          },
          // Every log line inside this call carries the order id; no
          // parameter threading.
          (effect, orderId) => Effect.annotateLogs(effect, { orderId })
        )
      })
    })
  ).pipe(Layer.provide(Payments.layerDeclineOver(50_000)))
}
```

Read the shape: `Checkout.run` has `E = PaymentDeclined` and `R = never`; it
knows nothing about where telemetry goes. A different `Payments` layer changes
behaviour without touching instrumentation.

### Choosing exporters at the composition root

Exporters are layers. Build them once, from `Config`, and provide them
underneath the app so spans from layer construction are covered too.

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer, Logger } from "effect"
import { FetchHttpClient } from "effect/http"
import { Otlp } from "effect/observability"

// Dev: pretty console logs and no exporter. Prod: JSON logs plus OTLP for
// logs, metrics and traces from one baseUrl. Choosing is a Config decision,
// made when the layer is built, not an if/else in business code.
const TelemetryLayer = Layer.unwrap(Effect.gen(function*() {
  const env = yield* Config.String("APP_ENV").pipe(Config.withDefault("development"))
  if (env !== "production") {
    return Logger.layer([Logger.consolePretty()])
  }
  const baseUrl = yield* Config.String("OTLP_BASE_URL")
  // Layers built side by side (Layer.mergeAll) do NOT see each other's logger
  // set, and the last one wins. Sequence them: the JSON logger layer is
  // provided first, then Otlp (mergeWithExisting defaults to true) adds its
  // exporter logger to that set.
  return Otlp.layerJson({
    baseUrl,
    resource: { serviceName: "checkout-api", serviceVersion: "1.0.0" }
  }).pipe(Layer.provideMerge(Logger.layer([Logger.consoleJson])))
})).pipe(
  // The exporter needs an HttpClient; this is the only place that decides which.
  Layer.provide(FetchHttpClient.layer)
)

const program = Effect.logInfo("service started").pipe(
  Effect.withSpan("startup")
)

// Layer.provide(telemetry) at the very end so everything above is covered;
// shutdown of the layer scope flushes buffered telemetry.
program.pipe(
  Effect.provide(TelemetryLayer),
  NodeRuntime.runMain
)
```

If you follow the OpenTelemetry environment convention, `Otlp.layerFromConfig()`
reads `OTEL_SDK_DISABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT` (or per-signal
endpoints), timeouts and batch settings. A signal is only exported when it has
an endpoint **and** `OTEL_LOGS_EXPORTER` / `OTEL_METRICS_EXPORTER` /
`OTEL_TRACES_EXPORTER` contains `otlp`; otherwise that signal is a no-op. That
is usually the right default for containers, but remember to set those
variables. See
[references/api-cheatsheet.md](api-cheatsheet.md) for the option
table and the Prometheus route.

To forward failures to an error tracker (`ErrorReporter.make`, `ErrorReporter.layer`, `Effect.withErrorReporting`, and the `ignore`/`severity`/`attributes` markers on error classes), see [references/error-reporting.md](error-reporting.md). Report at a boundary, ignore expected user errors, and register the reporter as a layer.

## Anti-patterns

**Metric label from unbounded data.** Each label value is a new time series;
a user id or URL explodes memory and bill.

```ts skip
Metric.update(Metric.withAttributes(requests, { userId, path: req.url }), 1)
```

Use a closed set (`method`, `status_class`, `outcome`) as the label and put the
id on the span or log: `Effect.annotateCurrentSpan({ "user.id": userId })`.

**`console.log` / `JSON.stringify(error)`.** It bypasses level filtering,
annotations, exporters and test capture, and drops the cause chain.

```ts skip
console.log("charge failed", JSON.stringify(error))
```

Use `yield* Effect.logWarning("charge failed", cause)`; the logger gets the
`Cause`.

**Logging at every layer while rethrowing.** The same failure appears N times
and alerting double-counts.

```ts skip
yield* repo.save(x).pipe(Effect.tapError((e) => Effect.logError(e)))
// ...and again in the service, and again in the handler
```

Handle it once where you decide what to do (or let `Effect.withErrorReporting`
at the boundary report it); inner layers add context with
`Effect.annotateLogs`/spans and let the error propagate.

**Hand-threading a request id.** It leaks into every signature and gets
forgotten in forked work.

```ts skip
const handle = (reqId: string) => service.run(reqId, input)
```

Annotate once: `service.run(input).pipe(Effect.annotateLogs({ requestId }))`
and `Effect.withSpan("http.request")`; children inherit it.

**Creating an exporter (or a logger layer) per request or per call.** Each one
opens connections and a batching fiber.

```ts skip
const handler = Effect.logInfo("hi").pipe(Effect.provide(Otlp.layerJson({ baseUrl })))
```

Build the telemetry layer once at the root and provide the app with it.

**Replacing instead of adding loggers by accident.** `Logger.layer([x])`
removes the default logger and any exporter installed earlier; logs vanish
from the console.

```ts skip
Layer.mergeAll(Otlp.layerJson({ baseUrl }), Logger.layer([jsonLogger])) // last wins, other logger lost
```

Layers combined with `Layer.mergeAll` build independently and the last
`CurrentLoggers` wins, so even `mergeWithExisting: true` does not help there
(verified: the earlier logger is dropped and the default console logger stays).
Sequence them instead: `Otlp.layerJson(...).pipe(Layer.provideMerge(Logger.layer([jsonLogger])))`,
or list every logger in one `Logger.layer([...])`.

**`Effect.orDie`/`Effect.ignore` hiding failures from telemetry.** A swallowed
failure leaves no metric, log or report.

```ts skip
yield* sendEmail(to).pipe(Effect.ignore)
```

Use `Effect.ignore({ log: true })` for best-effort work (logs the cause), or
`Effect.catch` and record a metric. Treat exporter failure the same way: it must
not fail the business operation.

**Starting spans by hand and forgetting to end them.** An unended span leaks
and breaks the tree.

```ts skip
const span = yield* Effect.makeSpan("work")
yield* doWork // never ended
```

Use `Effect.withSpan`, `Effect.fn("name")` or `Effect.useSpan`, which end the
span with the right `Exit`.

## Testing it

Capture telemetry as data by providing test implementations of the same
references. No sleeping, no network.

```ts import.meta.vitest name="references/observability/guide.md#12"
import assert from "node:assert/strict"
import { Effect, Logger, Metric, Tracer } from "effect"

const work = Effect.gen(function*() {
  yield* Effect.logInfo("charging card", { cents: 100 })
  yield* Metric.update(Metric.counter("jobs_total", { incremental: true }), 1)
}).pipe(
  Effect.annotateLogs({ orderId: "o1" }),
  Effect.withSpan("job.run", { attributes: { "job.kind": "demo" } })
)

const program = Effect.gen(function*() {
  const lines: Array<string> = []
  const spans: Array<Tracer.NativeSpan> = []

  // Logger.make receives { message, logLevel, cause, fiber, date }.
  const capture = Logger.make<unknown, void>(({ logLevel, message }) => {
    lines.push(`${logLevel}:${Array.isArray(message) ? message.map(String).join(" ") : String(message)}`)
  })
  // Tracer.make with NativeSpan records every span in memory.
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })

  // Fresh registry per test: counters do not leak between tests.
  yield* work.pipe(
    Effect.provide(Logger.layer([capture])),
    Effect.provideService(Tracer.Tracer, tracer),
    Effect.provideService(Metric.MetricRegistry, new Map())
  )

  assert.equal(lines.length, 1)
  assert.equal(spans[0]?.name, "job.run")
  assert.equal(spans[0]?.attributes.get("job.kind"), "demo")
})

await Effect.runPromise(program)
```

Read a metric back with `Metric.value(metric)` (a counter returns `{ count }`)
or `Metric.snapshot` inside the same `MetricRegistry` override. With
`@effect/vitest` the same body runs under `it.effect`; time-based exporters
(`exportInterval`) are driven with `TestClock.adjust`; see [testing](../testing/guide.md).
`Logger.layer([capture])` is an ordinary layer, so it can sit in a shared test
layer next to your service doubles. 
To assert on exporter output without waiting for `exportInterval`, require
`OtlpExporter.Flusher` (provided by every `Otlp*` layer) and call `flush`. A
fake `HttpClient` stands in for the collector, so nothing touches the network:

```ts import.meta.vitest name="references/observability/guide.md#13"
import { Effect, Layer, Metric } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Otlp, OtlpExporter } from "effect/observability"

const urls = new Set<string>()
const FakeCollector = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    urls.add(request.url)
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })))
  })
)

const program = Effect.gen(function*() {
  yield* Effect.logInfo("hello").pipe(Effect.withSpan("demo"))
  yield* Metric.update(Metric.counter("demo_total"), 1)
  const flusher = yield* OtlpExporter.Flusher
  yield* flusher.flush
}).pipe(
  Effect.provide(Otlp.layerJson({
    baseUrl: "http://collector:4318",
    compression: "gzip",
    resource: { serviceName: "demo" }
  })),
  Effect.provide(FakeCollector)
)

await Effect.runPromise(Effect.scoped(program))
Array.from(urls).sort().map((url) => url.replace("http://collector:4318", "")) // => ["/v1/logs", "/v1/metrics", "/v1/traces"]
```

## Changed in 4.1

Verified against `effect@4.1.2` sources (diffed with 4.0.0).

- `Otlp.layer`, `layerJson`, `layerProtobuf` and the per-signal layers accept
  `compression: "gzip" | "none"` (default `"none"`); `layerFromConfig` also
  reads `OTEL_EXPORTER_OTLP_COMPRESSION` and the per-signal
  `OTEL_EXPORTER_OTLP_{TRACES,LOGS,METRICS}_COMPRESSION`.
- The combined `Otlp.*` layers now declare `Layer<OtlpExporter.Flusher, ...>`,
  not `Layer<never, ...>`, so tests and serverless handlers can
  `yield* OtlpExporter.Flusher` and call `flush`.
- New `OtlpProxy` module (`make`, `layer`, `layerFromConfig`) to forward
  browser OTLP exports through your own server. It adds credentials
  server-side, so put authentication and rate limiting around it.
- `Metric.remove` / `Metric.removeUnsafe` / `Metric.registerUnsafe` remove or
  externally feed a single attribute series.
- OTLP output details changed: log attributes are `effect.fiberId`,
  `effect.log_span.<label>` and `exception.type|message|stacktrace`; interrupted
  spans are `Unset` with an `effect.fiber.interrupted` attribute instead of
  an error status; resource attributes include `telemetry.sdk.*`, and
  `resource.serviceName` is now optional. Dashboards keyed on the old names
  (`logSpan.*`, `log.error`, `span.label`) need updating.
- Ended spans ignore further attribute/event/link calls, and `Logger.batched`
  waits for an in-flight flush before the final drain on scope close.

## Boundaries

- Config values (endpoints, headers, `APP_ENV`) and `Config.Redacted` secrets:
  [config](../config/guide.md). Redact before logging; a `Redacted` value prints as
  `<redacted>`.
- Layer construction, scopes, shutdown order and why exporters are layers:
  [services](../services/guide.md).
- HTTP servers, client middleware (trace propagation headers) and the
  `/metrics` route's router: [http](../http/guide.md), [http-api](../http-api/guide.md).
- Typed errors vs defects, `Cause` inspection, retries: [core](../core/guide.md).
- Time-driven tests with `TestClock`, `it.effect`: [testing](../testing/guide.md); clocks and
  schedules: [time](../time/guide.md).
- Fiber metrics (`Metric.enableRuntimeMetrics`) and supervision:
  [concurrency](../concurrency/guide.md).

Errors cross this boundary as `Cause` values (logging, `ErrorReporter`);
resources cross it as exporter layers whose scope flushes on shutdown. Telemetry
failures are swallowed by exporters (they never fail the program); do not map
them into your domain error type.

## References

- [references/api-cheatsheet.md](api-cheatsheet.md) - verified signatures and option tables
- [references/error-reporting.md](error-reporting.md) - ErrorReporter recipe
- [Logger API](https://effect.website/docs/v4/api/effect/Logger)
- [Metric API](https://effect.website/docs/v4/api/effect/Metric)
- [Tracer API](https://effect.website/docs/v4/api/effect/Tracer)
- [ErrorReporter API](https://effect.website/docs/v4/api/effect/ErrorReporter)
- [Otlp API](https://effect.website/docs/v4/api/effect/observability/Otlp)
- [Metric source at 4.1.2](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Metric.ts)
- [Observability sources at 4.1.2](https://github.com/Effect-TS/effect/tree/effect%404.1.2/packages/effect/src/observability)
- [Upstream examples](https://github.com/Effect-TS/effect/tree/effect%404.1.2/ai-docs/src/08_observability)
