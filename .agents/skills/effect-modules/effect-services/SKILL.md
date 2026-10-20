---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when injecting application capabilities, composing dependency Layers, or owning startup, shutdown, and scoped resources in Effect.
metadata:
  github-path: skills/effect-services
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: 8fcea129c37fd0fcdfe8e180de83f03318da226d
name: effect-services
---

# Effect services and resource graphs

This skill covers service-first design: Context tags define capabilities,
Layers assemble implementations, and Scope owns resources. Use it for
dependency injection, provider composition, startup/shutdown, and test
doubles.

## Version gate

Confirm whether the project uses v3 or the published `4.0.0` before
copying a Tag or Layer signature. Read the installed declarations; npm's
`latest` is v4 and upstream `main` may be newer than the pinned release.

## Design the service first

Keep a service interface small and application-shaped. A Context Service is a
typed key, not a singleton implementation. The service should expose Effects
for operations that can fail or need other services.

```ts
import { Context, Effect } from "effect";

type User = { readonly id: string; readonly name: string };

class UserRepo extends Context.Service<
  UserRepo,
  {
    readonly find: (id: string) => Effect.Effect<User, "NotFound">;
  }
>()("UserRepo") {}

const loadName = (id: string) =>
  Effect.gen(function* () {
    const repo = yield* UserRepo;
    const user = yield* repo.find(id);
    return user.name;
  });
```

Keep the repository error type visible. Do not hide a missing service with a
cast: the R parameter should tell the caller which Layer is still required.

## Build the Layer graph

1. Use Layer.succeed for a pure implementation.
2. Use Layer.effect when constructing a service needs other services.
3. Use Layer.scoped for clients, sockets, pools, and anything with a
   finalizer.
4. Compose with Layer.merge or Layer.provide; keep the graph close to the
   application composition root.
5. Build one ManagedRuntime for a long-lived process and close it at shutdown.

```ts
import { Context, Effect, Layer } from "effect";

class Config extends Context.Service<
  Config,
  {
    readonly apiUrl: string;
  }
>()("Config") {}

const configLayer = Layer.succeed(Config, { apiUrl: "https://api.example" });

const program = Effect.gen(function* () {
  const config = yield* Config;
  return config.apiUrl;
}).pipe(Effect.provide(configLayer));
```

Read Layer types as Layer<ROut, E, RIn>: what it provides, how construction
can fail, and what it still requires. A graph that is type-safe can still be
wrong if it creates a new database client per request.

## Scoped resources

Use acquireRelease or Layer.scoped for ownership. Verify that release runs on
normal completion, typed failure, and interruption. When replacing a resource
through ScopedRef or LayerRef, define whether the old value is closed before
the new one becomes visible.

## Review checklist

- Is the Tag interface independent of the concrete SDK?
- Are credentials read through Config and kept out of logs?
- Are stateful Layers memoized at the right Scope?
- Does shutdown dispose the ManagedRuntime and close pools and listeners?
- Do tests replace providers with deterministic Layers rather than monkey
  patching globals?

## Boundaries

Use Effect core for error semantics, Scope for finalizers, Config for input,
and platform-specific skills for concrete providers. Do not invent an adapter
when an @effect/platform-*, SQL, HTTP, or AI package already owns the Layer.

## References

- [Context API](https://effect.website/docs/v4/api/effect/Context)
- [Layer API](https://effect.website/docs/v4/api/effect/Layer)
- [Scope API](https://effect.website/docs/v4/api/effect/Scope)
- [ManagedRuntime API](https://effect.website/docs/v4/api/effect/ManagedRuntime)
- [Effect documentation](https://effect.website/docs)
- [Pinned Layer source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/Layer.ts)
