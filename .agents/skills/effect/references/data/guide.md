# Effect data and pure transformations

## How to think about it

Most bugs in "plain" TypeScript come from facts the types do not state:
this might be missing, this parse might fail, this switch forgot a case, these
two objects are "the same" but `===` says no, these two strings are both ids but
not interchangeable. Effect's data modules turn each of those facts into a
value or a type that the compiler checks, *without* needing an `Effect`.

Pick the **smallest** container that states the fact:

- the value may legitimately not exist -> `Option<A>`
- a pure, synchronous operation can fail with a reason -> `Result<A, E>`
- it needs I/O, services, time, concurrency or cleanup -> `Effect<A, E, R>`

All three are values you `map`, `flatMap`, `match` and `gen` over. They convert
into each other at the edges (`Result.fromOption`, `Effect.fromOption`,
`Effect.fromResult`, `Effect.result`); an `Option` or `Result` is **not**
yieldable in `Effect.gen` in v4, convert it explicitly.

Equality is the second idea. In v4 `Equal.equals` is *structural* for
primitives, arrays, plain objects, `Map`/`Set`, `Date`, and for `Data` and
`Schema` classes, and `HashMap`/`HashSet` use it for keys. Do not reach for
`JSON.stringify` or a hand-written `deepEqual`; if you want identity back, say
so with `Equal.byReference`. Coming from lodash/immutable.js/fp-ts: collections
are persistent (`HashMap.set` returns a new map), `pipe` is data-last, and
v3 `Either` is `Result` with `succeed`/`fail` (not `right`/`left`).

## Choose

| You need | Use | Why / when not |
| --- | --- | --- |
| "might be missing" | `Option`; convert at the edge with `Option.fromNullishOr` | not an error channel: if the caller needs to know *why*, use `Result`/`Effect` |
| sync parse/validate with a reason | `Result<A, E>` (`Result.try`, `Result.fromOption`) | no I/O; once it needs a service, make it an `Effect` |
| async, services, retry, resources | `Effect` | see [core](../core/guide.md) |
| internal value with structural `===` | `Data.Class` / `Data.TaggedClass` | if it is ever decoded/encoded, use `Schema.Class` |
| closed set of internal variants | `Data.TaggedEnum` (`$match`, `$is`) | serialised or untrusted variants: `Schema.TaggedUnion` |
| exhaustive branching on any shape | `Match.type<T>().pipe(Match.tag(...), Match.exhaustive)` | one-off `if` on a boolean needs no Match |
| error type for `Effect` `E` | `Data.TaggedError("Tag")<{...}>` | crosses RPC/HTTP: `Schema.TaggedError` |
| distinct ids/units, no check | `Brand.nominal<A>()` | claims nothing about validity |
| distinct ids/units, with proof | `Brand.make<A>(pred)` / `Brand.check<A>(...schemaChecks)` | or `Schema....pipe(Schema.brand)` at a boundary |
| ordering / sorting | `Order.mapInput`, `Order.combine`, `Arr.sort` | do not mutate with `.sort` |
| custom "same" notion | `Equivalence.mapInput(Equivalence.String, f)` | `Equal` for the default structural notion |
| secrets | `Redacted.make(x)` / `Redacted.value(r)` | prints as `<redacted>` in logs and `String()` |
| default collection | `ReadonlyArray` + `Array` module | `Chunk` only for batch pipelines, `Stream` for unbounded |
| keyed lookup by structural key | `HashMap` / `HashSet` | plain `Record<string, A>` when keys are strings and small |
| at least one element | `NonEmptyReadonlyArray` (`Arr.isReadonlyArrayNonEmpty`) | makes `head` total |

## Recipe

The pitfall first: every line below hides a fact the type system could carry.

```ts skip
function checkout(lines: Line[] | null, discount: string, qty: string) {
  const n = parseInt(qty)                       // NaN on "abc", 12 on "12abc"
  const first = lines && lines[0]               // undefined vs null vs missing, all conflated
  if (lines?.includes({ sku: "ABC-1" } as any)) // reference equality: never true
  switch (discount) { case "pct": return 1 }    // no default, no exhaustiveness
  return lines!.sort((a, b) => a.total - b.total) // mutates the caller's array
}
```

The idiom: a small checkout domain where each decision is a type.

```ts import.meta.vitest name="references/data/guide.md#2"
import { Array as Arr, Brand, Data, Effect, Equal, HashMap, Number as Num, Option, Order, Result } from "effect"

// Brand with proof: the only way to get a Sku is through a check that ran.
export type Sku = string & Brand.Brand<"Sku">
export const Sku = Brand.make<Sku>((s) => /^[A-Z]{3}-\d+$/.test(s) || "expected a SKU like ABC-123")

// Data.Class: immutable, structural equality, methods. No schema needed
// because it is never decoded from the outside.
export class Line extends Data.Class<{
  readonly sku: Sku
  readonly qty: number
  readonly unitMinor: number
}> {
  get totalMinor() {
    return this.qty * this.unitMinor
  }
}

// Closed variants: adding one makes every $match below stop compiling.
export type Discount = Data.TaggedEnum<{
  NoDiscount: {}
  Percent: { readonly pct: number }
  Flat: { readonly minor: number }
}>
export const Discount = Data.taggedEnum<Discount>()

export const applyDiscount = (discount: Discount, subtotal: number): number =>
  Discount.$match(discount, {
    NoDiscount: () => subtotal,
    Percent: ({ pct }) => Math.round(subtotal * (100 - pct) / 100),
    Flat: ({ minor }) => Math.max(0, subtotal - minor)
  })

// Result: a pure parse whose failure is a *reason* the caller can branch on.
// Number.parse returns an Option (no NaN, no partial "12abc" prefixes).
export const parseQty = (text: string): Result.Result<number, "NotANumber" | "NotPositive"> =>
  Result.fromOption(Num.parse(text), () => "NotANumber" as const).pipe(
    Result.flatMap((n) => Number.isInteger(n) && n > 0 ? Result.succeed(n) : Result.fail("NotPositive" as const))
  )

// Option: "no such line" is an ordinary outcome, not a failure.
export const findLine = (lines: ReadonlyArray<Line>, sku: Sku): Option.Option<Line> =>
  Arr.findFirst(lines, (line) => line.sku === sku)

// Order: composable, non-mutating (Arr.sort returns a new array).
const byTotalDesc = Order.flip(Order.mapInput(Order.Number, (line: Line) => line.totalMinor))
export const biggestFirst = (lines: ReadonlyArray<Line>) => Arr.sort(lines, byTotalDesc)

// Errors for the Effect world are Data.TaggedError: yieldable, catchTag-able.
export class InvalidInput extends Data.TaggedError("InvalidInput")<{ readonly reason: string }> {}
export class UnknownSku extends Data.TaggedError("UnknownSku")<{ readonly sku: Sku }> {}

// The edge: Result/Option become Effect failures *here*, with domain errors.
export const quote = Effect.fn("quote")(function*(
  lines: ReadonlyArray<Line>,
  skuText: string,
  qtyText: string,
  discount: Discount
) {
  const sku = yield* Effect.fromResult(Sku.result(skuText)).pipe(
    Effect.mapError((error) => new InvalidInput({ reason: error.message }))
  )
  const qty = yield* Effect.fromResult(parseQty(qtyText)).pipe(
    Effect.mapError((reason) => new InvalidInput({ reason }))
  )
  const line = yield* Effect.fromOption(findLine(lines, sku), () => new UnknownSku({ sku }))
  return applyDiscount(discount, line.unitMinor * qty)
})

// --- run it -------------------------------------------------------------
const abc = Sku("ABC-1")
const lines = [new Line({ sku: abc, qty: 1, unitMinor: 500 }), new Line({ sku: Sku("XYZ-9"), qty: 3, unitMinor: 900 })]

// Sorting returns a new array; `lines` is untouched.
biggestFirst(lines).map((l) => l.sku) // => ["XYZ-9", "ABC-1"]

// Equality is structural, for classes and plain data alike.
Equal.equals(lines[0], new Line({ sku: abc, qty: 1, unitMinor: 500 })) // => true
Equal.equals({ a: [1, 2] }, { a: [1, 2] }) // => true
Option.getOrElse(Option.map(findLine(lines, abc), (l) => l.qty), () => 0) // => 1
parseQty("12abc") // => Result.fail("NotANumber")
parseQty("0") // => Result.fail("NotPositive")

// HashMap: persistent, structural keys, `get` returns an Option.
const bySku = HashMap.fromIterable(lines.map((line) => [line.sku, line] as const))
Option.isSome(HashMap.get(bySku, abc)) // => true
HashMap.size(HashMap.remove(bySku, abc)) // => 1

const run = (skuText: string, qtyText: string) =>
  Effect.runPromise(
    quote(lines, skuText, qtyText, Discount.Percent({ pct: 10 })).pipe(
      Effect.catchTag("UnknownSku", () => Effect.succeed(-1)),
      Effect.catchTag("InvalidInput", () => Effect.succeed(0))
    )
  )

await run("XYZ-9", "2") // => 1620
await run("QQQ-1", "2") // => -1
await run("nope", "2") // => 0
await run("XYZ-9", "-3") // => 0
```

Things worth noticing: nothing above throws; each function's return type
states what can go wrong; `Option`, `Result` and `Effect` meet only in `quote`;
`Discount` and `Line` need no schema because the compiler already knows them.
Add a fourth `Discount` and `applyDiscount` fails to compile.

For `Match` (value-level exhaustive matching), `Option.gen`/`Result.gen`,
`Array` partition/group/dedupe, `Redacted`, `Newtype`, and `Record`/`Struct`
helpers see [references/cookbook.md](cookbook.md); the verified
module map is in [references/modules.md](modules.md).

## Anti-patterns

1. **`Option` as a general error channel.** `findUser(): Option<User>` cannot
   say "database down" versus "no such user", so callers treat both as absent.
   ```ts skip
   const findUser = (id: string): Option.Option<User> => /* swallows errors */
   ```
   Return `Effect<User, UserNotFound | DbError>`, or `Effect<Option<User>, DbError>` when absence is normal.
2. **Reading a value before matching.** `option.value` does not exist on
   `None`; casting around it moves the crash to runtime. Use `Option.match`,
   `Option.getOrElse`, or `Option.map` chains, and `Option.getOrThrow` only in tests.
3. **`===` or `JSON.stringify` for equality.** Two `Data.Class` instances are
   different objects; `===` says false. Use `Equal.equals(a, b)` (structural),
   or `Equivalence.mapInput` for a domain-specific notion such as "same sku".
4. **`parseInt` / `Number()` as validation.** `parseInt("12abc")` is `12`,
   `parseInt("abc")` is `NaN`, `Number("")` is `0`.
   ```ts skip
   const qty = parseInt(text)
   ```
   ```ts
   import { Number as Num, Option } from "effect"
   export const qty = (text: string) => Option.getOrElse(Num.parse(text), () => 0)
   ```
5. **Yielding `Option` or `Result` in `Effect.gen`.** They are not yieldable in
   v4; it fails at runtime ("Not a valid effect") and the TypeScript error is
   hard to read.
   ```ts skip
   const user = yield* Option.fromNullishOr(maybeUser)
   ```
   Use `yield* Effect.fromOption(opt, () => new Missing())` or `Effect.fromResult(res)`.
6. **Boolean predicate with `Array.partition` / `filterMap`.** In v4 they take
   a function returning `Result`, not a boolean/`Option`; a boolean silently
   yields garbage tuples at runtime.
   ```ts
   import { Array as Arr, Result } from "effect"
   // [passes, fails]
   export const [evens, odds] = Arr.partition([1, 2, 3, 4], (n) =>
     n % 2 === 0 ? Result.succeed(n) : Result.fail(n))
   ```
   Use `Arr.filter(xs, pred)` when you only keep matches.
7. **Mutating collections or the objects inside them.** `xs.sort(...)`,
   `map.get(k).count++`, or editing an object stored in a `Ref`/`HashMap`
   changes shared state invisibly and breaks cached hashes. Use `Arr.sort`,
   `HashMap.set`/`modify`, and construct a new `Data.Class` value.
8. **A `Brand` that proves nothing.** `Brand.nominal` just relabels; calling
   the result "validated" invites invalid data into code that trusts the brand.
   Use `Brand.make`/`Brand.check` (or `Schema.brand` after checks) and keep
   the constructor as the only way to build the value.

## Testing it

Everything here is pure: no `TestClock`, no layers. Assert on values with
`node:assert` and `Equal.equals` (a `deepStrictEqual` on class instances
compares prototypes and own properties and works too, but `Equal` states the
intent). This compiles and runs standalone:

```ts import.meta.vitest name="references/data/guide.md#3"
import assert from "node:assert/strict"
import { Equal, Option, Order, Result, Array as Arr, Number as Num } from "effect"

const parse = (text: string) =>
  Result.fromOption(Num.parse(text), () => "NotANumber" as const)

// Result and Option are plain data: assert on the tag and payload.
assert.ok(Result.isSuccess(parse("12")))
assert.deepStrictEqual(Result.getOrElse(parse("12abc"), () => -1), -1)
assert.ok(Option.isNone(Arr.head([])))

// Ordering laws are testable without any harness.
const byLen = Order.mapInput(Order.Number, (s: string) => s.length)
assert.deepStrictEqual(Arr.sort(["ccc", "a", "bb"], byLen), ["a", "bb", "ccc"])

// Structural equality: this is what makes "same value" assertions trivial.
assert.ok(Equal.equals({ id: 1, tags: ["x"] }, { id: 1, tags: ["x"] }))
```

For property tests (laws like "sort is idempotent") use `@effect/vitest`
(not installed in this repository; shape taken from the upstream ai-docs):

```ts skip
import { assert, it } from "@effect/vitest"
import { Array as Arr, Effect, Order, Schema } from "effect"

it.effect.prop("sorting twice equals sorting once", [Schema.Array(Schema.Int)], ([xs]) =>
  Effect.gen(function*() {
    const once = Arr.sort(xs, Order.Number)
    assert.deepStrictEqual(Arr.sort(once, Order.Number), once)
  }))
```

## Boundaries

- [schema](../schema/guide.md): use it as soon as data crosses a boundary or must be
  encoded. `Schema.Class`/`TaggedUnion`/`TaggedError` are the decoded
  counterparts of `Data.Class`/`TaggedEnum`/`TaggedError`; `Schema.brand`
  corresponds to `Brand`.
- [core](../core/guide.md): how `Result`/`Option` convert to `Effect`, how `E` is
  designed, `catchTag`, `orDie`.
- [state](../state/guide.md): `Ref`/`SynchronizedRef` hold these immutable values; replace
  the value, never mutate inside.
- [streams](../streams/guide.md): `Chunk` is the batch type under `Stream`; use `Stream`
  for incremental or unbounded data.
- [config](../config/guide.md): `Redacted` values come out of `Config.Redacted`.
- [testing](../testing/guide.md): running `Effect` tests, test layers and `TestClock`.

## References

- [references/cookbook.md](cookbook.md): Match, gen, collections, Redacted, Newtype
- [references/modules.md](modules.md): which module owns what, with verified key signatures
- [Option API](https://effect.website/docs/v4/api/effect/Option)
- [Result API](https://effect.website/docs/v4/api/effect/Result)
- [Data API](https://effect.website/docs/v4/api/effect/Data)
- [Match API](https://effect.website/docs/v4/api/effect/Match)
- [Brand API](https://effect.website/docs/v4/api/effect/Brand)
- [HashMap API](https://effect.website/docs/v4/api/effect/HashMap)
- [Pinned Data source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Data.ts)
- [Pinned Option source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Option.ts)
