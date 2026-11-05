# Transformations, effectful decoding and field helpers

Read this when wire and domain shapes differ, when decoding needs a service,
or when you reshape structs. Every fence compiles and runs against `effect@4.1.2`.

## Check or transform?

| You want | Tool | Inverse needed? |
| --- | --- | --- |
| reject some strings/numbers, keep the same type | `.check(Schema.isXxx(...))` | no |
| string `"2025-01-01"` <-> `Date` | a ready-made schema (`Schema.DateFromString`) | built in |
| compute a different domain value | `Schema.decodeTo(To, { decode, encode })` | yes, `encode` is mandatory |
| keep the value, only rename wire keys | `Schema.encodeKeys({ domain: "wire" })` | built in |
| the domain type needs a lookup/service | `SchemaGetter.transformEffect` | yes, may declare its own service |

If you cannot write a faithful `encode`, you probably want a `check` plus a
separate function, not a transformation. Encode that silently loses data makes
`encode(decode(x))` stop being the identity.

## A two-way transformation

`decodeTo(To, { decode, encode })` reads: decode produces `To["Encoded"]` from
the source `Type`; encode goes back. `SchemaGetter.transform` lifts a pure
function into a getter.

```ts import.meta.vitest name="references/schema/transformations.md#1"
import { Schema, SchemaGetter } from "effect"

// Wire: integer cents (number). Domain: dollars (number). The brand stops
// dollars and cents being mixed up after decoding.
export const Dollars = Schema.Number.pipe(
  Schema.decodeTo(Schema.Finite.pipe(Schema.brand("Dollars")), {
    decode: SchemaGetter.transform((cents: number) => cents / 100),
    encode: SchemaGetter.transform((dollars: number) => Math.round(dollars * 100))
  })
)

export const toWire = Schema.encodeSync(Dollars)
export const fromWire = Schema.decodeUnknownSync(Dollars)

fromWire(1999) // => 19.99
toWire(fromWire(1999)) // => 1999
```

`SchemaTransformation.transform({ decode, encode })` is the same thing as one
bundled object, which is convenient when the pair is reused:

```ts import.meta.vitest name="references/schema/transformations.md#2"
import { Schema, SchemaTransformation } from "effect"

const trimLower = SchemaTransformation.transform({
  decode: (s: string) => s.trim().toLowerCase(),
  encode: (s: string) => s
})

export const Handle = Schema.String.pipe(Schema.decodeTo(Schema.String, trimLower))

Schema.decodeUnknownSync(Handle)("  AdA ") // => "ada"
```

## Chaining schemas

`decodeTo(To)` with no transformation composes two schemas whose sides line
up: the first schema's `Type` must be the second's `Encoded`. That is how
`Schema.FiniteFromString.check(...)` style schemas are built.

```ts import.meta.vitest name="references/schema/transformations.md#3"
import { Schema } from "effect"

// string -> number (FiniteFromString) -> checked range
export const Percent = Schema.FiniteFromString.check(
  Schema.isBetween({ minimum: 0, maximum: 100 })
)

// JSON text -> object -> typed fields, in one schema
export const Settings = Schema.fromJsonString(
  Schema.Struct({ theme: Schema.Literals(["light", "dark"]), fontSize: Schema.Int })
)

Schema.decodeUnknownSync(Percent)("42") // => 42
Schema.decodeUnknownSync(Settings)('{"theme":"dark","fontSize":14}') // => { theme: "dark", fontSize: 14 }
Schema.encodeSync(Settings)({ theme: "light", fontSize: 12 }) // => '{"theme":"light","fontSize":12}'
```

## Effectful decoding that needs a service

A getter may be effectful and may require services. The requirement lands in
`Schema["DecodingServices"]` and therefore in `R` of
`Schema.decodeUnknownEffect`, so the compiler makes you provide it. Use this
sparingly: it is for derivations (look up a currency rate, resolve a tenant)
and not for I/O validation that can fail for operational reasons.

```ts import.meta.vitest name="references/schema/transformations.md#4"
import { Context, Effect, Schema, SchemaGetter } from "effect"

export class Rates extends Context.Service<Rates, {
  readonly toEur: (usd: number) => number
  readonly toUsd: (eur: number) => number
}>()("app/Rates") {
  static readonly layerFixed = (rate: number) => Rates.of({ toEur: (usd) => usd * rate, toUsd: (eur) => eur / rate })
}

// Wire: USD amount. Domain: EUR amount computed through the Rates service.
export const EurFromUsd = Schema.Finite.pipe(
  Schema.decodeTo(Schema.Finite, {
    decode: SchemaGetter.transformEffect((usd: number) => Rates.use((rates) => Effect.succeed(rates.toEur(usd)))),
    // The inverse needs the service too, so encode declares the requirement as well.
    encode: SchemaGetter.transformEffect((eur: number) => Rates.use((rates) => Effect.succeed(rates.toUsd(eur))))
  })
)

// R = Rates, visible in the type (encodeEffect needs it too); no layer, no run.
const decode = Schema.decodeUnknownEffect(EurFromUsd)

await Effect.runPromise(decode(100).pipe(
  Effect.provideService(Rates, Rates.layerFixed(0.9))
)) // => 90
```

## Renaming keys and reshaping structs

```ts import.meta.vitest name="references/schema/transformations.md#5"
import { Schema, Struct } from "effect"

// Domain uses camelCase, the wire uses snake_case; only the keys differ.
export const Customer = Schema.Struct({
  firstName: Schema.String,
  signupDate: Schema.DateFromString
}).pipe(Schema.encodeKeys({ firstName: "first_name", signupDate: "signup_date" }))

Schema.decodeUnknownSync(Customer)({
  first_name: "Ada",
  signup_date: "2025-01-01T00:00:00.000Z"
}) // => { firstName: "Ada", signupDate: new Date("2025-01-01T00:00:00.000Z") }

// Reuse fields: `.fields` is a plain record; spread it, or map it.
const Base = Schema.Struct({ id: Schema.String, name: Schema.String, age: Schema.Int })

export const Create = Base.mapFields(Struct.omit(["id"]))
export const Patch = Base.mapFields(Struct.map(Schema.optionalKey))
export const WithEmail = Schema.Struct({ ...Base.fields, email: Schema.String })
export const Renamed = Base.mapFields(Struct.assign({ displayName: Schema.String }))

Object.keys(Create.fields) // => ["name", "age"]
Object.keys(Patch.fields) // => ["id", "name", "age"]
Object.keys(WithEmail.fields) // => ["id", "name", "age", "email"]
Object.keys(Renamed.fields) // => ["id", "name", "age", "displayName"]

// Patch makes every key optional: an empty object is a valid patch.
Schema.decodeUnknownSync(Patch)({}) // => {}
```

## Option, null and missing keys

| Wire form | Schema | Domain |
| --- | --- | --- |
| `"x"` or `null` | `Schema.OptionFromNullOr(S)` | `Option<A>` |
| `"x"` or `undefined` | `Schema.OptionFromUndefinedOr(S)` | `Option<A>` |
| key present or absent | `Schema.OptionFromOptionalKey(S)` | `Option<A>` |
| key absent or `undefined` | `Schema.OptionFromOptional(S)` | `Option<A>` |
| key absent -> default | `S.pipe(Schema.withDecodingDefaultKey(Effect.succeed(v)))` | `A` |

```ts import.meta.vitest name="references/schema/transformations.md#6"
import { Option, Schema } from "effect"

export const Profile = Schema.Struct({
  nickname: Schema.OptionFromNullOr(Schema.String),
  bio: Schema.OptionFromOptionalKey(Schema.String)
})

const decoded = Schema.decodeUnknownSync(Profile)({ nickname: null })
Option.isNone(decoded.nickname) // => true
Option.isNone(decoded.bio) // => true

// Encoding goes back: `None` for an optional key means the key is omitted.
Schema.encodeSync(Profile)({ nickname: Option.some("ada"), bio: Option.none() }) // => { nickname: "ada" }
```

## Recursive schemas

TypeScript cannot infer a type that mentions itself, so give the schema an
explicit `Schema.Codec<T>` annotation and wrap the self reference in
`Schema.suspend`.

```ts import.meta.vitest name="references/schema/transformations.md#7"
import { Schema } from "effect"

export interface Category {
  readonly name: string
  readonly children: ReadonlyArray<Category>
}

export const Category: Schema.Codec<Category> = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Category> => Category))
})

const tree = { name: "root", children: [{ name: "leaf", children: [] }] }
Schema.decodeUnknownSync(Category)(tree) // => tree
Schema.is(Category)({ name: "root", children: [{ name: 1, children: [] }] }) // => false
```

## JSON-safe encoding

`Schema.toCodecJson(S)` returns a codec whose encoded side is JSON-safe
(for example `Date` -> ISO string, `Option` -> `{ _tag }`, `Redacted` ->
the underlying value). Use it when a schema describes domain values with no
explicit wire representation and you need to persist or send them.

```ts import.meta.vitest name="references/schema/transformations.md#8"
import { Schema } from "effect"

const Row = Schema.Struct({ at: Schema.Date, secret: Schema.RedactedFromValue(Schema.String) })
export const RowJson = Schema.toCodecJson(Row)

const row = Schema.decodeUnknownSync(RowJson)({ at: "2025-01-01T00:00:00.000Z", secret: "s3" })
row.at.getUTCFullYear() // => 2025
String(row.secret) // => "<redacted>"

Schema.encodeSync(RowJson)(row) // => { at: "2025-01-01T00:00:00.000Z", secret: "s3" }
```

Note the last line: encoding a `Redacted` value emits the secret. Encode only
into stores that are allowed to hold it, and never log the result.

## Parse options

| Option | Values | Effect |
| --- | --- | --- |
| `errors` | `"first"` (default) / `"all"` | collect every issue (use for forms and HTTP 400s) |
| `onExcessProperty` | `"ignore"` (default) / `"error"` | strict mode: reject unknown keys instead of stripping them |

Pass them as the second argument: `decode(input, { errors: "all", onExcessProperty: "error" })`.
