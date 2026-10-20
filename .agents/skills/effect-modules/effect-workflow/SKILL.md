---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: "Use when an Effect operation must survive restarts or suspension: define durable workflows, activities, timers, signals, queues, replay, and idempotency."
metadata:
  github-path: skills/effect-workflow
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: 8f6a50bc28391724d512f780d4b5d2cd2f44625f
name: effect-workflow
---

# Durable workflows

Use `effect/workflow` when a named execution needs an engine-owned
identity and result across process lifetimes. A normal Effect or forked fiber
does not gain durability from a retry policy. v4 workflow APIs are
unstable; read the installed declarations before upgrading or porting v3.

## Choose an engine-visible boundary

- Define payload, success, and error schemas and a stable idempotency key on
  `Workflow`. Execute or poll through `WorkflowEngine`.
- Put a named external action in `Activity`: its encoded exit is replayed.
  Use `DurableClock` or `DurableDeferred` for suspension that the engine can
  observe; use `DurableQueue` for worker handoff.
- A memory engine is a test fixture, not a restart-surviving deployment.
  Back the engine and queue with persistent storage and plan schema upgrades.

```ts
import { Effect, Schema } from "effect";
import { Activity, Workflow } from "effect/workflow";

const Charge = Activity.make({
  name: "billing.charge",
  success: Schema.Void,
  error: Schema.String,
  execute: Effect.succeed(undefined),
});

const Billing = Workflow.make("billing.run", {
  payload: { id: Schema.String },
  success: Schema.Void,
  error: Schema.String,
  idempotencyKey: ({ id }) => id,
});

const BillingLayer = Billing.toLayer(() => Charge.execute);
```

Replay can repeat the workflow body around suspension. Use a business-level
idempotency key or outbox for an external charge; an activity name alone does
not guarantee exactly-once delivery. Scope worker and engine layers for
shutdown and map their operational failures at the API boundary.

## Adjacent responsibilities

RPC defines a typed remote protocol, Cluster owns sharded entities, EventLog
owns append-only facts, and Persistence provides stores and queues. Use SQL
when application records and transactions need a relational database rather
than a workflow execution log.

## Sources

- [Workflow API](https://effect.website/docs/v4/api/effect/workflow/Workflow)
- [Activity API](https://effect.website/docs/v4/api/effect/workflow/Activity)
- [Pinned Workflow source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/workflow/Workflow.ts)
