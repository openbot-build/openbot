---
compatibility: Examples target effect@4.0.0; align @effect/* packages. Effect v3 requires migration.
description: Use when choosing a Node, Bun, Deno, or browser adapter for filesystem, process, network, worker, or runtime lifecycle services.
metadata:
  github-path: skills/effect-platform
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: 885d18cc8826768a2ecc3f946e543881ec6d5577
name: effect-platform
---

# Effect platform integration

Use this skill when application code needs a runtime adapter. It covers
@effect/platform-browser, @effect/platform-bun, @effect/platform-deno,
@effect/platform-node-shared, @effect/platform-node, plus FileSystem, Path,
PlatformError, Stdio, Terminal, process, net, socket, and workers modules.

## Choose the runtime package first

Inspect the project's runtime and lockfile before choosing a package:

- Browser applications normally use platform-browser and Fetch-backed
  services.
- Node applications use platform-node and, where appropriate,
  platform-node-shared.
- Bun and Deno need their own adapters; do not import Node implementations
  just because the TypeScript types happen to line up.

Keep domain code dependent on Context services. Install a runtime-specific
Layer at the composition root.

```ts
import { Effect } from "effect";
import { NodeRuntime, NodeServices } from "@effect/platform-node";

const program = Effect.logInfo("service started").pipe(
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program);
```

Verify the exact exported Layer for the package version before using this
shape. The point is to let the platform own process signals, filesystem
resources, and shutdown instead of sprinkling Node globals through a domain
module.

## Files, processes, and sockets

Use FileSystem and Path services for file access, and classify failures with
PlatformError. Use ChildProcess through the process skill boundary and Socket
or HTTP services for network I/O. All listeners, file handles, subprocesses,
and worker ports must be scoped and closed on interruption.

Workers are a message boundary: define a serializable protocol with Schema,
bound the queue, and make worker termination observable. Do not pass a live
Effect service graph across a worker boundary.

## Review checklist

- Is the selected adapter compatible with the deployed runtime and bundler?
- Are filesystem paths and permissions tested on the target OS?
- Are signals and exit codes handled by the runtime entry point?
- Does a failed startup close partially acquired resources?
- Are platform errors mapped to domain errors at one boundary?

## References

- [Effect platform packages](https://effect.website/docs/v4/api)
- [@effect/platform-node](https://effect.website/docs/v4/api/platform-node)
- [@effect/platform-browser](https://effect.website/docs/v4/api/platform-browser)
- [FileSystem API](https://effect.website/docs/v4/api/effect/FileSystem)
- [Effect platform source](https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/platform)
