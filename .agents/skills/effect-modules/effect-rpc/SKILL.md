---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when defining typed remote procedures and serialization across sockets, workers, or HTTP; for resource-oriented endpoints use HTTP API.
metadata:
  github-path: skills/effect-rpc
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: b4e1ebbe08b4b465db6e017707876b67dd14155e
name: effect-rpc
---

# Effect RPC and sockets

Use this skill for effect/rpc and effect/socket. It covers Rpc, RpcGroup,
RpcSchema, RpcClient, RpcServer, RpcMiddleware, RpcSerialization,
RpcWorker, RpcMessage, RpcClientError, RpcTest, Socket, SocketServer, and the
protocol utilities around them.

## Start with a serializable protocol

Define commands, input, output, and declared errors with Schema. Keep the
protocol independent of a concrete transport. Decide whether a message is
request/response, streaming, notification, or a worker job before choosing
the client and server runtime.

```ts
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

const GetUser = Rpc.make("GetUser", {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ id: Schema.String, name: Schema.String }),
  error: Schema.Struct({ _tag: Schema.Literal("NotFound") }),
});

const Users = RpcGroup.make(GetUser);
```

The exact constructor signatures are unstable APIs; inspect the
installed declarations. The durable design is the schema contract and its
compatibility policy, not a copied helper call.

## Client/server boundary

1. Version and validate messages before business logic.
2. Keep RpcMiddleware responsible for authentication, tracing, limits, and
   error mapping.
3. Keep RpcServer handlers as Effects that use Context services.
4. Use RpcSerialization deliberately for JSON, binary, or custom codecs.
5. Scope sockets, worker ports, and reconnect loops.

For streaming RPC, specify backpressure and cancellation. A client disconnect
must interrupt the server fiber and release any stream or database resource it
owns.

## Compatibility and failure

Add fields with defaults, keep old tags readable during a migration, and
distinguish protocol decode errors from domain errors. Do not expose stack
traces or provider SDK errors through a public Rpc error schema.

## Review traps

- Using a TypeScript interface as a protocol without runtime validation.
- Retrying a non-idempotent RPC after an ambiguous disconnect.
- Letting an unbounded socket buffer hide a slow consumer.
- Reusing an HTTP client contract when the protocol has streaming or
  bidirectional semantics.
- Starting a worker or reconnect loop outside a Scope.

## References

- [Effect RPC source](https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/effect/src/rpc)
- [Rpc API](https://effect.website/docs/v4/api/effect)
- [Socket source](https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/effect/src/socket)
- [Effect Schema API](https://effect.website/docs/v4/api/effect/Schema)
