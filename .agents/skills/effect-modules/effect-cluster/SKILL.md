---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when routing stateful messages by entity ID across processes with Effect sharding, runners, singleton ownership, or cluster-backed workflows.
metadata:
  github-path: skills/effect-cluster
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: c051a988ba94e23a020f139cb16226a833dbf0cf
name: effect-cluster
---

# Effect cluster

Use `effect/cluster` when a message needs an entity owner chosen by
sharding. An ordinary RPC request does not need a cluster. This v4 API is
unstable and incompatible with v3 cluster package examples.

## Entity and deployment boundary

Define serializable requests with RPC schemas, implement them as entity
handlers, and supply Sharding, runner, storage, and transport layers at the
deployment boundary. Ownership can move: interruption, mailbox capacity,
redelivery, and idempotency are part of the contract. Singleton ownership
means one active runner, not that an external action occurs exactly once.

```ts
import { Effect, Schema } from "effect";
import { Entity, ShardingConfig } from "effect/cluster";
import { Rpc } from "effect/rpc";

const Account = Entity.make("Account", [
  Rpc.make("balance", {
    payload: { accountId: Schema.String },
    success: Schema.Number,
    error: Schema.Literal("missing"),
  }),
]);

const AccountLayer = Account.toLayer({
  balance: ({ payload }) =>
    payload.accountId === "closed"
      ? Effect.fail("missing" as const)
      : Effect.succeed(100),
});

const testCall = Effect.scoped(
  Effect.gen(function* () {
    const makeClient = yield* Entity.makeTestClient(Account, AccountLayer);
    const client = yield* makeClient("account-42");
    return yield* client.balance({ accountId: "account-42" });
  }),
).pipe(Effect.provide(ShardingConfig.layerDefaults));
```

The test client exercises handlers, not network delivery or runner failover.
For deployment, test reassignment, interruption, and persisted message
storage separately. RPC owns procedure contracts and transport serialization;
Workflow owns durable executions, while Cluster only assigns entity owners.

## Sources

- [Entity API](https://effect.website/docs/v4/api/effect/cluster/Entity)
- [Pinned Entity source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/cluster/Entity.ts)
