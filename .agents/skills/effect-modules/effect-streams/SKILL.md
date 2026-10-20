---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when processing incremental or unbounded values with backpressure, batching, merging, sinks, and resource-safe consumption.
metadata:
  github-path: skills/effect-streams
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: 50349887dbb65e2090b8ebdd9619c9520b27cab8
name: effect-streams
---

# Effect streams and pipelines

Use Stream for most application pipelines. Reach for Channel only when
implementing a low-level pull/push protocol, and use Sink to make consumption
and the output type explicit. Take and Pull describe the stream boundary;
Chunk is the efficient batch representation.

## Choose the right abstraction

- Stream<A, E, R> describes a lazy source of values.
- Sink<A, In, L, E, R> describes how a source is consumed and what it emits.
- Channel is lower-level and useful for protocol adapters and custom stream
  operators, not as a default application abstraction.
- Take makes a chunk, failure, or end marker explicit for queue and pub-sub
  bridges.
- ChannelSchema belongs at a typed serialization boundary, not in ordinary
  collection code.

## Build first, run once

```ts
import { Effect, Stream } from "effect";

const lines = Stream.fromIterable(["1", "2", "bad"]).pipe(
  Stream.mapEffect((value) =>
    Effect.gen(function* () {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed)) {
        return yield* Effect.fail({ _tag: "ParseError" as const, value });
      }
      return parsed;
    }),
  ),
  Stream.filter((value) => value > 0),
);

const program = Stream.runCollect(lines);
const values = await Effect.runPromise(program);
```

The stream is inert until runCollect (or another sink) consumes it. Keep
resource acquisition inside Stream.scoped or Effect.scoped so interruption
closes the file, socket, or client.

## Backpressure and concurrency

Decide explicitly between sequential mapEffect, bounded concurrent mapping,
merge, zip, and flatMap. Preserve ordering only when the product requires it.
A faster producer should suspend behind a bounded buffer rather than create an
unbounded queue.

For a long-lived consumer:

1. make the source scoped;
2. use a bounded queue or the stream buffering operator;
3. define the failure policy for one branch of a merge;
4. close the Scope on shutdown and assert that the consumer fiber ends.

## Sinks and errors

Use a Sink to express whether a pipeline returns a collection, a fold, the
first value, or a summary. Keep parse and transport failures typed. A stream
failure ends the stream; it is not the same thing as an empty stream. Preserve
Cause when diagnosing parallel or interrupted pipelines.

## Review traps

- Calling runCollect on an unbounded source.
- Performing I/O while constructing a Stream.
- Using Channel because its API is lower-level, then losing resource
  finalization or backpressure.
- Flattening with unlimited concurrency against a rate-limited service.
- Converting all errors to strings before a downstream recovery policy can
  inspect them.

## Testing

Use small finite sources for operator tests, TestClock for time-based
operators, and a fake service Layer for mapEffect. Test cancellation while a
pull is suspended and verify that a scoped source releases its resource.

## References

- [Stream API](https://effect.website/docs/v4/api/effect/Stream)
- [Channel API](https://effect.website/docs/v4/api/effect/Channel)
- [Sink API](https://effect.website/docs/v4/api/effect/Sink)
- [Take API](https://effect.website/docs/v4/api/effect/Take)
- [Effect documentation](https://effect.website/docs)
- [Pinned Stream source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/Stream.ts)
