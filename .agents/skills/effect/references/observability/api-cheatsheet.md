# Observability API cheat sheet (effect@4.1.x)

Every name below was checked against `node_modules/effect/src`. The OTLP and
Prometheus modules are `@stability unstable`: pin `effect` exactly.

## Logging

```ts import.meta.vitest name="references/observability/api-cheatsheet.md#1"
import { Effect, Logger, References } from "effect"
import { Layer } from "effect"

// Level helpers: log (Info), logTrace, logDebug, logInfo, logWarning, logError, logFatal.
// They accept several values; passing a Cause as an argument attaches it.
export const demo = Effect.gen(function*() {
  yield* Effect.logInfo("user created", { id: "u1" })
  yield* Effect.logWarning("slow query", { ms: 840 })
}).pipe(
  // Fields on every line emitted inside.
  Effect.annotateLogs({ service: "users" }),
  // Adds a "label=elapsed ms" entry to every line inside.
  Effect.withLogSpan("create-user")
)

// Minimum level is a Reference: provide it as a Layer or with provideService.
export const QuietLayer = Layer.succeed(References.MinimumLogLevel, "Warn")

// Loggers are a set on the CurrentLoggers reference. Logger.layer REPLACES the
// set unless { mergeWithExisting: true }.
export const JsonLogs = Logger.layer([Logger.consoleJson])
export const Both = Logger.layer([Logger.consolePretty()], { mergeWithExisting: true })
```

| Name | Signature / meaning |
| --- | --- |
| `Logger.make` | `(log: (o: { message, logLevel, cause, fiber, date }) => Output) => Logger<Message, Output>` |
| `Logger.layer` | `(loggers: ReadonlyArray<Logger \| Effect<Logger>>, { mergeWithExisting? }) => Layer` |
| `Logger.consoleJson`, `consoleLogFmt`, `consoleStructured` | ready console loggers |
| `Logger.consolePretty(options?)` | `{ colors?: "auto"\|boolean, formatDate?, mode?: "browser"\|"tty"\|"auto" }` |
| `Logger.formatSimple`, `formatLogFmt`, `formatStructured`, `formatJson` | string/record formatters to feed `toFile`/`batched`/`map` |
| `Logger.toFile(logger, path, options?)` | scoped; requires `FileSystem`; options include `batchWindow` |
| `Logger.batched(logger, { window, flush })` | batch outputs and flush as an effect (see the upstream example) |
| `Logger.tracerLogger` | writes log lines as span events |
| `Logger.LogToStderr` | `Context.Reference<boolean>` |
| `References.MinimumLogLevel` | `"All" \| "Fatal" \| "Error" \| "Warn" \| "Info" \| "Debug" \| "Trace" \| "None"` |
| `References.CurrentLogAnnotations`, `CurrentLogSpans` | what `annotateLogs`/`withLogSpan` set |
| `LogLevel.isEnabled(level)` | `Effect<boolean>`; guard expensive debug payloads |

## Tracing

| Name | Meaning |
| --- | --- |
| `Effect.fn("name")(function*(...) {...})` | span + stack frame per call |
| `Effect.fnUntraced(function*(...) {...})` | no span (hot paths, library internals) |
| `Effect.withSpan(self, name, options?)` / `Effect.withSpan(name, options?)` | child span; options: `attributes`, `links`, `parent`, `root`, `kind`, `sampled`, `level`, `captureStackTrace` |
| `Effect.annotateCurrentSpan(key, value)` / `(record)` | add attributes to the active span |
| `Effect.annotateSpans(key, value)` / `(record)` | annotate every span created inside |
| `Effect.currentSpan` | `Effect<Span, NoSuchElementError>` |
| `Effect.useSpan(name, options?, (span) => ...)` | manually scoped span |
| `Effect.withSpanScoped`, `Effect.makeSpanScoped` | span ends when the surrounding `Scope` closes |
| `Effect.linkSpans(self, span)` | add links (fan-in, queue consumers) |
| `Layer.withSpan(name)` / `Layer.span(name)` | span around layer construction |
| `Effect.withTracerEnabled(false)` | switch tracing off for a region |
| `Tracer.CurrentTraceLevel`, `Tracer.MinimumTraceLevel` | drop low-level spans from sampling |
| `Tracer.externalSpan({ traceId, spanId, ... })` | continue a trace from an incoming header |

## Metrics

```ts import.meta.vitest name="references/observability/api-cheatsheet.md#2"
import { Duration, Effect, Metric } from "effect"

const jobs = Metric.counter("jobs_total", { incremental: true })
const queueDepth = Metric.gauge("queue_depth")
const latency = Metric.timer("job_duration")
const sizes = Metric.histogram("payload_bytes", {
  boundaries: Metric.exponentialBoundaries({ start: 64, factor: 2, count: 10 })
})
const kinds = Metric.frequency("job_kind")

export const record = Effect.gen(function*() {
  yield* Metric.update(Metric.withAttributes(jobs, { outcome: "ok" }), 1)
  yield* Metric.update(queueDepth, 12)
  yield* Metric.update(latency, Duration.millis(35)) // timer takes a Duration
  yield* Metric.update(sizes, 2048)
  yield* Metric.update(kinds, "email")
  const state = yield* Metric.value(jobs) // { count, incremental }
  return state.count
})
```

| Name | Notes |
| --- | --- |
| `Metric.counter(name, { description?, attributes?, bigint?, incremental? })` | `incremental: true` rejects negative updates |
| `Metric.gauge(name, options?)` | last value wins |
| `Metric.histogram(name, { boundaries, description?, attributes? })` | boundaries required; helpers `linearBoundaries`, `exponentialBoundaries`, `boundariesFromIterable` |
| `Metric.timer(name, options?)` | histogram of milliseconds, input is a `Duration` |
| `Metric.summary`, `Metric.summaryWithTimestamp` | quantile summaries |
| `Metric.frequency(name, options?)` | per-string occurrences |
| `Metric.withAttributes(metric, attrs)` | dual (data-first and data-last) |
| `Metric.update(metric, input)`, `Metric.modify`, `Metric.value`, `Metric.snapshot`, `Metric.dump` | `dump` is a debug table |
| `Metric.remove(metric)` / `Metric.removeUnsafe(metric, context)` | drop the series for the current `CurrentMetricAttributes` |
| `Metric.MetricRegistry` | `Context.Reference<Map>`; override with `Effect.provideService(..., new Map())` |
| `Metric.enableRuntimeMetrics` / `enableRuntimeMetricsLayer` | fiber runtime metrics, off by default |

Removing one labelled series (for example when a pool closes) leaves the others:

```ts import.meta.vitest name="references/observability/api-cheatsheet.md#3"
import { Effect, Metric } from "effect"

const connections = Metric.gauge("connections")

const program = Effect.gen(function*() {
  yield* Metric.update(connections, 3).pipe(Effect.provideService(Metric.CurrentMetricAttributes, { pool: "a" }))
  yield* Metric.update(connections, 5).pipe(Effect.provideService(Metric.CurrentMetricAttributes, { pool: "b" }))
  yield* Metric.remove(connections).pipe(Effect.provideService(Metric.CurrentMetricAttributes, { pool: "a" }))
  return (yield* Metric.snapshot).map((snapshot) => snapshot.attributes)
})

await Effect.runPromise(Effect.provideService(program, Metric.MetricRegistry, new Map())) // => [{ pool: "b" }]
```

## Error reporting

| Name | Notes |
| --- | --- |
| `ErrorReporter.make(({ cause, error, attributes, severity, fiber, timestamp }) => void)` | skips interrupts, dedupes the same Cause/object |
| `ErrorReporter.layer([reporter], { mergeWithExisting? })` | default replaces existing reporters |
| `Effect.withErrorReporting` / `Effect.withErrorReporting({ defectsOnly: true })` | report a failing effect's Cause |
| `ErrorReporter.report(cause)` | manual report, does not fail |
| `[ErrorReporter.ignore] = true`, `[ErrorReporter.severity]`, `[ErrorReporter.attributes]` | properties on your error class |

## OTLP (`import { Otlp, OtlpTracer, OtlpLogger, OtlpMetrics, OtlpSerialization, OtlpExporter, PrometheusMetrics } from "effect/observability"`)

| Layer | Requires | Notes |
| --- | --- | --- |
| `Otlp.layerJson(options)` / `layerProtobuf(options)` | `HttpClient` | logs+metrics+traces to `${baseUrl}/v1/{logs,metrics,traces}` |
| `Otlp.layer(options)` | `HttpClient`, `OtlpSerialization` | choose serializer separately (`OtlpSerialization.layerJson` / `layerProtobuf`) |
| `Otlp.layerFromConfig({ resource?, headers?, ... })` | `HttpClient`, `OtlpSerialization` | reads `OTEL_*` env vars |
| `OtlpTracer.layer({ url, resource, ... })`, `OtlpLogger.layer`, `OtlpMetrics.layer` | same | one signal; each also provides `OtlpExporter.Flusher` |

`Otlp.layer` options: `baseUrl`, `resource` (`serviceName`, `serviceVersion`,
`attributes`), `headers`, `maxBatchSize`, `tracerContext`, `loggerExportInterval`,
`loggerExcludeLogSpans`, `loggerMergeWithExisting`, `compression` (`"gzip" | "none"`), `metricsExportInterval`,
`metricsTemporality` (`"cumulative" | "delta"`), `tracerExportInterval`,
`shutdownTimeout`.

`OtlpProxy.layer({ baseUrl, headers?, prefix?, signals?, urls?, maxBodySize?, timeout? })`
needs `HttpRouter` and `HttpClient`; it mounts `POST <prefix>/v1/{traces,logs,metrics}`
and forwards `application/json` or `application/x-protobuf` bodies with your
server-side headers. `OtlpProxy.layerFromConfig` takes the upstream from `OTEL_EXPORTER_OTLP_*`.

Prometheus: `PrometheusMetrics.layerHttp({ path?, prefix?, metricNameMapper? })`
needs an `HttpRouter` in the environment and serves text exposition
(default path `/metrics`); `PrometheusMetrics.format(options?)` returns the text
as an `Effect<string>`.

## Reading these types

- `Layer<ROut, E, RIn>`: the OTLP layers have `ROut = Flusher` (or `never`) and
  `RIn = HttpClient | OtlpSerialization`. The leftover `RIn` is what you still
  owe; `Layer.provide(FetchHttpClient.layer)` pays the first, `OtlpSerialization.layerJson`
  the second.
- `Context.Reference<A>` values (`MinimumLogLevel`, `MetricRegistry`, `Tracer.Tracer`)
  have defaults, so they never appear in `R`; you override them with `Layer.succeed(Ref, value)`
  or `Effect.provideService(Ref, value)`.
