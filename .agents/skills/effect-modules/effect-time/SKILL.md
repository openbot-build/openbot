---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when choosing retry or repeat schedules, polling, timeouts, cron jobs, time zones, and clock behavior in Effect.
metadata:
  github-path: skills/effect-time
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: 766f78593b5d5ffd7c3edb3adbbe1b2407b9dfd9
name: effect-time
---

# Effect time and scheduling

Use Schedule for retry/repeat policy, Cron for calendar expressions, Duration
for elapsed time, DateTime for instants and calendar values, and Clock for a
testable time source. Scheduler and Random matter when custom runtime
behavior or deterministic randomness is part of the design.

## Decide what kind of time you mean

- Duration is elapsed time. Do not add it to a wall-clock string by hand.
- DateTime is an instant or calendar value. Make the timezone decision
  explicit at the boundary.
- Clock gives Effects a replaceable current-time and monotonic-time service.
- Schedule describes a policy; it is not itself a loop.
- Cron describes calendar occurrences; it is not a retry backoff.

## Retry with a bounded policy

```ts
import { Duration, Effect, Schedule } from "effect";

const retryPolicy = Schedule.exponential(Duration.millis(100)).pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 4 }),
);

const program = Effect.retry(
  Effect.tryPromise(() => fetch("https://example.test")),
  retryPolicy,
);
```

Before adding a policy, classify the failure. Retry transient transport and
rate-limit errors, not validation, authentication, or a defect. Put a total
attempt or elapsed-time bound on every production retry.

## Repeat and cron

Use repeat for successful work that should happen again; use retry for
failure-driven work. Use Cron when the product requirement is a wall-clock
calendar such as "at 02:00 in the tenant timezone". Store the timezone with
the job, and test daylight-saving transitions.

## Deterministic tests

Inject Clock and use TestClock for sleeps, schedules, timeouts, and polling.
Avoid Date.now and setTimeout inside an Effect service; those calls bypass the
test runtime and make cancellation hard to assert. Use a fake Random service
when a test needs stable jitter or identifiers.

## Review traps

- Mixing milliseconds, seconds, and Duration values.
- Using exponential backoff without jitter against a shared dependency.
- Letting a retry policy hide a permanent failure or run forever.
- Doing JavaScript Date arithmetic across a daylight-saving boundary.
- Scheduling work on a global timer with no Scope or shutdown signal.

## References

- [Schedule API](https://effect.website/docs/v4/api/effect/Schedule)
- [Cron API](https://effect.website/docs/v4/api/effect/Cron)
- [Duration API](https://effect.website/docs/v4/api/effect/Duration)
- [DateTime API](https://effect.website/docs/v4/api/effect/DateTime)
- [Clock API](https://effect.website/docs/v4/api/effect/Clock)
- [Pinned Schedule source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/Schedule.ts)
