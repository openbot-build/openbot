# Reporting failures and keeping expected ones quiet

```ts import.meta.vitest name="references/observability/error-reporting.md#1"
import { Data, Effect, ErrorReporter } from "effect"

// Expected, user-caused: never page anyone for it.
class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {
  readonly [ErrorReporter.ignore] = true
}

// Operationally important: carries a severity and context for the reporter.
class ChargeFailed extends Data.TaggedError("ChargeFailed")<{ readonly orderId: string }> {
  readonly [ErrorReporter.severity] = "Error" as const
  readonly [ErrorReporter.attributes] = { orderId: this.orderId }
}

const reported: Array<string> = []
const reporter = ErrorReporter.make(({ error, severity, attributes }) => {
  // This is where a Sentry/Rollbar client call would go. Interruptions never
  // reach here and the same Cause is never reported twice.
  reported.push(`${severity}:${error.message}:${JSON.stringify(attributes)}`)
})

// withErrorReporting reports the Cause when the wrapped effect FAILS, so put
// it inside whatever recovers or ignores the failure, not outside.
const guarded = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.withErrorReporting, Effect.ignore)

const work = Effect.all([
  guarded(Effect.fail(new NotFound({ id: "x" }))), // ignored: nothing reported
  guarded(Effect.fail(new ChargeFailed({ orderId: "o1" }))) // reported once, severity Error
])

// Reporters are a Layer too: provide at the root, swap in tests.
await Effect.runPromise(Effect.provide(work, ErrorReporter.layer([reporter]))).then(() => reported)
```

`Effect.withErrorReporting` marks a boundary (a request handler, a job). HTTP
server, `HttpApi` and RPC server handlers already report through the same
mechanism, so register a reporter layer rather than catching in each handler.
Use `{ defectsOnly: true }` when typed failures are normal control flow and only
bugs should reach the tracker.
