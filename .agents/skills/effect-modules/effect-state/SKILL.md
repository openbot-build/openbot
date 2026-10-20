---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when selecting atomic in-process state, effectful updates, subscriptions, or replaceable scoped state for concurrent Effect programs.
metadata:
  github-path: skills/effect-state
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: 07212cb46d594ab0d410eb6145e6dd2263c6217a
name: effect-state
---

# Effect state and atomic updates

Use Ref for shared state in an Effect program. Use synchronized and
subscription variants when updates are effectful or consumers need change
notifications. This skill also covers MutableRef, RcRef/RcMap, mutable hash
collections, and the v4 transactional TxChunk, TxRef, TxQueue, and related
modules.

## Pick the smallest state primitive

- Ref is the default for atomic pure transitions.
- SynchronizedRef serializes transitions that themselves run Effects.
- SubscriptionRef keeps a current value and exposes changes as a Stream.
- ScopedRef owns a replaceable resource and finalizes old values.
- MutableRef and mutable collections belong at a controlled synchronous
  boundary; they do not automatically provide fiber-level atomicity.
- Tx modules are specialized v4 additions. Use them only when transaction
  semantics are a hard requirement, lock the Effect version, and verify the
  installed declarations before depending on them.

## Keep invariants in one atomic transition

```ts
import { Effect, Ref } from "effect";

const program = Effect.gen(function* () {
  const balance = yield* Ref.make(100);
  const withdraw = (amount: number) =>
    Ref.modify(
      balance,
      (current): readonly [{ readonly ok: boolean }, number] =>
        current >= amount
          ? [{ ok: true as const }, current - amount]
          : [{ ok: false as const }, current],
    );

  const result = yield* withdraw(30);
  return { result, remaining: yield* Ref.get(balance) };
});
```

Do not implement read-then-write as two separate Effects when another fiber
could interleave between them. Ref.modify should return both the decision and
the next state in one atomic operation.

## Reactive state

Use SubscriptionRef when a UI, cache invalidator, or observer needs both the
latest value and a stream of updates. Define whether duplicate values should
be emitted and what happens when a subscriber is slow. For a replaceable
resource, keep the ScopedRef in the same Scope as the resource owner.

## Review checklist

- Is the state owned by a Layer or Scope rather than a process-global variable?
- Is every invariant updated atomically?
- Is the value immutable at the boundary, or can callers mutate it behind the
  Ref?
- Are snapshots and updates tested under concurrent fibers?
- Does shutdown interrupt subscribers and release replaceable resources?

## Common mistakes

- Using a mutable JavaScript object inside a Ref and mutating it in place.
- Assuming Ref serializes an effectful transition; use SynchronizedRef when it
  must suspend.
- Broadcasting every internal state change when subscribers only need a
  debounced or derived view.
- Choosing a Tx module for ordinary state and locking the application to a
  newly added API without a version policy.

## References

- [Ref API](https://effect.website/docs/v4/api/effect/Ref)
- [SynchronizedRef API](https://effect.website/docs/v4/api/effect/SynchronizedRef)
- [SubscriptionRef API](https://effect.website/docs/v4/api/effect/SubscriptionRef)
- [ScopedRef API](https://effect.website/docs/v4/api/effect/ScopedRef)
- [Effect documentation](https://effect.website/docs)
- [Pinned Ref source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/Ref.ts)
