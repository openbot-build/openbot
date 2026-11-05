# Effect Schema

## How to think about it

TypeScript types vanish at runtime, so every value that crosses a boundary
(`JSON.parse`, `req.body`, `process.env`, a DB row, an LLM answer) is
`unknown` no matter what an `as` cast claims. A `Schema` is a *runtime value
that carries the type*: one definition gives you the validator, the TypeScript
type (`typeof Schema.Type`), the reverse encoder, a JSON Schema, an Arbitrary
for tests and an equivalence. You never write the interface and the validator
twice.

A schema has two sides. **`Type`** is what your program works with (a `Date`,
a branded `UserId`, an `Option`). **`Encoded`** is the wire form (an ISO string,
a plain string, `null`). *Decoding* goes Encoded -> Type, *encoding* goes
Type -> Encoded, and both are checked. Most schemas have `Type === Encoded`
(`Schema.String`); the interesting ones (`Schema.DateFromString`,
`Schema.OptionFromNullOr(Schema.Number)`) differ, and that is how you keep wire
quirks out of domain code. Two tools do the work: **checks** (`.check(...)`)
narrow a value without changing its representation, **transformations**
(`Schema.decodeTo`) change representation and must say how to go back.

Failures are data. Decoding returns an `Effect` whose error is `SchemaError`
carrying a structured `issue` (path + reason); nothing throws. Decode *once*,
at the edge, and pass the decoded type inward. Coming from Zod/io-ts/Joi: there
is no `.parse` that throws in Effect code; unknown keys are *stripped* by
default; `Schema.Number` accepts `NaN`; nothing is coerced (`"1"` is not a
number unless you pick `NumberFromString`/`FiniteFromString`); and the
`Schema` is also the thing you derive classes, errors and unions from.

## Choose

| Situation | Use | Why |
| --- | --- | --- |
| Untrusted `unknown` inside Effect code | `Schema.decodeUnknownEffect(S)` | `SchemaError` stays in `E`; build the decoder once at module level |
| Input already typed as `S["Encoded"]` | `Schema.decodeEffect(S)` | compiler checks the input shape too |
| Value -> wire (response, DB, queue) | `Schema.encodeEffect(S)` | the reverse of decode, also checked |
| Sync edge with no Effect (test, script) | `decodeUnknownSync` (throws) / `decodeUnknownResult` / `decodeUnknownOption` | only if `S["DecodingServices"]` is `never` |
| Narrow a value, same representation | `S.check(Schema.isMinLength(3), Schema.isPattern(re))` | cheap, composable, no inverse needed |
| Different wire and domain shape | `Schema.decodeTo(To, { decode, encode })` or a ready-made `*From*` schema | both directions are explicit |
| Distinct ids / units of the same primitive | `S.pipe(Schema.brand("UserId"))` | type-only brand, no runtime cost |
| Domain entity with behaviour | `Schema.Class<Self>("pkg/Name")({...})` | validated constructor, methods, `instanceof`, structural `Equal` |
| Closed set of variants | `Schema.TaggedUnion({ A: {...}, B: {...} })` | `match`, `guards`, `cases` for free |
| Expected failure of an operation | `Schema.TaggedError<Self>()("Tag", fields)` | yieldable, `catchTag`-able, serialisable over RPC/HTTP |
| Optional field | `optionalKey` (key may be absent) / `optional` (absent or `undefined`) | pick the one your wire format really has |
| Default when missing | `withDecodingDefaultKey(Effect.succeed(x))` (decode) / `withConstructorDefault(...)` (`make`) | defaults are Effects in v4 |
| Recursive data | `Schema.suspend(() => S)` + explicit `Schema.Codec<T>` annotation | TypeScript cannot infer cycles |
| Secret fields | `Schema.Redacted(...)` / `Schema.RedactedFromValue(...)` | never printed by logs or error messages |
| Tool needs a JSON Schema | `Schema.toJsonSchemaDocument(S)` | check the result for transformations that do not map |

Do **not** use Schema for: validating internal values you constructed
yourself (types already prove them), configuration ([config](../config/guide.md) builds on
Schema but owns the provider story), or side-effecting/asynchronous
validation inside a check (a check must be pure; use a service call after
decoding, or an effectful transformation that declares its requirement).

## Recipe

### The pitfall: types without proof

```ts skip
interface Product { id: string; name: string; price: number; addedAt: Date }

const parseProduct = (body: string): Product => {
  const raw = JSON.parse(body) as Product // a lie: addedAt is a string, price may be "12"
  if (!raw.name) throw new Error("bad") // loses which field, throws instead of typing the failure
  return raw
}
```

### The idiom: one schema, a typed boundary

```ts import.meta.vitest name="references/schema/guide.md#2"
import { Effect, Schema, SchemaIssue } from "effect"

// Brand: a ProductId is not "any string". The brand is type-only; the
// check before it is what actually runs.
export const ProductId = Schema.String.check(Schema.isMinLength(3)).pipe(
  Schema.brand("ProductId")
)
export type ProductId = typeof ProductId.Type

// Checks narrow; they do not change the shape. Schema.Int / Finite exist
// because Schema.Number happily accepts NaN and Infinity.
export const Money = Schema.Struct({
  minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  currency: Schema.Literals(["EUR", "USD"])
})

// A Class is a Struct plus a validated constructor and methods. The string is
// a stable identifier used in messages and the AST.
export class Product extends Schema.Class<Product>("catalog/Product")({
  id: ProductId,
  // Trim is a transformation (decode trims), then the check runs on the result.
  name: Schema.Trim.check(Schema.isNonEmpty()),
  price: Money,
  // Missing key on the wire -> []. Encoded side stays optional.
  tags: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  // Wire form is an ISO string, domain form is a Date.
  addedAt: Schema.DateFromString,
  // Key may be absent in the JSON and in the domain value.
  discontinued: Schema.optionalKey(Schema.Boolean)
}) {
  get label() {
    return `${this.name} (${(this.price.minor / 100).toFixed(2)} ${this.price.currency})`
  }
}

// Expected failure of *this* boundary, with data the caller can render.
// Schema.TaggedError makes it yieldable and serialisable.
export class InvalidPayload extends Schema.TaggedError<InvalidPayload>()("InvalidPayload", {
  problems: Schema.Array(Schema.String)
}) {}

// Build codecs once, at module level, not per request.
const decodeProduct = Schema.decodeUnknownEffect(Product)
const encodeProduct = Schema.encodeEffect(Product)
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

// SchemaError -> InvalidPayload. Keep the structured path ("price.minor")
// until here; only the edge decides how it is shown to a client.
export const parseProduct = Effect.fn("parseProduct")(function*(raw: unknown) {
  return yield* decodeProduct(raw, { errors: "all" }).pipe(
    Effect.mapError((error) =>
      new InvalidPayload({
        problems: formatIssues(error.issue).issues.map(
          (issue) => `${(issue.path ?? []).map(String).join(".")}: ${issue.message}`
        )
      })
    )
  )
})

// Type: (raw: unknown) => Effect<Product, InvalidPayload>
export const serializeProduct = Effect.fn("serializeProduct")(function*(product: Product) {
  const wire = yield* encodeProduct(product).pipe(Effect.orDie) // our own value: failing is a bug
  return JSON.stringify(wire)
})

const product = await Effect.runPromise(parseProduct({
  id: "sku-1",
  name: "  Kettle ",
  price: { minor: 4999, currency: "EUR" },
  addedAt: "2025-01-31T10:00:00.000Z"
}))

// Trim ran, the missing `tags` key defaulted, the string became a Date.
product.label // => "Kettle (49.99 EUR)"
product.tags // => []
product.addedAt.getUTCFullYear() // => 2025

// Encoding is the reverse trip: Date -> ISO string, same checks.
const wire = JSON.parse(await Effect.runPromise(serializeProduct(product)))
wire.addedAt // => "2025-01-31T10:00:00.000Z"
wire.name // => "Kettle"

// Bad input becomes a *typed* failure (InvalidPayload), one problem per path.
const rejected = await Effect.runPromise(
  Effect.flip(parseProduct({ id: "x", name: " ", price: { minor: 1.5, currency: "GBP" }, addedAt: "soon" }))
)
rejected._tag // => "InvalidPayload"
rejected.problems.map((p) => p.split(":")[0]).sort() // => ["addedAt", "id", "name", "price.currency", "price.minor"]
```

What to notice: the interface, validator, constructor, encoder and JSON
Schema all come from `Product`; failures carry paths; `errors: "all"` reports
every problem instead of the first; `encode` runs the same checks backwards,
so a bug that builds an invalid `Product` fails loudly instead of leaking.

### Variants and typed errors

```ts import.meta.vitest name="references/schema/guide.md#3"
import { Effect, Schema } from "effect"

// TaggedUnion builds the members, the union, `cases`, `guards` and `match`.
// Each member gets a `_tag` literal field automatically.
export const Event = Schema.TaggedUnion({
  Created: { id: Schema.String, at: Schema.DateFromString },
  Renamed: { id: Schema.String, name: Schema.NonEmptyString },
  Deleted: { id: Schema.String }
})
export type Event = typeof Event.Type

// `match` is exhaustive: add a case to the union and every match stops compiling.
export const describe = Event.match({
  Created: (e) => `created ${e.id} at ${e.at.toISOString()}`,
  Renamed: (e) => `renamed ${e.id} to ${e.name}`,
  Deleted: (e) => `deleted ${e.id}`
})

// Construct a member through its schema so checks run; or build the literal.
const created = Event.cases.Created.make({ id: "p1", at: new Date(0) })

export class EventRejected extends Schema.TaggedError<EventRejected>()("EventRejected", {
  reason: Schema.String
}) {
  // Optional: a readable message for logs (the default is empty).
  override get message() {
    return this.reason
  }
}

export const handle = Effect.fn("handle")(function*(raw: unknown) {
  // The union picks the member by `_tag`; the error says which tags were expected.
  const event = yield* Schema.decodeUnknownEffect(Event)(raw).pipe(
    Effect.mapError((error) => new EventRejected({ reason: error.message }))
  )
  if (Event.guards.Deleted(event)) {
    return yield* new EventRejected({ reason: "deleted ids are immutable" })
  }
  return describe(event)
})

await Effect.runPromise(handle({ _tag: "Renamed", id: "p1", name: "Kettle" })) // => "renamed p1 to Kettle"

// The error says why; catchTag narrows it.
await Effect.runPromise(handle({ _tag: "Deleted", id: "p1" }).pipe(
  Effect.catchTag("EventRejected", (e) => Effect.succeed(e.reason))
)) // => "deleted ids are immutable"

describe(created) // => "created p1 at 1970-01-01T00:00:00.000Z"
Event.guards.Created(created) // => true
```

Longer material: two-way transformations, effectful decoding that needs a
service, `encodeKeys` for snake_case, picking/omitting/extending fields, and
`toCodecJson` are in [references/transformations.md](transformations.md).
Verified signatures for every API used above are in
[references/api-cheatsheet.md](api-cheatsheet.md).

## Anti-patterns

Wrong code is `ts skip`; the fix is in the next block.

1. **Casting or `JSON.parse(x) as T`.** A cast proves nothing; the first bad
   payload crashes deep inside the domain.
   ```ts skip
   const user = JSON.parse(text) as User
   ```
   ```ts
   import { Schema } from "effect"
   const User = Schema.Struct({ name: Schema.String })
   export const parseUser = Schema.decodeUnknownEffect(Schema.fromJsonString(User))
   ```
2. **`Schema.NumberFromString` for untrusted numbers.** `"abc"` decodes to
   `NaN` and `""` to `0`, and both flow on into arithmetic as if valid.
   ```ts skip
   const Port = Schema.NumberFromString
   ```
   ```ts
   import { Schema } from "effect"
   // Reject blanks first, then non-finite, then out-of-range.
   export const Port = Schema.NonEmptyString.pipe(
     Schema.decodeTo(Schema.FiniteFromString.check(Schema.isBetween({ minimum: 1, maximum: 65535 })))
   )
   ```
3. **Hand-writing the interface next to the schema** (`interface User {...}`
   plus `Schema.Struct({...})`): two sources of truth drift apart silently.
   Derive instead: `export type User = typeof User.Type`.
4. **Throwing sync decoders inside Effect code.** `decodeUnknownSync` raises
   outside the error channel, so it becomes a defect and loses the typed
   `SchemaError`.
   ```ts skip
   const input = Schema.decodeUnknownSync(Input)(raw)
   ```
   Use `yield* decode(raw)` with a module-level `const decode = Schema.decodeUnknownEffect(Input)`
   (the parser is compiled once, not per call) and map the error once at the edge.
5. **Flattening the error early.** `Effect.mapError((e) => new Error(e.message))`
   discards the path and issue tree that the HTTP layer needs. Keep `SchemaError`
   (or map to a tagged error that retains `formatIssues(...)` output) until the
   edge.
6. **Side effects or async work inside a check/filter.** Checks run on every
   decode *and* encode, and must be pure and total. Do lookups after decoding,
   or model them as an effectful transformation
   (`SchemaGetter.transformEffect`) that declares its service in `R`.
7. **Using `optional` when the key may simply be missing.** `optional` accepts
   `{ a: undefined }` too, which usually hides a producer bug; use
   `optionalKey` unless `undefined` is a real wire value. For "absent or
   null" prefer `Schema.OptionFromNullOr` / `OptionFromOptionalKey` and handle
   `Option` in the domain.
8. **v3 reflexes.** `Schema.filter`, `Schema.transform`, `Schema.pattern`,
   `Schema.decodeUnknown`, `Schema.Literal("a", "b")`, `Schema.optionalWith`,
   `Schema.validate*` do not exist. Use `.check`, `Schema.decodeTo`,
   `Schema.isPattern`, `decodeUnknownEffect`, `Schema.Literals([...])`,
   `withDecodingDefault*`, and `Schema.is`.

## Testing it

Schemas are pure, so test them with plain assertions: decode known-good input,
decode each known-bad input and assert the *path*, and assert
`encode(decode(x))` round-trips. This compiles and runs with only `effect` and
`node:assert`:

```ts import.meta.vitest name="references/schema/guide.md#4"
import assert from "node:assert/strict"
import { Effect, Result, Schema, SchemaIssue } from "effect"

const Signup = Schema.Struct({
  email: Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/)),
  age: Schema.Int.check(Schema.isBetween({ minimum: 18, maximum: 120 })),
  joined: Schema.DateFromString
})

const decode = Schema.decodeUnknownEffect(Signup)
const encode = Schema.encodeEffect(Signup)
const paths = SchemaIssue.makeFormatterStandardSchemaV1()

const test = Effect.gen(function*() {
  // good input, and the round-trip back to the wire form
  const wire = { email: "a@b.co", age: 30, joined: "2025-01-01T00:00:00.000Z" }
  const value = yield* decode(wire)
  assert.ok(value.joined instanceof Date)
  assert.deepStrictEqual(yield* encode(value), wire)

  // bad input: assert on where it failed, not on prose
  const failure = yield* decode({ email: "nope", age: 7, joined: "x" }, { errors: "all" }).pipe(Effect.flip)
  const failed = paths(failure.issue).issues.map((issue) => String(issue.path?.[0]))
  assert.deepStrictEqual(failed.sort(), ["age", "email", "joined"])

  // non-throwing sync check for pure schemas
  assert.ok(Result.isFailure(Schema.decodeUnknownResult(Signup)({})))
})

await Effect.runPromise(test)
```

With `@effect/vitest` (not installed here), `it.effect.prop(name, [Signup], ([value]) => Effect.gen(...))`
uses the schema as a property-test generator for the same round-trip assertion.

When a schema decodes with a service requirement (`DecodingServices` is not
`never`), supply a test layer to the test exactly as for any other effect.

## Boundaries

- [config](../config/guide.md): `Config.schema` takes any `Schema` here, but the key
  naming, providers and secret handling are its job.
- [data](../data/guide.md): plain `Data.Class` / `Data.TaggedEnum` / `Brand` for values
  that are never decoded or encoded; if it crosses a boundary, use Schema.
- [core](../core/guide.md): how `SchemaError` and your tagged errors flow through `E`,
  `catchTag`, `orDie`, retries.
- [http-api](../http-api/guide.md), [rpc](../rpc/guide.md), [sql](../sql/guide.md), [ai](../ai/guide.md): they accept
  schemas for payloads, success and error types; define the schema here and
  pass it in. A `Schema.TaggedError` is what lets an error cross the wire.
- [services](../services/guide.md): decoding with a service requirement puts that service
  in `R`; provide it with a Layer.
- [encoding](../encoding/guide.md): byte/text encodings (base64, hex) beyond the string
  codecs such as `Schema.StringFromBase64`.

## Changed in 4.1

Everything below is absent from 4.0.0 (a few arrived in 4.0.x patch releases). Many are marked `experimental` or `unstable` in the source, so expect their shape to move and pin the version if you rely on them.

- Network and web formats: `Schema.Port` (integer 0..65535), `DomainName` (accepts only already-normalized names) and `DomainNameFromString` (lower-cases and normalizes first), `Host`, `HostPort` and `*FromString` variants, `ScopedIpv6Literal`, the `Dns*Record` family, `RetryAfterFromString`, `DateTimeUtcFromHttpDate`.
- `Schema.DurationFromIsoString` decodes `"PT1M30S"` to a `Duration` and encodes back (`Duration.fromIso` / `Duration.formatIso` are the plain-function equivalents).
- `Schema.SemVerFromString` and `SemVerRangeFromString` parse semantic versions; `Schema.SemVer` validates a value that already is a `SemVer`.
- `Schema.isAscii()` check; crypto key schemas (`MacKey`, `AeadKey`, `CipherKey`, `SignaturePublicKey`, ... with `*FromBytes` / `*FromFormat` codecs).
- `Schema.toCodecGoJson(S)` is `toCodecJson` for JSON written by Go services: `null` for an optional key decodes as a missing key, `null` for a required array or record decodes as `[]` / `{}`.
- `Schema.TaggedUnion(...)` also exposes `.tag` (the discriminant key, `"_tag"`); `Schema.Enum` infers literal enum values (`const` generic).
- Removed: `SchemaAST.containsUndefined`.

```ts import.meta.vitest name="references/schema/guide.md#5"
import { Duration, Schema } from "effect"

Schema.decodeUnknownSync(Schema.Port)(8080) // => 8080
Schema.is(Schema.Port)(70000) // => false

// DomainName validates; DomainNameFromString normalizes first.
Schema.is(Schema.DomainName)("EXAMPLE.com") // => false
Schema.decodeUnknownSync(Schema.DomainNameFromString)("EXAMPLE.com") // => "example.com"

Schema.decodeUnknownSync(Schema.DurationFromIsoString)("PT1M30S") // => Duration.seconds(90)
Schema.encodeSync(Schema.DurationFromIsoString)(Duration.seconds(90)) // => "PT1M30S"

const version = Schema.decodeUnknownSync(Schema.SemVerFromString)("1.2.3-beta.1+b5")
Schema.encodeSync(Schema.SemVerFromString)(version) // => "1.2.3-beta.1+b5"

Schema.is(Schema.String.check(Schema.isAscii()))("caf\u00e9") // => false

// Go services write null for nil slices and maps.
const Container = Schema.Struct({ Id: Schema.String, Names: Schema.Array(Schema.String), Labels: Schema.Record(Schema.String, Schema.String) })
Schema.decodeUnknownSync(Schema.toCodecGoJson(Container))({ Id: "c1", Names: null, Labels: null }) // => { Id: "c1", Names: [], Labels: {} }
```

## References

- [references/api-cheatsheet.md](api-cheatsheet.md): verified signatures and the v3 -> v4 rename table
- [references/transformations.md](transformations.md): decodeTo, effectful decode, snake_case, field helpers
- [Schema API](https://effect.website/docs/v4/api/effect/Schema)
- [SchemaIssue API](https://effect.website/docs/v4/api/effect/SchemaIssue)
- [SchemaTransformation API](https://effect.website/docs/v4/api/effect/SchemaTransformation)
- [SchemaGetter API](https://effect.website/docs/v4/api/effect/SchemaGetter)
- [JsonSchema API](https://effect.website/docs/v4/api/effect/JsonSchema)
- [Pinned Schema source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Schema.ts)
- [Upstream schema example](https://github.com/Effect-TS/effect/blob/effect%404.1.2/ai-docs/src/01_effect/02_schema/10_schema-basics.ts)
