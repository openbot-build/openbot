# Providers, precedence and key naming

Every fence compiles against `effect@4.1.2`, and all but the ones that need a real file system are run as doctests. The provider is a
`Context.Reference<ConfigProvider>` whose default value is `fromEnv()`, so no
provider layer is ever *required*.

## How a key becomes a lookup

A `Config` asks the provider for a **path** (an array of segments). The env
provider joins the segments with `_` (`["DB", "POOL_SIZE"]` -> `DB_POOL_SIZE`);
the JSON provider walks object keys and array indexes. `Config.nested("DB")`
prepends a segment. That is why the same `Config` works against both:

```ts import.meta.vitest name="references/config/providers.md#1"
import { Config, ConfigProvider, Effect } from "effect"

const db = Config.all({
  host: Config.String("HOST"),
  poolSize: Config.Int("POOL_SIZE").pipe(Config.withDefault(10))
}).pipe(Config.nested("DB"))

const fromEnv = ConfigProvider.fromEnv({ env: { DB_HOST: "db.internal" } })
const fromJson = ConfigProvider.fromUnknown({ DB: { HOST: "db.internal", POOL_SIZE: 20 } })

await Effect.runPromise(db.parse(fromEnv)) // => { host: "db.internal", poolSize: 10 }
await Effect.runPromise(db.parse(fromJson)) // => { host: "db.internal", poolSize: 20 }
```

`Config.X(name)` accepts a single key; `Config.schema(codec, path)` accepts a
string or a path array. A config with no name (`Config.schema(S)`) reads at the
current nesting root.

## camelCase fields against SCREAMING_SNAKE variables

`Config.schema(Schema.Struct({...}))` looks for keys with exactly the struct's
field names. Environment variables are conventionally upper-case, so map the
path with `ConfigProvider.constantCase`:

```ts import.meta.vitest name="references/config/providers.md#2"
import { Config, ConfigProvider, Effect, Schema } from "effect"

const Settings = Config.schema(
  Schema.Struct({
    databaseUrl: Schema.URL,
    maxConnections: Schema.FiniteFromString.check(Schema.isInt()),
    apiKey: Schema.Redacted(Schema.String)
  })
)

// `databaseUrl` -> DATABASE_URL, `maxConnections` -> MAX_CONNECTIONS
const provider = ConfigProvider.fromEnv({
  env: { DATABASE_URL: "https://db.example", MAX_CONNECTIONS: "5", API_KEY: "k" }
}).pipe(ConfigProvider.constantCase)

const settings = await Effect.runPromise(Settings.parse(provider))
settings.databaseUrl.host // => "db.example"
settings.maxConnections // => 5
String(settings.apiKey) // => "<redacted>"
```

Install it for the whole program with `ConfigProvider.layer(provider)`. Prefer
explicit names (`Config.URL("DATABASE_URL")`) when the variable names are a
contract with the platform; use `constantCase` when the struct is the contract.

## Precedence

`ConfigProvider.orElse(a, b)` consults `b` only when `a` has no node at the
path. A `SourceError` from `a` is **not** caught (an unreadable source is a
failure, not a miss). The layer form is `layerAdd(fallback)` (fallback behind
the current provider) or `layerAdd(primary, { asPrimary: true })`.

```ts import.meta.vitest name="references/config/providers.md#3"
import { Config, ConfigProvider, Effect } from "effect"

const cli = ConfigProvider.fromUnknown({ PORT: 9000 })
const env = ConfigProvider.fromEnv({ env: { PORT: "8000", HOST: "env-host" } })
const defaults = ConfigProvider.fromUnknown({ PORT: 3000, HOST: "localhost", LEVEL: "info" })

// Left wins. cli > env > defaults.
const provider = ConfigProvider.orElse(ConfigProvider.orElse(cli, env), defaults)

const all = Config.all({ port: Config.Int("PORT"), host: Config.String("HOST"), level: Config.String("LEVEL") })
await Effect.runPromise(all.parse(provider)) // => { port: 9000, host: "env-host", level: "info" }
```

Precedence is per **key**, not per source: a key missing from a higher source
falls through even when other keys came from it.

## Mounted secrets (one file per key)

`ConfigProvider.fromDir({ rootPath })` treats each file as a leaf (trimmed
contents) and each directory as a record. It needs `FileSystem` and `Path`
services; in production use the platform layers (for Node:
`NodeFileSystem.layer` from `@effect/platform-node` and `Path.layer`).

```ts import.meta.vitest name="references/config/providers.md#4"
import { Config, ConfigProvider, Effect, FileSystem, Path, Redacted } from "effect"

// A fake file system keeps the example hermetic; in production provide the real one.
const fakeFs = FileSystem.makeNoop({
  readFileString: (path) =>
    path === "/run/secrets/db_password" ? Effect.succeed("s3cret\n") : Effect.die("unexpected read")
})

const program = Effect.gen(function*() {
  const provider = yield* ConfigProvider.fromDir({ rootPath: "/run/secrets" })
  return yield* Config.Redacted("db_password").parse(provider)
})

await Effect.runPromise(
  program.pipe(Effect.provide(Path.layer), Effect.provideService(FileSystem.FileSystem, fakeFs))
).then(Redacted.value) // => "s3cret"
```

## A custom provider

`ConfigProvider.make(get)` is all you need for a database, vault or remote
service: return `undefined` for "no such key", a `Node` when found, and fail
with `SourceError` only when the source itself is broken (so it is not
mistaken for a miss and silently skipped by `orElse`).

```ts import.meta.vitest name="references/config/providers.md#5"
import { Config, ConfigProvider, Effect } from "effect"

const store: Record<string, string> = { "feature.checkout": "true", "feature.limit": "5" }

const fromStore = ConfigProvider.make((path) =>
  Effect.sync(() => {
    const value = store[path.join(".")]
    return value === undefined ? undefined : ConfigProvider.makeValue(value)
  })
)

const flags = Config.all({
  checkout: Config.Boolean("checkout"),
  limit: Config.Int("limit")
}).pipe(Config.nested("feature"))

await Effect.runPromise(flags.parse(fromStore)) // => { checkout: true, limit: 5 }

// A key the store does not have is a miss, so withDefault/orElse can apply.
await Effect.runPromise(Config.Int("nope").pipe(Config.withDefault(1)).parse(fromStore)) // => 1
```

Return `makeRecord(keys)` / `makeArray(length)` nodes if your source has
structure and you want `Config.schema(Schema.Struct(...))` or `Config.Array` to
discover children. Keep a custom provider free of caching surprises: it is
called every time a `Config` is evaluated.

## Parsing details worth knowing

- Empty strings are treated as missing everywhere (`fromEnv`, `fromUnknown`,
  `fromDotEnvContents`, `fromDir`); pass `{ preserveEmptyStrings: true }` to
  keep them.
- `fromDotEnvContents(text, { expandVariables: true })` enables `${VAR}`
  expansion; it is off by default.
- Env names are also split on `_` to discover children, so `A_B=1` is visible
  at `["A_B"]` and `["A","B"]`; if every child of a node is numeric the node is
  an array (`ORIGINS_0`, `ORIGINS_1`).
- `fromEnv` reads `process.env` merged with `import.meta.env` at *construction*
  time; names added to the record later are not discovered as children.
- `Config.withDefault` and `Config.option` treat only an **absent** value as
  missing; invalid or unreadable values stay failures. For a group built with
  `Config.all`, an outer `withDefault` replaces the whole group when any child is
  absent: put defaults on the children to keep the others.
