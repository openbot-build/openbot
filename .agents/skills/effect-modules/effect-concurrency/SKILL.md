---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when coordinating fibers, queues, pub-sub, deferred results, semaphores, pools, fiber sets, or interruption-safe background work in Effect.
metadata:
  github-path: skills/effect-concurrency
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: e3252421509137b1931cd7216b37dd91e0d5a1e3
name: effect-concurrency
---

# Effect concurrency

Use this skill for coordination between fibers. It covers Fiber, FiberHandle,
FiberSet, FiberMap, Deferred, Queue, PubSub, Semaphore,
PartitionedSemaphore, Pool, and Latch.

## Start with ownership

Every fork needs a policy: who joins it, who interrupts it, and which Scope
owns it. Prefer structured combinators such as forkScoped, race, timeout, and
bounded forEach over a detached background fiber.

Before selecting a primitive, answer:

- Is the value delivered once (Deferred), to one consumer (Queue), or to all
  subscribers (PubSub)?
- Should a full buffer apply backpressure, drop new values, or slide old
  values away?
- Is the limit global (Semaphore) or per key (PartitionedSemaphore)?
- Does a worker need a pooled resource (Pool) or just a bounded task count?

## A scoped producer/consumer loop

```ts
import { Effect, Queue } from "effect";

const worker = (queue: Queue.Queue<string>) =>
  Effect.forever(
    Effect.gen(function* () {
      const job = yield* Queue.take(queue);
      yield* Effect.logInfo("processing " + job);
    }),
  );

const program = Effect.scoped(
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<string>(100);
    yield* Effect.forkScoped(worker(queue));
    yield* Queue.offer(queue, "job-1");
    yield* Effect.sleep("10 millis");
    yield* Queue.shutdown(queue);
  }),
);
```

The example is intentionally scoped: leaving the Scope interrupts the worker,
but `Queue.bounded` is not itself scope-bound. Call `Queue.shutdown(queue)` when
the queue needs an explicit terminal state; shutdown discards buffered messages
and resumes pending queue operations. In a real program, use a typed job error
and a shutdown signal instead of an infinite loop with no observability.

## Fiber coordination

Use Deferred for one result or a readiness gate. Use Fiber.join when the parent
owns the result, and Fiber.interrupt or Scope shutdown for cancellation. Use
FiberSet and FiberMap for dynamic child groups and ensure failures are
observed. race is appropriate only when the losing branch can be interrupted
safely.

Use Semaphore around a scarce external resource, not as a substitute for
backpressure. A Pool owns reusable resources and therefore needs a Scope and
an explicit acquisition timeout.

## Review traps

- Queue.unbounded can turn a traffic spike into an out-of-memory event.
- Dropping or sliding a queue is a data-loss decision; document it.
- PubSub only delivers to current subscribers unless a replay buffer is
  configured. Bounded hubs apply backpressure; dropping hubs discard new
  messages when full; sliding hubs evict old messages. Choose that loss policy
  explicitly and do not use PubSub as a durable event log.
- Forking a fiber in a request handler without a request Scope leaks work.
- A semaphore permit must be released on failure and interruption; use the
  provided withPermits or acquire-release combinators.
- Never busy-loop on a Deferred or Queue; suspension is the point.

## Testing concurrency

Test bounded behavior, cancellation, and shutdown. Use TestClock where delays
are involved and deterministic fake services for the work itself. Assert that
a scope exit interrupts every child and that no fiber failure is left
unobserved.

## References

- [Fiber API](https://effect.website/docs/v4/api/effect/Fiber)
- [Queue API](https://effect.website/docs/v4/api/effect/Queue)
- [PubSub API](https://effect.website/docs/v4/api/effect/PubSub)
- [Semaphore API](https://effect.website/docs/v4/api/effect/Semaphore)
- [Effect documentation](https://effect.website/docs)
- [Pinned Fiber source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/Fiber.ts)
