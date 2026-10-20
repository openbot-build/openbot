---
compatibility: Examples target effect@4.0.0; align @effect/* packages. Effect v3 requires migration.
description: Use when connecting Effect services and state to reactive atoms, React, Solid, or Vue with effect/reactivity and @effect/atom-* packages.
metadata:
  github-path: skills/effect-reactivity
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: 696f2930ab3f42dd38d3a62c573496da7c7d79cb
name: effect-reactivity
---

# Effect reactivity and UI state

Use effect/reactivity for Atom, AtomRef, AtomRegistry, AsyncResult,
AtomHttpApi, AtomRpc, Hydration, and the @effect/atom-react,
@effect/atom-solid, and @effect/atom-vue bindings.

## Keep Effect as the source of truth

An atom is a reactive view or trigger around an Effect computation. Keep
domain services in Context and Layer, and let the UI adapter subscribe to a
derived atom. Do not put a framework component or mutable SDK client in the
core service graph.

```ts
import { Effect } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

const userAtom = Atom.make(Effect.succeed({ id: "u1", name: "Ada" }));

const registry = AtomRegistry.make();

const value = await Effect.runPromise(
  AtomRegistry.getResult(registry, userAtom),
).finally(() => registry.dispose());
```

The v4 reactivity API is unstable. An Effect-backed atom stores an
`AsyncResult`, so use `AtomRegistry.getResult` when the successful value is
needed; `registry.get(atom)` returns the current `AsyncResult` state. Verify
Atom.make, registry construction, and the framework binding in the installed
declarations before copying the example. A directly created registry must be
disposed at teardown; use `AtomRegistry.layer` when Scope should own that
lifecycle.

## Async and hydration

Represent loading, success, and failure explicitly with AsyncResult. Hydrate
server-rendered state with a schema and version marker; do not trust a
serialized atom value merely because it came from your own page. AtomHttpApi
and AtomRpc should reuse the typed HTTP/RPC contracts rather than parse JSON
again in a component.

Define invalidation and cancellation: changing an input should interrupt the
previous request, and unmounting a view should release subscriptions. Keep
long-lived registries in a provider Layer, not in module-level state.

## Review traps

- Starting an Effect in a component render function.
- Updating an atom from a stale closure instead of using an atomic Ref or
  Effect service.
- Hydrating data without validating its version and shape.
- Leaving subscriptions or request fibers alive after unmount.
- Making UI framework types part of a shared domain package.

## References

- [Effect reactivity source](https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/effect/src/reactivity)
- [Atom API](https://effect.website/docs/v4/api/effect/reactivity/Atom)
- [AtomRegistry API](https://effect.website/docs/v4/api/effect/reactivity/AtomRegistry)
- [React bindings](https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/atom/react)
- [Solid bindings](https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/atom/solid)
- [Vue bindings](https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/atom/vue)
