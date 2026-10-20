---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when choosing a pure representation for absence, failure values, variants, equality, or immutable collections without running an Effect.
metadata:
  github-path: skills/effect-data
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: 5976f9b1543932f3557fabd7b36f983f71eccbd1
name: effect-data
---

# Effect data and pure transformations

Use this skill for values and pure transformations, not for service
composition. It covers Option, Data, Equal, Equivalence, Order, Ordering,
Predicate, Filter, Match, Brand, Newtype, Redacted, Array, Iterable,
NonEmptyIterable, Chunk, HashMap, HashSet, mutable collections, Record,
Struct, Tuple, String, Number, BigInt, BigDecimal, Boolean, RegExp, Symbol,
Trie, Graph, Reducer, Differ, Combiner, and JSON pointer/patch helpers.

## Choose the representation

- Option means absence is expected; Result means a value-level operation
  failed; Effect means the operation has execution, resources, or services.
- Data and Equal define structural equality; Brand and Newtype add domain
  distinctions without changing runtime representation.
- HashMap and HashSet are immutable; use mutable variants only at an explicit
  local boundary.
- NonEmptyIterable and tuple types preserve invariants that an Array cannot.
- Match is useful for exhaustive tagged values; do not replace it with a
  chain of unchecked casts.

## Make absence and variants explicit

```ts
import { Number as EffectNumber, Option, Result } from "effect";

declare const maybeUser: { readonly name: string } | null | undefined;
declare const text: string;

const label = Option.fromNullishOr(maybeUser).pipe(
  Option.map((user) => user.name),
  Option.getOrElse(() => "anonymous"),
);

const parsed = Result.fromOption(
  EffectNumber.parse(text),
  () => "invalid-number" as const,
);
```

Convert null and undefined once at the boundary with `fromNullishOr`. Never read a value from an
Option or Result before matching it. Native `Number.parseInt` returns `NaN` when
there is no numeric prefix, accepts partial numeric prefixes, and does not
throw, so it is not a validation boundary for `Result.try`; use `Number.parse`
when invalid numeric text should be explicit.

## Pure collection review

Prefer pipe-friendly, data-last combinators and avoid accidental mutation.
Check whether an operation preserves ordering, allocates a new collection,
requires a non-empty input, or changes equality semantics. Use Chunk when a
pipeline needs efficient immutable batches; use Stream when values are
incremental or unbounded.

Brands and refinements should be created at the boundary that proves them.
Keep the constructor private to a module when an invariant must not be forged
by callers.

In stable 4.0.0, `Array.partition`, `Chunk.partition`, `Effect.partition`,
`Record.partition`, their `separate` helpers, and `Option.partitionMap` return
`[successes, failures]`. When porting rc.118 code, update tuple destructuring
before applying either result.

## Common mistakes

- Using Option as a catch-all error channel.
- Mutating an object stored inside a Ref or HashMap.
- Comparing records with JavaScript identity when structural equality is
  required.
- Treating a hash collection's iteration order as a persistence contract.
- Making a Brand that has no runtime validation or documented proof.

## References

- [Option API](https://effect.website/docs/v4/api/effect/Option)
- [Data API](https://effect.website/docs/v4/api/effect/Data)
- [HashMap API](https://effect.website/docs/v4/api/effect/HashMap)
- [Match API](https://effect.website/docs/v4/api/effect/Match)
- [Effect documentation](https://effect.website/docs)
- [Pinned Option source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/Option.ts)
