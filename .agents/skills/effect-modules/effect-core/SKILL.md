---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when deciding where an Effect runs or how typed failures, defects, and interruption propagate; also for core v3-to-v4 migration decisions.
metadata:
  github-path: skills/effect-core
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: dd05fd1a0a50f3c055dc4710dc4122feb6257ffa
name: effect-core
---

# Effect core runtime

Use this skill for the semantics of an Effect program, not for a particular
integration. It covers Effect, Cause, Exit, Result, Runtime, ManagedRuntime,
ExecutionPlan, Effectable, Function, and the run boundary.

## Version gate

Read the project package.json and lockfile before giving code. These examples
target the published stable `effect@4.0.0`; npm's `latest` is now v4.
Do not combine v3-only examples such
as Either, STM, or FiberRef with v4 code without an explicit migration.

## The model to preserve

Treat Effect<A, E, R> as a lazy description of a computation that can produce
A, fail with E, and require services R.

- Constructing an Effect must not start I/O.
- A typed failure is data in E; a defect is an unexpected bug; interruption
  is cancellation and normally must be allowed to propagate.
- An Exit preserves success or the complete Cause; a Result is useful when a
  value-level boundary does not need fibers, resources, or an environment.
- Run an effect only at a host boundary. Keep framework callbacks thin and
  inject a Runtime or ManagedRuntime rather than calling runPromise deep in
  domain code.

## A practical workflow

1. Write the domain operation as an Effect and keep its error type narrow.
2. Use Effect.gen or pipe for sequencing; use catchTag, catchAll, and mapError
   at a deliberate boundary.
3. Decide which failures are retriable before adding a Schedule.
4. Test success, typed failure, defect reporting, and interruption separately.
5. Choose runPromise, runSync, runFork, or a platform runMain only at the
   outermost integration boundary.

## Typed failure and interruption

```ts
import { Effect, Schedule } from "effect";

type NotFound = { readonly _tag: "NotFound"; readonly id: string };

const loadUser = (
  id: string,
): Effect.Effect<
  {
    readonly id: string;
    readonly name: string;
  },
  NotFound
> =>
  id === "missing"
    ? Effect.fail<NotFound>({ _tag: "NotFound", id })
    : Effect.succeed({ id, name: "Ada" });

const program = loadUser("u1").pipe(
  Effect.retry(Schedule.recurs(2)),
  Effect.catchTag("NotFound", (error) =>
    Effect.succeed({ id: error.id, name: "anonymous" }),
  ),
);

const user = await Effect.runPromise(program);
```

Do not retry defects or authorization failures merely because an operation
returned an error. If a branch is intentionally cancellable, preserve the
interrupt status instead of converting cancellation into a domain value.

## Inspecting failures

Use Effect.runPromiseExit or Effect.sandbox when diagnostics need the whole
Cause tree. Use Cause.findErrorOption only after deciding that parallel
failures, defects, and interruption can be collapsed safely. Log a structured
Cause at the boundary; do not stringify it in the domain layer.

```ts
import { Cause, Effect, Exit } from "effect";

const exit = await Effect.runPromiseExit(Effect.fail("bad-input"));
if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause));
}
```

## Common mistakes

- Performing await or starting a promise while building a domain Effect.
- Catching unknown at every layer and losing the typed error contract.
- Calling runSync for an effect that can suspend.
- Forking a fiber without a Scope or a join/interrupt policy.
- Treating an interruption Cause as an application error.
- Using Result where a resource, environment, or cancellation policy is
  required; use Effect instead.

## Boundaries

Use Context and Layer for dependencies, Scope for cleanup, Fiber and Schedule
for concurrency and repetition, and Schema for untrusted input. Hand off to
those skills when the question is about service assembly, resource lifetime,
or data decoding.

## References

- [Effect API](https://effect.website/docs/v4/api/effect/Effect)
- [Cause API](https://effect.website/docs/v4/api/effect/Cause)
- [Exit API](https://effect.website/docs/v4/api/effect/Exit)
- [Effect source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/Effect.ts)
- [Effect v4 releases](https://github.com/Effect-TS/effect/releases)
