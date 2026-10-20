---
compatibility: Examples target effect@4.0.0; align @effect/* packages. Effect v3 requires migration.
description: Use when testing Effect behavior with deterministic Layers or clocks, including typed failures, interruption, finalizers, and examples.
metadata:
  github-path: skills/effect-testing
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: 1630eb99c7ecbabdb3ecfd81f2915a374abb95c0
name: effect-testing
---

# Effect testing

Use TestClock for time, TestConsole for captured output, TestSchema for
schema-focused assertions, and @effect/vitest for integration with Vitest.
The goal is to test the Effect graph and its boundaries deterministically,
not to replace every dependency with a mock.

## Test the contract

For each service or workflow, cover:

1. the success value and provided services;
2. the typed failure and its Cause;
3. interruption while an Effect is suspended;
4. resource finalization after success, failure, and interruption;
5. concurrency and retry bounds where they affect correctness.

Provide test Layers at the boundary. Keep the domain operation identical to
production and replace the clock, console, filesystem, database, or network
adapter with a deterministic implementation.

```ts
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

const program = Effect.gen(function* () {
  yield* Effect.sleep("5 seconds");
  return "done";
});

const test = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(program);
  yield* TestClock.adjust("5 seconds");
  return yield* Fiber.join(fiber);
});

const result = test.pipe(Effect.provide(TestClock.layer()));
```

Confirm the exact testing import and assertion helpers for the installed v4
stable release. The test should advance TestClock instead of waiting on a
real timer.

## Vitest integration

Use the @effect/vitest helpers to run an Effect with its required Layer and to
preserve typed failures in the assertion output. Keep pure collection and
Schema tests ordinary Vitest tests; reserve Effect test helpers for runtime,
Scope, concurrency, and service behavior.

TestConsole is useful for asserting structured output without writing to the
developer terminal. TestSchema should exercise the accepted, rejected, and
transformed shapes rather than snapshotting an opaque error string.

In stable 4.0.0, rename `TestSchema.verifyLosslessTransformation` to
`verifyRoundTrip`. `succeedEffect`, `failEffect`, and `verifyRoundTripEffect`
allow schema assertions to use the calling Effect's services and interruption;
check the installed declaration before depending on these unstable helpers.

## Review traps

- Sleeping in real time to test a Schedule or timeout.
- Asserting only the final value and missing an unclosed resource or child
  fiber.
- Reusing a global mutable test Layer across cases.
- Mocking Effect.runPromise instead of testing the Effect before the host
  boundary.
- Treating doctest examples as documentation only; @effect/doctest makes them
  executable compatibility checks.

## References

- [TestClock API](https://effect.website/docs/v4/api/effect/testing/TestClock)
- [TestConsole API](https://effect.website/docs/v4/api/effect/testing/TestConsole)
- [TestSchema API](https://effect.website/docs/v4/api/effect/testing/TestSchema)
- [@effect/vitest](https://effect.website/docs/v4/api/vitest)
- [Effect testing guide](https://effect.website/docs)
- [Pinned TestClock source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/testing/TestClock.ts)
