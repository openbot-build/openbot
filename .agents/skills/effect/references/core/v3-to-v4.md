# Effect v3 names that do not exist in 4.x

Everything on the right was confirmed in `node_modules/effect/src`. If you
remember a v3 name that is not listed, grep the module before using it.

| v3 | v4 | Note |
| --- | --- | --- |
| `Effect.catchAll` | `Effect.catch` | typed failures only |
| `Effect.catchAllCause` | `Effect.catchCause` | |
| `Effect.catchAllDefect` | `Effect.catchDefect` | |
| `Effect.catchSome`, `Effect.catchSomeCause` | `Effect.catchIf`, `Effect.catchFilter`, `Effect.catchCauseIf` | |
| `Effect.orElse`, `Effect.orElseFail` | `Effect.catch`, `Effect.mapError`, `Effect.orElseSucceed` | |
| `Effect.either`, `Either` | `Effect.result`, `Result` module | `Result.Success` has `.success`, `Result.Failure` has `.failure` |
| `Effect.tapErrorCause` | `Effect.tapCause` | |
| `Effect.async`, `Effect.asyncEffect` | `Effect.callback` | `resume` takes an Effect; return a finalizer |
| `Effect.fork` | `Effect.forkChild` | |
| `Effect.forkDaemon` | `Effect.forkDetach` | |
| `Effect.forkAll` | `Effect.forEach` + `forkChild`, or `FiberSet`/`FiberMap` | see [concurrency](../concurrency/guide.md) |
| `Effect.zipRight` / `zipLeft` | `Effect.andThen` / `Effect.tap` | |
| `Effect.timeoutFail`, `timeoutTo` | `Effect.timeoutOrElse`, `Effect.timeoutOption` | `timeout` itself still exists |
| `Effect.dieMessage`, `dieSync` | `Effect.die(new Error("..."))` | |
| `Effect.if`, `Effect.unless`, `whenEffect` | plain `if` inside `gen`; `Effect.when(cond)` returns `Option<A>` | |
| `Effect.makeSemaphore` | `Semaphore.make(permits)` | module `Semaphore` |
| `Effect.runtime`, `Runtime.runPromise` | `Effect.runPromiseWith(context)`, `ManagedRuntime` | |
| `Effect.Tag`, `Context.Tag`, `Context.GenericTag` | `Context.Service<Self, Shape>()("id")` | see [services](../services/guide.md) |
| `Effect.Service` | `Context.Service` with a static `layer` | |
| `Layer.scoped`, `Layer.scopedDiscard` | `Layer.effect`, `Layer.effectDiscard` | the layer's own `Scope` is provided automatically |
| `FiberRef` | `Context.Reference` / `References.*` | e.g. `References.MinimumLogLevel` |
| `Data.TaggedError` | unchanged: `Data.TaggedError("T")<{...}>` | |
| `Schema.TaggedError<Self>()("T", fields)` | unchanged | confirmed at 4.1.2 |
| `Effect.provide(layer)` | unchanged; also accepts an array of layers | provide at the root only |

Imports: unstable modules are published sub-paths now (`effect/http`,
`effect/http-api`, `effect/sql`, `effect/ai`, `effect/cli`, `effect/rpc`,
`effect/cluster`, `effect/workflow`, `effect/testing`...). The
`effect/unstable/...` paths are gone.
