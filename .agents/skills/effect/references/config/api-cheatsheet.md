# Config and ConfigProvider cheat sheet (effect@4.1.2)

Checked against `node_modules/effect/src/Config.ts` and `ConfigProvider.ts`.
Constructor names are capitalised because they shadow globals (`String`,
`Number`, `Boolean`, `Array`, `Record`, `URL`, `Date`).

## Config

`Config<T>` extends `Effect<T, ConfigError>`: `yield*` it (it uses the current
`ConfigProvider` from context) or call `config.parse(provider)` for an explicit
provider. `ConfigError` has `_tag: "ConfigError"`, `cause: SourceError | SchemaError`,
and `message`.

| API | Meaning |
| --- | --- |
| `Config.schema(codec, path?)` | the primitive: parse the node at `path` with any Schema codec (`path`: string or `ReadonlyArray<string \| number>`) |
| `Config.String(name?)`, `NonEmptyString`, `Number`, `Finite`, `Int`, `Boolean` | scalar shortcuts over `Schema.String` etc. (`Number` accepts `NaN`/`Infinity`) |
| `Config.Port(name?)` | integer 1..65535 |
| `Config.Literal(v, name?)`, `Config.Literals([..], name?)` | fixed value(s) |
| `Config.URL(name?)`, `Date`, `Duration` (`DurationFromString`: `"5 seconds"`), `ByteSize`, `LogLevel` | rich types |
| `Config.Redacted(name?)` | `Redacted<string>` |
| `Config.Array(valueSchema, path?, { separator? })` | one separated variable (default `,`) or indexed children (`X_0`, `X_1`) |
| `Config.Record(keySchema, valueSchema, path?, { separator?, keyValueSeparator?, trim?, keepEmptyValues? })` | `k=v,k2=v2` or child keys; `trim: true` trims keys and values, `keepEmptyValues: true` keeps `k=` as `""` instead of dropping it (both new in 4.1) |
| `Config.all({...} \| [..] \| iterable)` | combine independent lookups; absent if any child is absent and none fail |
| `Config.nested(name)` | prepend a path segment (`_`-joined in env, an object level in JSON); dual: `nested(config, name)` |
| `Config.withDefault(value)` | value when the config is **absent**; errors still fail |
| `Config.option(config)` | `Option<A>`; `None` only when absent |
| `Config.map(f)`, `flatMap(f => Config)`, `mapEffect(f => Effect<B, ConfigError>)` | transform (all dual: data-first or data-last) |
| `Config.orElse((error) => Config)` | recover from a `ConfigError` (missing, invalid or unreadable value); defects and interruptions in the primary config propagate (4.1) |
| `Config.succeed(v)`, `Config.fail(err)`, `Config.unwrap(wrapped)` | constants and building configs from `{ key: Config }` records |
| `Config.isConfig(u)`, `Config.Success<C>` | guard and type extractor |

Semantics that bite:

- **Absent vs invalid.** Absent (no node) can be defaulted/optional; present but
  invalid, or a provider read failure, always fails.
- **Schema wins.** `Config.schema(Schema.UndefinedOr(Schema.String), "X")`
  decodes a missing value to `undefined` and `withDefault` will not apply.
- **`all` vs `Struct`.** `Config.all` is lookups-with-recovery;
  `Config.schema(Schema.Struct)` validates an existing object and fails on a
  missing field. An outer `withDefault` on `all` replaces the whole group.
- **Opaque schemas are rejected when the Config is built** (`Schema.Any`,
  `Unknown`, `Json`, `ObjectKeyword`). For arbitrary JSON in one variable use
  `Schema.fromJsonString(Schema.Json)`.
- **First failure only.** `Config.all` reports the first failing key, not every
  problem; an operator fixes variables one by one, so keep names obvious.

## ConfigProvider

`ConfigProvider` has `load(path): Effect<Node | undefined, SourceError>` and
`mapInput(f)`. `Node` is `Value` / `Record` / `Array` (`makeValue`,
`makeRecord(keys, value?)`, `makeArray(length, value?)`).

| API | Meaning |
| --- | --- |
| `ConfigProvider.ConfigProvider` | `Context.Reference`, default `fromEnv()`; read or override with `Effect.provideService` |
| `fromEnv({ env?, preserveEmptyStrings? })` | `process.env` (+ `import.meta.env`) or an explicit record |
| `fromEnvRecord(record, opts?)` | explicit record only |
| `fromUnknown(value, opts?)` | in-memory JSON-like value; numbers/booleans stringified |
| `fromDotEnvContents(text, { expandVariables?, preserveEmptyStrings? })` | parse `.env` text |
| `fromDotEnv({ path?, expandVariables?, preserveEmptyStrings? })` | `Effect<ConfigProvider, PlatformError, FileSystem>`; default path `.env` |
| `fromDir({ rootPath?, preserveEmptyStrings? })` | `Effect<ConfigProvider, never, Path \| FileSystem>`; file per key |
| `make(get)` | custom provider from `(path) => Effect<Node \| undefined, SourceError>` |
| `orElse(self, that)` | `that` only where `self` has no node |
| `nested(self, prefix)` / `mapInput(self, f)` / `constantCase(self)` | path rewriting for the provider |
| `layer(providerOrEffect)` | install as the active provider (replaces) |
| `layerAdd(providerOrEffect, { asPrimary? })` | compose with the current provider (fallback by default) |
| `SourceError` | `Data.TaggedError("SourceError")` for unreadable sources |

## Related

- Secrets: `Redacted.make`, `Redacted.value`, `String(redacted) === "<redacted>"`.
- Parsing: every shortcut is a `Schema`; see [schema](../schema/guide.md) for building
  custom ones and `Schema.RedactedFromValue` / `Schema.Redacted`.
- Entry point: `NodeRuntime.runMain(program)` from `@effect/platform-node`
  reports a failed config layer and sets the exit code ([platform](../platform/guide.md)).

## v3 -> v4 renames

| v3 | v4 |
| --- | --- |
| `Config.string("X")`, `integer`, `number`, `boolean`, `url`, `duration`, `logLevel` | `Config.String("X")`, `Int`, `Number`/`Finite`, `Boolean`, `URL`, `Duration`, `LogLevel` |
| `Config.secret("X")` / `Secret` | `Config.Redacted("X")` / `Redacted` |
| `Config.array(Config.string(), "X")` | `Config.Array(Schema.String, "X")` |
| `Config.hashMap` / `Config.table` | `Config.Record(keySchema, valueSchema, "X")` |
| `Config.nested(config, "A")` | `config.pipe(Config.nested("A"))` (still dual) |
| `Config.struct`/`Config.all` of record | `Config.all({...})` |
| `Config.validate` / `Config.mapAttempt` | a Schema with `.check`, or `Config.mapEffect` |
| `Effect.withConfigProvider(p)`, `Layer.setConfigProvider(p)`, `ConfigProvider.fromMap`, `ConfigProvider.fromJson` | `Effect.provideService(ConfigProvider.ConfigProvider, p)`, `ConfigProvider.layer(p)`, `fromEnv({ env })`, `fromUnknown` |
| `ConfigProvider.nested`, `.constantCase`, `.orElse` | same names; `constantCase` is a function, not a flag |
