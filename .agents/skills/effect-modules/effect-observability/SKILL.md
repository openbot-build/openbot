---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when adding structured logs, metrics, tracing, error reporting, OTLP, Prometheus, or OpenTelemetry Layers to an Effect application.
metadata:
  github-path: skills/effect-observability
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: 0f0a1378bf94340be5b30f588e030f63a2e90bef
name: effect-observability
---

# Effect observability

Use Logger and LogLevel for structured events, Metric for application
measurements, Tracer for spans, and ErrorReporter/Formatter/Inspectable for
diagnostics. The effect/observability modules and @effect/opentelemetry add
OTLP, Prometheus, resource, logger, metric, and tracer exporters.

## Instrument boundaries, not every line

Name spans after domain operations and attach low-cardinality attributes.
Annotate a request or fiber once, then let context propagation carry it.
Record metrics with stable tags and a bounded label set. Logs should explain
the decision and correlation id without copying an entire payload.

```ts
import { Effect, Metric } from "effect";

const requests = Metric.counter("http_requests_total");
const loadUser = (id: string) => Effect.succeed({ id, name: "Ada" });

const handle = Effect.withSpan(
  Effect.gen(function* () {
    yield* Metric.update(requests, 1);
    return yield* loadUser("u1");
  }),
  "users.get",
);
```

`Metric.update` and `Metric.value` use the ambient `Metric.MetricRegistry`
reference; the default registry is suitable for a process, while tests can
provide an isolated `new Map()` with `Effect.provideService`. Check the
installed v4 signatures for Metric and `withSpan`. Keep the example's
principles: instrumentation is an Effect concern, and provider exporters are
Layers supplied at the application boundary.

## Provider setup

Choose the exporter package that matches deployment. Configure service name,
environment, endpoint, sampling, and export shutdown through Config. Compose
the OpenTelemetry Layer once with the service graph and close it with the
ManagedRuntime or platform Scope.

Use OtlpLogger, OtlpMetrics, OtlpTracer, and PrometheusMetrics only after
deciding what the backend expects. Do not create a new exporter per request.

## Failure and privacy

Exporter failure must not take down the business operation unless telemetry is
a hard requirement. Bound queues and export retries. Redact secrets, tokens,
request bodies, and personal identifiers before they reach Logger, Metric
labels, traces, or error reports.

## Review checklist

- Are metric labels bounded and stable?
- Can a trace join client, server, queue, and database spans?
- Is the service/resource identity set once?
- Are exporter retries and shutdown tested?
- Does a defect retain its Cause and stack information?
- Are logs useful without sensitive payloads?

## Common mistakes

- Using a user id or URL as an unbounded metric label.
- Logging the same exception at every layer.
- Treating a dropped telemetry export as a domain failure.
- Starting exporters before configuration and runtime signals are ready.

## References

- [Logger API](https://effect.website/docs/v4/api/effect/Logger)
- [Metric API](https://effect.website/docs/v4/api/effect/Metric)
- [Tracer API](https://effect.website/docs/v4/api/effect/Tracer)
- [Effect observability source](https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/effect/src/observability)
- [OpenTelemetry package](https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/opentelemetry)
