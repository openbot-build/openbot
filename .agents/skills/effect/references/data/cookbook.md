# Data cookbook

Verified against `effect@4.1.2`; every fence compiles. Open the section you
need; each is independent.

## Match: exhaustive branching on values

`Match.type<T>()` builds a reusable matcher, `Match.value(x)` matches one
value now. Cases run in order; finish with `Match.exhaustive` (compile error if
a case is missing), `Match.orElse(f)` (fallback) or `Match.option` /
`Match.result` (non-throwing).

```ts import.meta.vitest name="references/data/cookbook.md#1"
import { Match } from "effect"

type Shape =
  | { readonly _tag: "Circle"; readonly r: number }
  | { readonly _tag: "Rect"; readonly w: number; readonly h: number }

// By tag: forgetting "Rect" is a type error at Match.exhaustive.
export const area = Match.type<Shape>().pipe(
  Match.tag("Circle", ({ r }) => Math.PI * r * r),
  Match.tag("Rect", ({ w, h }) => w * h),
  Match.exhaustive
)

// By shape and by predicate; orElse for the rest.
export const describe = Match.type<string | number | { readonly id: string }>().pipe(
  Match.when(Match.string, (s) => `string(${s.length})`),
  Match.when((n: unknown): n is number => typeof n === "number" && n < 0, () => "negative"),
  Match.when(Match.number, (n) => `number(${n})`),
  Match.orElse((o) => `object(${o.id})`)
)

area({ _tag: "Rect", w: 2, h: 3 }) // => 6
describe("abc") // => "string(3)"
describe(-1) // => "negative"
describe(3) // => "number(3)"
describe({ id: "x" }) // => "object(x)"

// One-off value match.
export const bucket = (n: number) =>
  Match.value(n).pipe(
    Match.when((x) => x < 10, () => "small"),
    Match.when((x) => x < 100, () => "medium"),
    Match.orElse(() => "large")
  )
bucket(5) // => "small"
bucket(50) // => "medium"
bucket(500) // => "large"

// 4.1: match string/number literal unions by key (unstable API).
type Status = "draft" | "review" | "published"
export const label = Match.type<Status>().pipe(
  Match.literalsExhaustive({ draft: () => "Draft", review: () => "In review", published: () => "Live" })
)
label("review") // => "In review"
```

Prefer `Data.taggedEnum`'s `$match` or `Schema.TaggedUnion(...).match` when you
own the union; use `Match` for ad-hoc shapes and unions you did not define.

## Option and Result pipelines

```ts import.meta.vitest name="references/data/cookbook.md#2"
import { Option, Result } from "effect"

const env: { readonly [key: string]: string | undefined } = { HOST: "example.org", PORT: "8080" }

// Option.gen: sequential, short-circuits on the first None.
export const hostPort = Option.gen(function*() {
  const host = yield* Option.fromNullishOr(env.HOST)
  const port = yield* Option.fromNullishOr(env.PORT)
  return `${host}:${port}`
})

// Result.gen: same shape, but the failure carries a reason.
export const parsePair = (text: string) =>
  Result.gen(function*() {
    const [a, b] = text.split(",")
    const left = yield* Result.fromNullishOr(a, () => "missing-left" as const)
    const right = yield* Result.fromNullishOr(b, () => "missing-right" as const)
    return [left, right] as const
  })

// Turn exceptions into values at the boundary of code you do not control.
export const parseJson = (text: string) =>
  Result.try({ try: () => JSON.parse(text) as unknown, catch: () => "invalid-json" as const })

// Collapse at the edge, once.
Option.getOrElse(hostPort, () => "localhost:80") // => "example.org:8080"
Result.match(parsePair("a,b"), { onSuccess: (p) => p.join("|"), onFailure: (e) => e }) // => "a|b"
parsePair("a") // => Result.fail("missing-right")
Result.getOrElse(parseJson("{"), () => null) // => null
```

Combinators worth knowing: `Option.map/flatMap/filter/orElse/all/liftPredicate`,
`Option.getOrNull/getOrUndefined` (for interop), `Result.map/mapError/flatMap/orElse/all/merge/flip`,
`Result.isSuccess/isFailure`. Both are pipeable and data-last under `.pipe`.

## Data.Class, TaggedClass, TaggedError

```ts import.meta.vitest name="references/data/cookbook.md#3"
import { Data, Effect, Equal } from "effect"

// Plain immutable value with structural equality.
export class Point extends Data.Class<{ readonly x: number; readonly y: number }> {}

// Adds a readonly `_tag` for narrowing; use when a class is one variant.
export class Cancelled extends Data.TaggedClass("Cancelled")<{ readonly by: string }> {}

// An error usable as `E`. The default `message` is empty: override it so logs help.
export class Timeout extends Data.TaggedError("Timeout")<{ readonly ms: number }> {
  override get message() {
    return `timed out after ${this.ms}ms`
  }
}

Equal.equals(new Point({ x: 1, y: 2 }), new Point({ x: 1, y: 2 })) // => true

// Yield the error to fail; `return yield*` keeps TypeScript's control flow honest.
export const call = Effect.fn("call")(function*(ms: number) {
  if (ms > 1000) return yield* new Timeout({ ms })
  return ms
})
await Effect.runPromise(call(5000).pipe(Effect.catchTag("Timeout", (e) => Effect.succeed(e.message)))) // => "timed out after 5000ms"
await Effect.runPromise(call(5)) // => 5
```

A generic variant union: `Data.TaggedEnum.WithGenerics<n>` (see the JSDoc of
`Data.taggedEnum` for a complete `Result`-like example). `Data.taggedEnum`
constructors return plain objects and `$is(tag)` only checks `_tag`, so never
use it on untrusted input; decode with `Schema` first.

## Brand and Newtype

```ts import.meta.vitest name="references/data/cookbook.md#4"
import { Brand, Newtype, Option } from "effect"

// Brand.make: validate with a predicate; return true or an error message.
export type Percent = number & Brand.Brand<"Percent">
export const Percent = Brand.make<Percent>((n) => (n >= 0 && n <= 100) || "must be within 0..100")

Percent(50) // => 50
Percent.option(101) // => Option.none()
Percent.result(101)._tag // => "Failure"
Percent.is(5) // => true

// Brand.nominal: relabel only (ids from a trusted source).
export type OrderId = string & Brand.Brand<"OrderId">
export const OrderId = Brand.nominal<OrderId>()

// Newtype: a compile-time wrapper you unwrap explicitly with Newtype.value.
export interface Meters extends Newtype.Newtype<"Meters", number> {}
const metersIso = Newtype.makeIso<Meters>()
export const tenMeters = metersIso.set(10)
Newtype.value(tenMeters) // => 10
OrderId("o-1") // => "o-1"
```

Prefer `Brand` when you want one-line construction and the value to stay
usable as its base type (a `Percent` is still a `number`); prefer `Newtype`
when the base operations should *not* be available without unwrapping.

## Order and Equivalence

```ts import.meta.vitest name="references/data/cookbook.md#5"
import { Array as Arr, Equivalence, Order } from "effect"

interface Person { readonly name: string; readonly age: number }

const byAge = Order.mapInput(Order.Number, (p: Person) => p.age)
const byName = Order.mapInput(Order.String, (p: Person) => p.name)
// Combine: by age descending, then by name.
export const byAgeDescThenName = Order.combine(Order.flip(byAge), byName)

const people: ReadonlyArray<Person> = [
  { name: "b", age: 30 }, { name: "a", age: 30 }, { name: "c", age: 40 }
]
Arr.sort(people, byAgeDescThenName).map((p) => p.name) // => ["c", "a", "b"]

// "Same person" by name only.
export const sameName = Equivalence.mapInput(Equivalence.String, (p: Person) => p.name)
Arr.dedupeWith(people, sameName).length // => 3
```

## Array module essentials

Everything returns a new array. `head`, `last`, `get`, `findFirst` return an
`Option`; the `*Unsafe` or `NonEmpty` variants are for proven shapes.

```ts import.meta.vitest name="references/data/cookbook.md#6"
import { Array as Arr, Option, Record, Result } from "effect"

const xs = [5, 3, 8, 3, 1]

Arr.head(xs) // => Option.some(5)
Arr.last([]) // => Option.none()
Arr.get(xs, 10) // => Option.none()
Arr.dedupe(xs) // => [5, 3, 8, 1]
Arr.chunksOf(xs, 2) // => [[5, 3], [8, 3], [1]]
Arr.groupBy(["a", "bb", "cc"], (s) => String(s.length)) // => { 1: ["a"], 2: ["bb", "cc"] }

// filterMap keeps the Result successes; failVoid means "drop".
Arr.filterMap(["1", "x", "3"], (s) => {
  const n = Number(s)
  return Number.isNaN(n) ? Result.failVoid : Result.succeed(n)
}) // => [1, 3]

Arr.match(xs, { onEmpty: () => "none", onNonEmpty: (all) => `first=${all[0]}` }) // => "first=5"
Arr.zip([1, 2], ["a", "b"]) // => [[1, "a"], [2, "b"]]
Arr.reduce(xs, 0, (acc, n) => acc + n) // => 20
Arr.getSomes([Option.some(1), Option.none(), Option.some(3)]) // => [1, 3]

// Record: plain object helpers; `get` is an Option, so a missing key is not undefined.
const ages: { readonly [name: string]: number } = { ada: 36 }
Record.get(ages, "bob") // => Option.none()
Record.map(ages, (n) => n + 1) // => { ada: 37 }
```

Tip: `Arr.isReadonlyArrayNonEmpty(xs)` narrows to `NonEmptyReadonlyArray`,
which makes `Arr.headNonEmpty` total and lets functions like `Arr.max` skip the
empty case.

## HashMap, HashSet, Chunk

```ts import.meta.vitest name="references/data/cookbook.md#7"
import { Chunk, HashMap, HashSet, Option } from "effect"

// Persistent: each update returns a new map; the old one is unchanged.
const v1 = HashMap.fromIterable<string, number>([["a", 1], ["b", 2]])
const v2 = HashMap.set(v1, "c", 3)
HashMap.size(v1) // => 2
HashMap.size(v2) // => 3

// Keys compare structurally, so object keys work.
const byPoint = HashMap.make([{ x: 1, y: 2 }, "home"] as const)
HashMap.get(byPoint, { x: 1, y: 2 }) // => Option.some("home")

// Update the value at a key; an absent key is left alone.
const bumped = HashMap.modify(v2, "a", (n) => n + 1)
HashMap.get(bumped, "a") // => Option.some(2)
HashMap.get(HashMap.modify(v2, "zzz", (n) => n + 1), "zzz") // => Option.none()

const seen = HashSet.fromIterable([1, 2, 2, 3])
HashSet.size(seen) // => 3
HashSet.has(seen, 2) // => true

// Chunk: efficient immutable sequence for batch pipelines; not a general array replacement.
Chunk.toReadonlyArray(Chunk.map(Chunk.fromIterable([1, 2, 3]), (n) => n * 2)) // => [2, 4, 6]
```

Iteration order of `HashMap`/`HashSet` is not a contract: sort before
persisting or comparing as lists. For mutation confined to one function use
`HashMap.beginMutation`/`endMutation` or `HashMap.mutate`, or the
`MutableHashMap` / `MutableHashSet` modules, and do not let them escape.

## Redacted

```ts import.meta.vitest name="references/data/cookbook.md#8"
import { Redacted } from "effect"

const key = Redacted.make("sk-live-123")
String(key) // => "<redacted>"
JSON.stringify({ key }) // => '{"key":"<redacted>"}'

// Unwrap only at the call site that needs the raw value.
Redacted.value(key).length // => 11
```

Unwrap as late as possible (`Redacted.value`), never store the raw string in a
log annotation, and use `Redacted.wipeUnsafe` for long-lived buffers you can
discard. In configuration, `Config.Redacted("API_KEY")` produces one; in
schemas, `Schema.Redacted(...)` / `Schema.RedactedFromValue(...)`.

## Predicate

`Predicate.isString/isNumber/isObject/hasProperty/isTagged("Tag")` and
combinators `and/or/not/mapInput` are for narrowing `unknown` locally. For
*untrusted* data prefer a `Schema` (typed errors, nested paths, encode); a
predicate only answers yes/no.
