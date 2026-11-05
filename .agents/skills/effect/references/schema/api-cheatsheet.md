# Schema API cheat sheet (effect@4.1.2)

Every name below was checked against `node_modules/effect/src/Schema.ts`. When
a name you expect is missing, grep the source rather than guessing: v3 names
frequently do not exist.

## Reading the type

`Schema.Codec<T, E, RD, RE>`: `T` = decoded `Type`, `E` = `Encoded`, `RD` /
`RE` = services needed to decode / encode (almost always `never`).
`Schema.Schema<T>` is the Type-only view. Read the sides off a value:

- `typeof S.Type`, `typeof S.Encoded`, `S["DecodingServices"]`, `S["EncodingServices"]`
- `Schema.toType(S)` / `Schema.toEncoded(S)`: the schema of just one side
- `Schema.flip(S)`: swap the two sides

## Parsing

| Goal | API (all curried: `Schema.fn(S)(input, options?)`) |
| --- | --- |
| decode `unknown` in Effect | `decodeUnknownEffect` (error `SchemaError`, requirement `DecodingServices`) |
| decode typed `Encoded` | `decodeEffect` |
| encode | `encodeEffect` (typed `Type`), `encodeUnknownEffect` |
| as `Exit` / `Option` / `Result` / `Promise` / sync-throwing | `decodeUnknownExit`, `...Option`, `...Result`, `...Promise`, `...Sync` (same suffixes for `decode*`, `encode*`) |
| type guard on the `Type` side | `Schema.is(S)(u)`; `Schema.asserts(S)(u)` |
| construct a value, checks on | `S.make(input)` (throws), `S.makeOption(input)`, `S.makeEffect(input)` |

Options: `{ errors: "first" | "all", onExcessProperty: "ignore" | "error" }`.
`SchemaError` has `.issue` (structured) and `.message` (rendered).
`Effect.catchTag("SchemaError", ...)` works because it is tagged.

## Primitives and common codecs

- Primitives: `String`, `Number`, `Boolean`, `BigInt`, `Symbol`, `Null`, `Undefined`, `Void`, `Unknown`, `Any`, `Never`, `ObjectKeyword`
- Constrained: `NonEmptyString`, `Int`, `Finite`, `Natural`, `Char`, `Trimmed` (check), `Trim` (transformation that trims)
- Strings <-> values: `NumberFromString`, `FiniteFromString`, `BigIntFromString`, `DateFromString`, `DateFromMillis`, `DateTimeUtcFromString`, `DurationFromString`, `BigDecimalFromString`, `URLFromString`, `StringFromBase64`, `StringFromBase64Url`, `StringFromHex`, `Uint8ArrayFromBase64`, `Uint8ArrayFromHex`, `BooleanFromBit`
- Instances: `Date`, `URL`, `RegExp`, `Duration`, `DateTimeUtc`, `BigDecimal`, `Uint8Array`, `File`, `FormData`, `URLSearchParams`, `Defect`, `Cause`, `Exit`
- Effect data types: `Option(S)`, `Result(A, E)`, `Chunk(S)`, `HashMap`, `HashSet`, `ReadonlyMap(K, V)`, `ReadonlySet(S)`, `Redacted(S)` (instance), `RedactedFromValue(S)` (plain -> `Redacted`)
- Json: `fromJsonString(S)` (text <-> `S`), `UnknownFromJsonString`, `Json`
- Network: `Ipv4Address`, `Ipv6Address`, `IpAddress`, `*FromString` variants, `MacAddress`, `SocketAddress`
- Option fields: `OptionFromNullOr`, `OptionFromUndefinedOr`, `OptionFromNullishOr`, `OptionFromOptionalKey`, `OptionFromOptional`, `OptionFromOptionalNullOr`

## Structure

| Need | API |
| --- | --- |
| object | `Struct({ ... })`; `.fields`; `.mapFields(fn)` |
| tagged object | `TaggedStruct("Tag", fields)`; single literal field `Schema.tag("Tag")` |
| union | `Union([A, B])`; strings: `Literals(["a", "b"])`; one literal: `Literal("a")` |
| tagged union | `TaggedUnion({ Tag: fields })` or `Union([...]).pipe(Schema.toTaggedUnion("_tag"))`; gives `.cases`, `.guards`, `.match`, `.matchOrElse`, `.isAnyOf` |
| array / tuple / record | `Array(S)`, `NonEmptyArray(S)`, `UniqueArray(S)`, `Tuple([A, B])`, `Record(K, V)`, `StructWithRest`, `TupleWithRest` |
| nullable | `NullOr(S)`, `UndefinedOr(S)`, `NullishOr(S)` |
| enum | `Enum(MyEnum)` |
| template literal | `TemplateLiteral([...])`, `TemplateLiteralParser` |
| optional / mutable key | `optionalKey(S)`, `optional(S)`, `requiredKey`, `required`, `mutableKey`, `readonlyKey`, `mutable(S)` |
| class | `Class<Self>("id")(fields | Struct)`, `TaggedClass<Self>()("Tag", fields)`; `.extend<Sub>("id")(fields)` |
| error class | `TaggedError<Self>()("Tag", fields)`; plain `Error` class `Schema.Error` exists but prefer tagged |
| opaque type over a schema | `class X extends Schema.Opaque<X>()(S) {}` |
| instance check | `instanceOf(Ctor)` |
| recursion | `suspend(() => S)` |
| field helpers | `Struct.pick/omit/map/assign` from `effect`'s `Struct` module via `S.mapFields(...)`; spread `S.fields` to extend |

Field-level modifiers: `withConstructorDefault(Effect)` (for `make`),
`withDecodingDefault(Effect)` / `withDecodingDefaultKey(Effect)` (default the
*Encoded* value; `Key` variant: only when the key is absent),
`withDecodingDefaultType` / `...TypeKey` (default expressed as a `Type` value).
Defaults are `Effect`s: `Effect.succeed(x)` or `Effect.sync(() => x)`.

## Checks (`S.check(...)`, or `Schema.check(...)` in a pipe)

- Strings: `isMinLength(n)`, `isMaxLength(n)`, `isBetweenLength(a, b)`, `isNonEmpty()`, `isPattern(re)`, `isUUID(version?)`, `isULID()`, `isTrimmed()`, `isStartingWith(s)`, `isEndingWith(s)`, `isIncluding(s)`, `isLowercased()`, `isUppercased()`, `isBase64()`
- Numbers: `isInt()`, `isFinite()`, `isGreaterThan(n)`, `isGreaterThanOrEqualTo(n)`, `isLessThan(n)`, `isLessThanOrEqualTo(n)`, `isBetween({ minimum, maximum })`, `isMultipleOf(n)`
- Arrays: `isMinLength`, `isMaxLength`, `isUnique()`
- Objects: `isMinProperties`, `isMaxProperties`, `isPropertyNames(schema)`
- Dates/BigInt/BigDecimal: `isGreaterThanDate`, `isBetweenDate`, `isGreaterThanBigInt`, `isGreaterThanBigDecimal`, ...
- Custom: `Schema.makeFilter((value) => true | false | "message" | undefined | issue | issues[], annotations?)`. Returning a string or `false` fails; `undefined`/`true` passes. `Schema.refine(guard)` narrows the TypeScript type.
- Every check takes `annotations` as the last argument, e.g. `Schema.isMinLength(3, { message: "too short" })`.

## Transformations

| API | Purpose |
| --- | --- |
| `Schema.decodeTo(To)` | compose: this schema's `Type` is `To`'s `Encoded` |
| `Schema.decodeTo(To, { decode, encode })` | transform with getters (`SchemaGetter.*`) |
| `Schema.encodeTo(To, { decode, encode })` | same idea anchored on the encoded side |
| `Schema.decode({ decode, encode })` / `Schema.encode(...)` | transform the Type / Encoded side in place |
| `Schema.encodeKeys({ field: "wire_key" })` | rename wire keys |
| `Schema.catchDecoding(f)` / `catchEncoding` | `f: (issue) => Effect<Option<Type>, Issue>`: recover from a failed decode (`Option.some(fallback)`), or re-fail |
| `SchemaGetter.transform(fn)`, `transformEffect(fn)`, `transformOptional(fn)`, `passthrough()`, `succeed(v)`, `fail((option, parseOptions) => Issue)`, `omit()`, `withDefault(effect)` | the building blocks of `decode` / `encode` |
| `SchemaTransformation.transform({ decode, encode })` | the same, bundled as one reusable value; also `transformOptional`, `trim`, `toLowerCase`, `snakeToCamel`, `numberFromString`, `dateFromString`, ... |

## Derivations

`Schema.toJsonSchemaDocument(S)` -> `{ dialect, schema, definitions }`,
`Schema.toCodecJson(S)` (JSON-safe encoded side), `Schema.toEquivalence(S)`,
`Schema.toFormatter(S)`, `Schema.toStandardSchemaV1(S)` (for libraries that
accept Standard Schema), `Schema.toRepresentation(S)`, `Schema.toIso(S)`.
Arbitraries for property tests live in the `Arbitrary` module and are what
`@effect/vitest`'s `it.effect.prop` consumes.

Annotate with `S.annotate({ identifier, title, description, message, ... })`;
`message` replaces the default error text, `identifier` names the schema in
JSON Schema and errors.

## Errors and issues

- `Schema.SchemaError` (`_tag: "SchemaError"`, `.issue`, `.message`), `Schema.isSchemaError(u)`
- `SchemaIssue.makeFormatterStandardSchemaV1()(issue)` -> `{ issues: [{ path, message }] }` (structured, for APIs)
- `SchemaIssue.makeFormatterDefault()` / `SchemaIssue.defaultFormatter(issue)` -> readable string (for logs)
- Issue kinds: `InvalidType`, `InvalidValue`, `MissingKey`, `UnexpectedKey`, `Pointer` (path), `Composite`, `AnyOf`, `OneOf`, `Filter`, `Encoding`, `Forbidden`
- `Schema.Class` constructors throw `Error` with the issue in `cause` when given invalid input; use `Class.makeEffect(...)` to keep it in the Effect error channel (it fails with the raw `SchemaIssue`)

## Brands

`S.pipe(Schema.brand("Name"))`: one brand key per call, type-only; apply it
repeatedly for several brands. `Schema.fromBrand("Name", ctor)` reuses a
`Brand.check`/`Brand.make` constructor's checks. Brand after the checks so the
checks run on the unbranded value.

## v3 -> v4 renames

| v3 | v4 |
| --- | --- |
| `Schema.decodeUnknown(S)` | `Schema.decodeUnknownEffect(S)` |
| `Schema.decode(S)` / `encode(S)` (parsers) | `Schema.decodeEffect(S)` / `encodeEffect(S)` (`decode`/`encode` are now transformation combinators) |
| `Schema.validate*` | `Schema.is`, `Schema.asserts`, or decode the `Type` side |
| `Schema.Schema.Type<typeof S>` | `typeof S.Type` (or `S["Type"]`) |
| `Schema.filter(pred)` | `.check(Schema.makeFilter(pred))` |
| `Schema.minLength(n)`, `maxLength`, `pattern(re)` | `.check(Schema.isMinLength(n))`, `isMaxLength`, `isPattern(re)` |
| `Schema.greaterThan(n)`, `int()`, `between` | `.check(Schema.isGreaterThan(n))`, `Schema.Int`, `isBetween({ minimum, maximum })` |
| `Schema.transform(from, to, { decode, encode })` | `from.pipe(Schema.decodeTo(to, { decode: SchemaGetter.transform(...), encode: ... }))` |
| `Schema.compose` | `Schema.decodeTo(To)` |
| `Schema.Literal("a", "b")` | `Schema.Literals(["a", "b"])` |
| `Schema.optional(S)` (key may be missing) | `Schema.optionalKey(S)`; `optional` now also admits `undefined` |
| `Schema.optionalWith(S, { default })` | `S.pipe(Schema.withDecodingDefaultKey(Effect.succeed(v)))` |
| `Schema.pick` / `omit` / `partial` / `extend` | `S.mapFields(Struct.pick([...]))`, `Struct.omit`, `Struct.map(Schema.optionalKey)`, spread `S.fields` |
| `Schema.Union(A, B)` (varargs) | `Schema.Union([A, B])` |
| `Schema.Array(S)`, `Schema.Tuple(A, B)` | `Schema.Array(S)`, `Schema.Tuple([A, B])` |
| `Schema.Map`, `Schema.Set` | `Schema.ReadonlyMap`, `Schema.ReadonlySet` |
| `Schema.DateFromSelf` | `Schema.Date` |
| `Schema.parseJson(S)` | `Schema.fromJsonString(S)` |
| `Schema.TaggedError` | unchanged name; message is empty unless you override `get message()` |
| `Schema.Struct({ _tag: Schema.Literal("A") })` | `Schema.TaggedStruct("A", fields)` / `Schema.tag("A")` |
