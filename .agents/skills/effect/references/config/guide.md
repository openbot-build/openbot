# Effect configuration

## How to think about it

Configuration is untrusted input that happens to arrive at startup. Reading
`process.env.PORT` gives `string | undefined` with no parsing, no error
path, and a read buried wherever someone typed it. Effect splits the problem
in two:

- **`Config<T>`** says *what* you need and how to parse it ("`PORT` is a port
  number, default 8080"). It is a description, and also an `Effect<T,
  ConfigError>` you can `yield*`.
- **`ConfigProvider`** says *where* raw values come from (environment, `.env`,
  JSON, a directory of secret files). It is a `Context.Reference` whose default
  is `fromEnv()`, so `yield* Config.Port("PORT")` works with no setup, and
  tests or deployments swap the source without touching the code that reads it.

Parsing is `Schema` underneath: every constructor is
`Config.schema(<Schema>, name)`, so errors are `ConfigError` wrapping a
`SchemaError` with the key path. Because a missing or malformed value is a
typed failure, the right place to read configuration is **once, at startup,
inside a Layer** that builds a typed `AppConfig` service. The process then
fails fast with a precise message instead of crashing on the first request, and
no other code ever mentions an environment variable.

Coming from `dotenv` / `process.env` / `convict`: there is no global mutable
config object; defaults apply only to *absent* keys, not to malformed ones; and
an empty string counts as absent (so `PORT=` falls back to the default).

## Choose

| Need | Use | Notes |
| --- | --- | --- |
| required string / non-empty | `Config.String("K")` / `Config.NonEmptyString("K")` | missing -> `ConfigError` |
| number, int, port, bool | `Config.Finite` / `Int` / `Port` / `Boolean` | `Config.Number` also accepts the strings `NaN` and `Infinity`, so prefer `Finite`; `Port` is `Int` in 1..65535; `Boolean` accepts true/false/yes/no/on/off/y/n/1/0 |
| url, duration, byte size, date, log level | `Config.URL` / `Duration` / `ByteSize` / `Date` / `LogLevel` | parsed to rich types (`"5 seconds"` -> `Duration`) |
| closed set | `Config.Literals(["dev", "prod"], "ENV")` | invalid value is an error |
| default when **absent** | `.pipe(Config.withDefault(x))` | a malformed value still fails; use `Config.orElse` to recover from errors |
| truly optional | `Config.option(c)` -> `Option<A>` | prefer over a fake default |
| secret | `Config.Redacted("API_KEY")` | prints `<redacted>`; never give it a default |
| list / map from one variable | `Config.Array(Schema.String, "ORIGINS")` (`a,b,c`), `Config.Record(Schema.String, Schema.String, "LABELS")` (`k=v,k2=v2`) | custom `{ separator }` option |
| group related keys | `Config.all({...}).pipe(Config.nested("DB"))` | env names become `DB_*`; in JSON, an object `DB` |
| whole struct from a schema | `Config.schema(Schema.Struct({...}), "DB")` | field names are the keys; combine with `ConfigProvider.constantCase` for camelCase fields |
| transform / validate | `Config.map(f)`, or a `Schema` with `.check(...)` | keep rules in the schema where possible |
| fallback key | `Config.orElse(() => other)` | catches any `ConfigError` (invalid values too), so be deliberate; defects still propagate |
| env (default) | nothing to provide | `ConfigProvider.fromEnv({ env })` for explicit records |
| `.env` file | `ConfigProvider.fromDotEnv({ path })` (needs `FileSystem`) | `fromDotEnvContents(text)` for a string |
| mounted secrets (Kubernetes) | `ConfigProvider.fromDir({ rootPath })` (needs `FileSystem`, `Path`) | one file per key |
| JSON / tests | `ConfigProvider.fromUnknown(obj)` | no I/O, deterministic |
| precedence | `ConfigProvider.layerAdd(fallback)` / `ConfigProvider.orElse(a, b)` | `a` wins, `b` only when `a` has no value |
| install a provider | `ConfigProvider.layer(provider)` | replaces the current one |

Do **not** use Config for per-request data, user-editable runtime settings, or
feature flags that must change while the process runs: a `Config` is read when
you evaluate it. Read it into a service at startup, or poll a service
that owns the refresh ([state](../state/guide.md)).

## Recipe

The pitfall:

```ts skip
const port = Number(process.env.PORT)          // NaN when unset; no error, no default
const dbUrl = process.env.DATABASE_URL!         // a lie until the first query
const apiKey = process.env.API_KEY ?? "dev-key" // a default for a credential: ships to prod
console.log("config", { port, dbUrl, apiKey })  // leaks the secret into logs
```

The idiom: parse once into a typed service, depend on the service everywhere.

```ts import.meta.vitest name="references/config/guide.md#2"
import { Config, ConfigProvider, Context, Duration, Effect, Layer, Redacted } from "effect"

// 1. The typed shape the rest of the program sees. No env names leak out.
export class AppConfig extends Context.Service<AppConfig, {
  readonly http: { readonly host: string; readonly port: number }
  readonly db: {
    readonly url: URL
    readonly poolSize: number
    readonly password: Redacted.Redacted
  }
  readonly requestTimeout: Duration.Duration
}>()("app/AppConfig") {
  // 2. Read the environment ONCE, when the layer is built. A missing or
  //    malformed variable fails the layer, so the process fails at startup
  //    with E = ConfigError and the key path in the message.
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function*() {
      // Defaults only for non-critical, absent keys. HTTP_HOST / HTTP_PORT in env.
      const http = yield* Config.all({
        host: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
        port: Config.Port("PORT").pipe(Config.withDefault(8080))
      }).pipe(Config.nested("HTTP"))

      // Required: no default for a URL or a credential. DB_URL, DB_POOL_SIZE, DB_PASSWORD.
      const db = yield* Config.all({
        url: Config.URL("URL"),
        poolSize: Config.Int("POOL_SIZE").pipe(Config.withDefault(10)),
        password: Config.Redacted("PASSWORD")
      }).pipe(Config.nested("DB"))

      const requestTimeout = yield* Config.Duration("REQUEST_TIMEOUT").pipe(
        Config.withDefault(Duration.seconds(30))
      )

      return AppConfig.of({ http, db, requestTimeout })
    })
  )

  // 3. A ready-made test double, so tests need not fake an environment.
  static readonly layerTest = Layer.succeed(AppConfig)(AppConfig.of({
    http: { host: "127.0.0.1", port: 0 },
    db: { url: new URL("postgres://localhost/test"), poolSize: 1, password: Redacted.make("test") },
    requestTimeout: Duration.seconds(1)
  }))
}

// 4. A consumer depends on the service, never on the environment. R = AppConfig.
export class Db extends Context.Service<Db, {
  readonly describe: Effect.Effect<string>
}>()("app/Db") {
  static readonly layer = Layer.effect(
    Db,
    Effect.gen(function*() {
      const { db } = yield* AppConfig
      return Db.of({
        // The password is a Redacted: it prints as <redacted> if someone logs `db`.
        describe: Effect.succeed(`pool=${db.poolSize} url=${db.url.host} pw=${String(db.password)}`)
      })
    })
  )
}

// 5. Composition root: AppConfig.layer is provided to Db.layer, and the
//    provider (the *source*) is provided to AppConfig.layer. Swap the source
//    here and nowhere else.
const source = ConfigProvider.layer(ConfigProvider.fromEnv({
  env: { DB_URL: "postgres://db.internal:5432/app", DB_PASSWORD: "s3cret", DB_POOL_SIZE: "20" }
}))
const AppLayer = Db.layer.pipe(
  Layer.provide(AppConfig.layer),
  Layer.provide(source)
)

const program = Effect.gen(function*() {
  const db = yield* Db
  return yield* db.describe
})

await Effect.runPromise(program.pipe(Effect.provide(AppLayer))) // => "pool=20 url=db.internal:5432 pw=<redacted>"
// In production drop `source`: the default provider is the process environment.

// A missing required key fails the layer, not the first request.
const broken = Layer.provide(AppConfig.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))
const failure = await Effect.runPromise(Effect.flip(Layer.build(broken).pipe(Effect.scoped)))
failure._tag // => "ConfigError"
failure.message.includes("URL") // => true
```

What to notice: `AppConfig.layer` is `Layer<AppConfig, ConfigError>`, so the
error appears in the *type* of your application layer and `NodeRuntime.runMain`
(see [platform](../platform/guide.md)) reports it and exits non-zero. `Config.Redacted` plus
`Redacted.value(...)` at the single call site that needs the raw string keeps
the secret out of logs and error messages.

### Layering sources: env over `.env` over defaults

`layerAdd(x)` reads the provider already in context and adds `x` as a
*fallback*, so build the chain from the lowest precedence outwards: each
`Layer.provide` feeds the previous provider to the next `layerAdd`.

```ts
import { Config, ConfigProvider, Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"

const defaults = ConfigProvider.fromUnknown({ HOST: "localhost", PORT: 3000 })

// An optional .env: a missing file degrades to an empty provider.
const dotenv = ConfigProvider.fromDotEnv({ path: ".env" }).pipe(
  Effect.orElseSucceed(() => ConfigProvider.fromUnknown({}))
)

// process env (the default provider) -> + .env -> + literal defaults
const Sources = ConfigProvider.layerAdd(defaults).pipe(
  Layer.provide(ConfigProvider.layerAdd(dotenv).pipe(Layer.provide(NodeFileSystem.layer)))
)

const program = Config.all({ host: Config.String("HOST"), port: Config.Port("PORT") }).pipe(
  Effect.flatMap((c) => Effect.log(`listening on ${c.host}:${c.port}`))
)

await Effect.runPromise(program.pipe(Effect.provide(Sources)))
```

`layerAdd(x, { asPrimary: true })` makes `x` win instead of acting as the
fallback. `Layer.mergeAll` of two `layerAdd`s does **not** chain them (siblings
do not see each other). See [references/providers.md](providers.md)
for camelCase keys, `fromDir`, custom providers and precedence details, and
[references/api-cheatsheet.md](api-cheatsheet.md) for every
constructor and combinator.

## Anti-patterns

1. **Reading `process.env` in domain code.** No parsing, no typed failure, and
   tests must mutate global state.
   ```ts skip
   const timeout = Number(process.env.TIMEOUT_MS ?? 5000)
   ```
   ```ts
   import { Config, Duration } from "effect"
   export const timeout = Config.Duration("TIMEOUT").pipe(Config.withDefault(Duration.seconds(5)))
   ```
2. **A default on a credential.** `withDefault("dev-key")` means a forgotten
   variable in production silently uses a known key. Required secrets have no
   default; make absence fail the startup layer.
3. **Expecting a default to rescue a malformed value.** `PORT=abc` is not
   absent; `withDefault` does not apply and you get a `ConfigError`. That is the
   point. If you really want a fallback on bad input, say so with `Config.orElse`
   and log it.
4. **Re-reading `Config` per request.** Each `yield* config` re-runs the parse
   against the provider; behaviour can differ between requests and a bad value
   becomes a request-time failure. Read in a Layer and inject the service.
5. **Putting the provider next to, not under, the layer that reads it.**
   `Layer.mergeAll(AppConfig.layer, ConfigProvider.layer(p))` builds
   `AppConfig` with the *default* environment; sibling layers do not feed each
   other. Use `AppConfig.layer.pipe(Layer.provide(ConfigProvider.layer(p)))`.
6. **Assuming `""` is a value.** An empty variable is treated as missing, so
   `DB_URL=` reports "missing" and `PORT=` silently takes the default. If the
   empty string is meaningful, build the provider with
   `{ preserveEmptyStrings: true }`.
7. **Logging the config object or unwrapping early.** `Config.Redacted` protects
   you only while the value stays `Redacted`. Call `Redacted.value` at the one
   place that needs the raw string, and never put it in a log annotation.
8. **v3 names.** `Config.string("X")`, `Config.integer`, `Config.secret`,
   `Config.withDescription`, `Effect.withConfigProvider` and
   `Layer.setConfigProvider` do not exist. Use `Config.String`, `Config.Int`,
   `Config.Redacted`, and `ConfigProvider.layer` / `layerAdd`.

## Testing it

The provider is the seam: give the code under test an in-memory provider (or
the `layerTest` double) and assert on values and on the typed failure. This
compiles and runs without any test framework:

```ts import.meta.vitest name="references/config/guide.md#4"
import assert from "node:assert/strict"
import { Config, ConfigProvider, Context, Effect, Layer, Redacted } from "effect"

class Settings extends Context.Service<Settings, {
  readonly port: number
  readonly token: Redacted.Redacted
}>()("app/Settings") {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function*() {
      const port = yield* Config.Port("PORT").pipe(Config.withDefault(8080))
      const token = yield* Config.Redacted("TOKEN")
      return Settings.of({ port, token })
    })
  )
}

// Build the layer against a fixed, in-memory source.
const withEnv = (env: Record<string, string>) =>
  Settings.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))

const read = Settings.use((s) => Effect.succeed(s))

const test = Effect.gen(function*() {
  // present + defaulted
  const ok = yield* read.pipe(Effect.provide(withEnv({ TOKEN: "t0k" })))
  assert.equal(ok.port, 8080)
  assert.equal(Redacted.value(ok.token), "t0k")
  assert.equal(String(ok.token), "<redacted>")

  // missing required key: a typed ConfigError at layer build time
  const missing = yield* read.pipe(Effect.provide(withEnv({})), Effect.flip)
  assert.equal(missing._tag, "ConfigError")
  assert.match(missing.message, /TOKEN/)

  // malformed value is NOT rescued by the default
  const bad = yield* read.pipe(Effect.provide(withEnv({ TOKEN: "x", PORT: "abc" })), Effect.flip)
  assert.equal(bad._tag, "ConfigError")
  assert.match(bad.message, /PORT/)

  // empty string counts as absent, so the default applies
  const empty = yield* read.pipe(Effect.provide(withEnv({ TOKEN: "x", PORT: "" })))
  assert.equal(empty.port, 8080)
})

await Effect.runPromise(test)
```

With `@effect/vitest` (not installed here) the same body goes inside
`it.effect("...", () => Effect.gen(function*() { ... }))`; to test code that
merely *consumes* configuration, skip the provider and provide
`AppConfig.layerTest` instead.

## Boundaries

- [schema](../schema/guide.md): each `Config.*` constructor is `Config.schema(<Schema>)`;
  to parse something custom write a Schema (with `.check`) and pass it to
  `Config.schema(schema, name)`. Parse errors are `SchemaError`s inside
  `ConfigError`.
- [services](../services/guide.md): `AppConfig` is an ordinary `Context.Service` built by a
  `Layer.effect`; the layer ordering rules (`Layer.provide` vs `mergeAll`)
  apply. Pools, clients and servers are built from `AppConfig`, not from `Config`.
- [core](../core/guide.md): `ConfigError` is a typed startup failure; map or report it at
  the run edge (`NodeRuntime.runMain` from [platform](../platform/guide.md)).
- [data](../data/guide.md): `Redacted` (secret wrapper), `Option` (`Config.option`),
  `Duration` parsing.
- [platform](../platform/guide.md): `FileSystem` / `Path` layers needed by `fromDotEnv` and
  `fromDir`, and the process entrypoint.
- [testing](../testing/guide.md): running `Effect` tests, test layers.

## Changed in 4.1

- `.env` interpolation (`expandVariables: true` on `ConfigProvider.fromDotEnvContents` / `fromDotEnv`; still off by default) was rewritten. References expand left to right, defaults may nest (`${MISSING:-${A}}`), and a cyclic reference (`A=${B}`, `B=${A}`) expands to the empty string, which then counts as absent, instead of recursing.
- `Config.orElse` now falls back only when the primary config *fails* with a `ConfigError` (missing, invalid or unreadable value). A defect or an interruption in the primary config propagates instead of being swallowed.
- `Config.Record(..., { trim, keepEmptyValues })` can trim `k = v` pairs and keep `k=` entries as `""` instead of dropping them.
- Provider read failures inside `Config.schema` still surface as `ConfigError`; the internal change only keeps cause annotations, so there is nothing to migrate.

```ts import.meta.vitest name="references/config/guide.md#5"
import { Config, ConfigProvider, Effect, Schema } from "effect"

const dotenv = ConfigProvider.fromDotEnvContents(
  "A=one\nB=${A}-${MISSING:-${A}}\nX=${Y}\nY=${X}\nZ=${X:-fallback}",
  { expandVariables: true }
)
const read = (key: string) => Effect.runPromise(Config.String(key).parse(dotenv))

await read("B") // => "one-one"
await read("Z") // => "fallback"

// A bad value is a ConfigError, so orElse recovers; a defect is not recoverable.
const empty = ConfigProvider.fromUnknown({})
const withFallback = Config.String("HOST").pipe(Config.orElse(() => Config.succeed("localhost")))
await Effect.runPromise(withFallback.parse(empty)) // => "localhost"

const boom = Config.String("HOST").pipe(Config.mapEffect(() => Effect.die("boom")))
const recovered = boom.pipe(Config.orElse(() => Config.succeed("localhost")))
const exit = await Effect.runPromiseExit(recovered.parse(ConfigProvider.fromUnknown({ HOST: "h" })))
exit._tag // => "Failure"

// trim + keepEmptyValues on Config.Record.
const labels = Config.Record(Schema.String, Schema.String, "LABELS", { trim: true, keepEmptyValues: true })
await Effect.runPromise(labels.parse(ConfigProvider.fromUnknown({ LABELS: " a = 1 , b= " }))) // => { a: "1", b: "" }
```

## References

- [references/providers.md](providers.md): sources, precedence, camelCase, secrets directory, custom providers
- [references/api-cheatsheet.md](api-cheatsheet.md): every Config / ConfigProvider export with verified notes
- [Config API](https://effect.website/docs/v4/api/effect/Config)
- [ConfigProvider API](https://effect.website/docs/v4/api/effect/ConfigProvider)
- [Redacted API](https://effect.website/docs/v4/api/effect/Redacted)
- [Pinned Config source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Config.ts)
- [Pinned ConfigProvider source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/ConfigProvider.ts)
