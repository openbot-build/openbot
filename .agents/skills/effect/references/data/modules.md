# Which module owns what (effect@4.1.2)

Import everything from `"effect"`; modules whose names clash with globals are
imported with an alias (`Array as Arr`, `Number as Num`, `Record`, `String as Str`).
Every module below was confirmed to exist in `node_modules/effect/src`.
When unsure of a signature, `grep -n "export const <name>" -A12 node_modules/effect/src/<Module>.ts`.

## Representing outcomes

| Module | Core members | Notes |
| --- | --- | --- |
| `Option` | `some none fromNullishOr fromNullOr fromUndefinedOr map flatMap filter match getOrElse getOrNull getOrUndefined getOrThrow orElse all gen liftPredicate isSome isNone` | `Option.fromNullishOr` (not `fromNullable`) |
| `Result` | `succeed fail try fromOption fromNullishOr map mapError flatMap match getOrElse getOrThrow orElse all gen isSuccess isFailure flip merge failVoid` | v3 `Either`; `Result.try({ try, catch })` |
| `Filter` | `Filter<In, Pass, Fail> = (in) => Result<Pass, Fail>`; `fromPredicate`, `toPredicate`, `compose`, `or`, `zip` | the type behind `Array.filterMap` / `partition` |
| `Effect.fromOption(opt, onNone?)`, `Effect.fromResult(res)`, `Effect.result(eff)`, `Effect.option(eff)` | bridges | `Option`/`Result` are not yieldable |

## Representing structure

| Module | Core members |
| --- | --- |
| `Data` | `Class`, `TaggedClass(tag)`, `taggedEnum<T>()` (`$match`, `$is`, one constructor per tag), `TaggedEnum`, `Error`, `TaggedError(tag)` |
| `Brand` | `Brand<"Key">`, `Branded<A, "Key">`, `nominal<A>()`, `make<A>(pred)`, `check<A>(...schemaChecks)`, `all(...ctors)`, `BrandError`; constructors expose `.option(x)`, `.result(x)`, `.is(x)` |
| `Newtype` | `Newtype<"Key", Carrier>`, `makeIso<N>()` (`.set`, `.get`), `value`, `makeEquivalence/Order/Combiner/Reducer` |
| `Redacted` | `make`, `value`, `isRedacted`, `wipeUnsafe`, `makeEquivalence` |
| `Match` | `type<T>()`, `value(v)`, `tag`, `tags`, `when`, `whenOr`, `whenAnd`, `not`, `discriminator`, `exhaustive`, `orElse`, `option`, `result`; `literals`, `literalsExhaustive` (4.1, unstable: handlers keyed by the literal); refinements `string number boolean date record instanceOf nonEmptyString defined any` |
| `Predicate` | `isString isNumber isBoolean isObject isNullish isNotNullish hasProperty isTagged and or not mapInput` (grep before using any other name) |

## Comparing and ordering

| Module | Core members |
| --- | --- |
| `Equal` | `equals(a, b)` (structural; curried form `equals(b)`), `symbol`, `byReference(obj)`, `asEquivalence()`, `makeCompareMap/Set` |
| `Hash` | `Hash.symbol`, `Hash.string`, ...; implement with `Equal.symbol` for custom keys (see `Equal` JSDoc) |
| `Equivalence` | `make`, `mapInput`, `String Number Boolean Date`, `Struct`, `Tuple`, `Record`, `combine`, `strictEqual` |
| `Order` | `Number String Boolean Date BigInt`, `make`, `mapInput`, `combine`, `combineAll`, `flip`, `Struct`, `Tuple`, `min max clamp isLessThan isGreaterThan isBetween` |
| `Ordering` | `-1 | 0 | 1` helpers |

## Collections

| Module | Use for |
| --- | --- |
| `Array` | the default; every function returns a new array; `head last get findFirst` return `Option`; `sort(order)`, `dedupe`, `groupBy`, `chunksOf`, `partition`/`filterMap` (take `Result`-returning functions), `match`, `reduce`, `zip`, `getSomes`, `separate`, `countBy` |
| `NonEmptyIterable` / `Array.NonEmptyReadonlyArray` | type-level proof of at least one element |
| `Iterable` | lazy operations over generators and sets |
| `Record` | plain-object helpers: `get` (Option), `map`, `filter`, `keys`, `values`, `fromEntries`, `toEntries`, `set`, `remove`, `union` |
| `Struct` | `pick`, `omit`, `map`, `assign`, `evolve`; also used by `Schema.mapFields` |
| `Tuple` | fixed-length helpers |
| `HashMap` / `HashSet` | persistent maps/sets keyed by structural equality; `fromIterable`, `make`, `get` (Option), `set`, `modify`, `remove`, `has`, `size`, `beginMutation/endMutation` |
| `MutableHashMap` / `MutableHashSet` / `MutableList` / `MutableRef` | local mutable state that does not escape the function |
| `Chunk` | immutable batches (what `Stream` emits); `fromIterable`, `map`, `toReadonlyArray` |
| `Trie` | prefix lookups over string keys |
| `Graph` | nodes/edges with traversal; immutable with a scoped-mutable builder |
| `TxHashMap`, `TxQueue`, `TxChunk`... | transactional (STM-style) variants, see [state](../state/guide.md) |

## Scalars and algorithms

| Module | Use for |
| --- | --- |
| `Number` | `parse` (returns `Option`), `sum`, `clamp`, `between`, `remainder` |
| `BigInt`, `BigDecimal` | exact arithmetic (money without float error); `BigDecimal.fromString` returns an `Option`; also `sum`, `subtract`, `multiply` |
| `String` | pipe-friendly string helpers (`trim`, `split`, `isNonEmpty`, case conversion) |
| `Boolean`, `Symbol`, `RegExp` | small guards and helpers (`RegExp.escape`) |
| `Reducer` / `Combiner` | declare "how to merge two A's" once; `Reducer` adds an initial value for empty input; reused by `Array`, `Record`, `Newtype` |
| `Differ` | patch/diff abstraction (`Differ<T, Patch>`) |
| `JsonPointer` / `JsonPatch` | RFC 6901 pointers and a deterministic `add`/`remove`/`replace` patch format for JSON values |

## Version notes

- `Array.partition`, `Chunk.partition`, `Effect.partition`, `Record.partition`, their
  `separate` helpers and `Option.partitionMap` return `[successes, failures]`
  in 4.0.0 stable (v3 returned `[excluded, satisfying]`); update tuple destructuring when porting.
- `Array.filterMap`, `Array.partition`, `Record.filterMap` take functions returning
  `Result` (use `Result.failVoid` for "drop"), not `Option`/boolean.
- `Equal.equals` is structural for plain objects and arrays; v3 required `Data.*`
  wrappers for that.
- `Option.fromNullable` is `Option.fromNullishOr`; `Either.*` is `Result.*`
  (`Right`/`Left` become `Success`/`Failure`, `right`/`left` become `succeed`/`fail`).

## Changed in 4.1

The data modules (`Data`, `Option`, `Result`, `Record`, `Struct`, `Predicate`) have no API changes. Small things that moved:

- `Array.unionWith` accepts two element types and returns `Array<A | B>`; `Array.match`'s `onNonEmpty` receives a mutable `NonEmptyArray` when the input is a mutable array.
- `Array.getReducerConcat` / `getReadonlyReducerConcat` now supply a `combineAll` that concatenates a whole collection of arrays in one loop.
- `Duration.fromIso` / `Duration.formatIso` / `Duration.toMicros` are new; `Match.literals` / `literalsExhaustive` are new.
