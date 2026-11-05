# Effect SQL: verified reference

Everything here was checked against `effect@4.1.2` sources
(`node_modules/effect/src/sql/*.ts`) and `@effect/sql-pglite@4.1.2`. All of
`effect/sql` is `@stability unstable`: pin `effect` and every `@effect/sql-*`
package to the same exact version.

## Imports

```ts import.meta.vitest name="references/sql/api.md#1"
import { Migrator, SqlClient, SqlConnection, SqlError, SqlModel, SqlResolver, SqlSchema, Statement } from "effect/sql"
import { Model } from "effect/schema"
// Adapter (one of): its client Layer provides both its own Context.Service and SqlClient.SqlClient
// import { PgliteClient, PgliteMigrator } from "@effect/sql-pglite"
// import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"   (used in upstream ai-docs)
```

Other adapter packages named in the upstream ai-docs dependency list:
`@effect/sql-pg`, `@effect/sql-mysql2`, `@effect/sql-mssql`,
`@effect/sql-sqlite-bun`, `@effect/sql-sqlite-wasm`, `@effect/sql-sqlite-do`,
`@effect/sql-sqlite-react-native`, `@effect/sql-libsql`, `@effect/sql-d1`,
`@effect/sql-clickhouse`. Only `sql-pglite` is installed in this repo; check
the installed package's `.d.ts` for the exact client config of any other.

## The `sql` constructor (`SqlClient.SqlClient` extends `Statement.Constructor`)

| Call | Result | Notes |
| --- | --- | --- |
| `` sql`... ${v}` `` | `Statement<Row>` | `${v}` is a bound parameter. A `Statement` is an `Effect<ReadonlyArray<Row>, SqlError>` |
| `` sql<{ id: number }>`...` `` | `Statement<{id:number}>` | Only a type annotation; no runtime check. Prefer `SqlSchema` |
| `sql("table")` | `Identifier` | Quoted identifier, for dynamic names from an allowlist |
| `sql.unsafe(text, params?)` | `Statement` | Raw text. Never put user input in `text` |
| `sql.literal(text)` | `Fragment` | Raw text fragment (e.g. `ASC`) |
| `sql.in(values)` / `sql.in("col", values)` | `ArrayHelper` / `Fragment` | `col IN ($1, $2, ...)` |
| `sql.insert(record \| records)` | `RecordInsertHelper` | `(cols) VALUES (...)`; `.returning("*")` available. An array must be non-empty (`NonEmptyReadonlyArray`) |
| `sql.update(record, omit?)` | helper | `col = $n, ...`, optional keys to omit |
| `sql.updateValues(records, alias)` | helper | Batch update via VALUES |
| `sql.and([...])` / `sql.or([...])` | `Fragment` | Join clauses with parentheses |
| `sql.csv([...])`, `sql.csv("prefix", [...])` | `Fragment` | Comma separated |
| `sql.join(literal, addParens?, fallback?)([...])` | `Fragment` | Generic joiner |
| `sql.onDialect({sqlite,pg,mysql,mssql,clickhouse})` | value | Per-dialect branch (all keys required) |
| `sql.onDialectOrElse({ orElse, pg?, ... })` | value | Per-dialect with fallback |

Statement members: `.stream` (`Stream<Row, SqlError>`), `.raw`, `.values`,
`.unprepared` (no prepared statement; needed for multi-statement text),
`.withoutTransform` (skip name transforms), `.compile()` (returns
`[text, params]`; useful in tests to assert parameterization).

Client members: `sql.driver` (4.1: adapter name such as `"pglite"`, distinct
from the dialect), `sql.afterCommit(effect)` (4.1: runs after the outermost
transaction commits, dropped on rollback, immediate outside one),
`sql.withTransaction(effect)` (start with a different statement by providing
`SqlClient.BeginTransaction`, e.g. `"BEGIN ISOLATION LEVEL SERIALIZABLE"`), `sql.reserve` (scoped
`Connection`), `sql.withoutTransforms()`, `sql.reactive(keys, effect)` and
`sql.reactiveMailbox(keys, effect)` (re-run a query when `Reactivity`
invalidates the keys; see [reactivity](../reactivity/guide.md)).

## SqlSchema (all take `{ Request, Result, execute }`)

| Function | Returns (from `(request) => ...`) |
| --- | --- |
| `findAll` | `Array<Result>`; empty array allowed |
| `findNonEmpty` | `NonEmptyArray<Result>`, fails `NoSuchElementError` when empty |
| `findOne` | first row decoded, fails `NoSuchElementError` when no rows |
| `findOneOption` | `Option<Result>` |
| `void` (no `Result`) | `void`; call as `SqlSchema.void({...})` |

Error channel: `E | SchemaError` (plus `NoSuchElementError` where noted).
`execute` receives the **encoded** request (`Req["Encoded"]`); the function you
get takes the **decoded** `Req["Type"]`. For a no-argument query use
`Request: Schema.Void` and call `query()`. Extra rows beyond the first are
ignored by `findOne`: add `LIMIT 1` or a unique key yourself.

## SqlResolver (batching; each constructor returns a `RequestResolver`, not an Effect)

Call with `SqlResolver.request(payload, resolver)` (or the curried
`SqlResolver.request(resolver)`). Requests issued in the same tick, even from
different fibers, are grouped into one `execute`. Batches are kept separate
per active transaction.

| Constructor | Use when | Result per request |
| --- | --- | --- |
| `ordered({ Request, Result, execute })` | `execute` returns one row per request in order (`INSERT ... RETURNING`) | `Result`; `ResultLengthMismatch` if counts differ |
| `findById({ Id, Result, ResultId, execute })` | lookup by key; `execute(ids)` | `Result`, else `NoSuchElementError` |
| `grouped({ Request, RequestGroupKey, Result, ResultGroupKey, execute })` | one-to-many (all comments for post ids) | `NonEmptyArray<Result>`, `NoSuchElementError` if group empty |
| `void({ Request, execute })` | batched writes | `void` |

## SqlModel and Model

`Model.Class<Self>("Name")({ ...fields })` defines one declaration with
variants: `Self` (select), `Self.insert`, `Self.update`, `Self.json`,
`Self.jsonCreate`, `Self.jsonUpdate`. Field helpers in `effect/schema` `Model`:
`Field({ select, insert, update, json, jsonCreate, jsonUpdate })`,
`FieldOnly([...])`, `FieldExcept([...])`, `GeneratedByDb(schema)` (read-only),
`GeneratedByApp(schema)`, `Sensitive(schema)`, `DateTimeInsert`,
`DateTimeUpdate`, `UuidV4Insert(brand)`, `JsonFromString(schema)`,
`BooleanSqlite`, `optionalOption`, `FieldOption`.

`SqlModel.makeRepository(Model, { tableName, spanPrefix, idColumn, softDeleteColumn? })`
is an Effect needing `SqlClient` and returns `insert`, `insertVoid`, `update`,
`updateVoid`, `findById`, `delete`. `idColumn` must be present in the **update**
variant, so declare the id with `Model.Field({ select, update, json })`
(`GeneratedByDb` omits it from update and will not typecheck). Errors are
`SchemaError | SqlError`, plus `NoSuchElementError` for `findById`.
`SqlModel.makeResolvers` gives batched `insert`, `insertVoid`, `findById`,
`delete` resolvers (needs `Scope`).

```ts import.meta.vitest name="references/sql/api.md#2"
import { PgliteClient, PgliteMigrator } from "@effect/sql-pglite"
import { Effect, Layer, Schema } from "effect"
import { Model } from "effect/schema"
import { SqlClient, SqlModel } from "effect/sql"

export const NoteId = Schema.Int.pipe(Schema.brand("NoteId"))

export class Note extends Model.Class<Note>("Note")({
  // serial primary key: absent from insert (DB assigns it), required in update
  id: Model.Field({ select: NoteId, update: NoteId, json: NoteId }),
  title: Schema.NonEmptyString,
  body: Schema.String,
  createdAt: Model.DateTimeInsert,
  updatedAt: Model.DateTimeUpdate
}) {}

// transformQueryNames/ResultNames map camelCase fields <-> snake_case columns.
const camelToSnake = (s: string) => s.replace(/([A-Z])/g, "_$1").toLowerCase()
const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

const Database = PgliteMigrator.layer({
  loader: PgliteMigrator.fromRecord({
    "0001_notes": Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE notes (
        id serial PRIMARY KEY, title text NOT NULL, body text NOT NULL,
        created_at text NOT NULL, updated_at text NOT NULL)`
    })
  })
}).pipe(
  Layer.provideMerge(PgliteClient.layer({ transformQueryNames: camelToSnake, transformResultNames: snakeToCamel }))
)

const program = Effect.gen(function*() {
  const repo = yield* SqlModel.makeRepository(Note, { tableName: "notes", spanPrefix: "Notes", idColumn: "id" })
  // makeEffect fills createdAt/updatedAt from the Effect Clock (TestClock-friendly)
  const created = yield* Note.insert.makeEffect({ title: "hello", body: "world" }).pipe(
    Effect.flatMap(repo.insert)
  )
  const renamed = yield* Note.update.makeEffect({ id: created.id, title: "hi", body: "world" }).pipe(
    Effect.flatMap(repo.update)
  )
  yield* repo.delete(renamed.id)
  return yield* repo.findById(renamed.id).pipe(Effect.flip) // NoSuchElementError | SchemaError | SqlError
}).pipe(Effect.provide(Database))

const error = await Effect.runPromise(program)
error._tag // => "NoSuchElementError"
```

(`String.camelToSnake` / `String.snakeToCamel` also exist in `effect/String`.)

## Migrator

`PgliteMigrator.layer({ loader, schemaDirectory?, table? })` returns
`Layer<never, MigrationError | SqlError, SqlClient | R>`; each adapter
re-exports `run`, `layer`, and the loaders.

- Loaders: `fromRecord({ "0001_name": effect })`, `fromFileSystem(dir)` (files
  `<id>_<name>.{ts,js,mjs,mts}` whose default export is an Effect; needs
  `FileSystem` + `Path`), `fromGlob`, `fromBabelGlob`. In 4.1 `fromFileSystem`
  moved out of `effect/sql/Migrator` into `effect/sql/MigratorFileSystem`;
  adapter migrators (`PgliteMigrator.fromFileSystem`, ...) still re-export it,
  so import it from the adapter.
- Default table `effect_sql_migrations`. Pending migrations are recorded and
  run inside one `sql.withTransaction`; on Postgres the migrations table is
  locked first, and a concurrent runner that loses the race logs and returns
  `[]` (`MigrationError` kind `"Locked"` is swallowed).
- A migration that fails now fails the layer with `MigrationError { kind: "Failed" }`
  in its error channel (4.0 turned it into a defect).
  Duplicate ids fail `kind: "Duplicates"`.
- Migrations are forward-only. Never edit an applied migration; add a new id.

## SqlError

`SqlError` is `Schema.TaggedError` with one field, `reason: SqlErrorReason`.
`reason._tag` is one of: `ConnectionError`, `AuthenticationError`,
`AuthorizationError`, `SqlSyntaxError`, `UniqueViolation` (has `.constraint`),
`ConstraintError`, `DeadlockError`, `SerializationError`, `LockTimeoutError`,
`StatementTimeoutError`, `UnknownError`. Each reason has `cause`, optional
`message`/`operation`, and `isRetryable`; `SqlError.isRetryable` delegates. The
retryable reasons are `ConnectionError`, `DeadlockError`, `SerializationError`,
`LockTimeoutError` and `StatementTimeoutError`; the rest (auth, syntax, unique,
constraint, unknown) are not. A `ConnectionError` is only safe to retry for
statements that did not reach the server or are idempotent (see the retry
anti-pattern in the guide).

```ts import.meta.vitest name="references/sql/api.md#3"
import { PgliteClient } from "@effect/sql-pglite"
import { Data, Effect } from "effect"
import { SqlClient } from "effect/sql"

class Duplicate extends Data.TaggedError("Duplicate")<{ readonly constraint: string }> {}
class Retry extends Data.TaggedError("Retry") {}

const program = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE users (email text CONSTRAINT users_email_key UNIQUE)`
  yield* sql`INSERT INTO users ${sql.insert({ email: "ada@example.com" })}`
  return yield* sql`INSERT INTO users ${sql.insert({ email: "ada@example.com" })}`.pipe(
    Effect.catchReasons("SqlError", {
      UniqueViolation: (reason) => Effect.fail(new Duplicate({ constraint: String(reason.constraint) })),
      DeadlockError: () => Effect.fail(new Retry())
    }),
    Effect.flip
  )
}).pipe(Effect.provide(PgliteClient.layer({})))

const error = await Effect.runPromise(program)
error._tag // => "Duplicate"
```

Also exported: `isSqlError`, `isSqlErrorReason`, `ResultLengthMismatch`.

## Adapter configuration (PgliteClient, verified)

`PgliteClient.layer(config?)`, `layerConfig(Config.Wrap<...>)`, `make`,
`fromClient({ liveClient })`. Base options: `spanAttributes`,
`transformResultNames`, `transformQueryNames`, `transformJson`. Also exposes
`.listen(channel)` (scoped queue), `.notify`, `.json(value)` fragment. Other
adapters follow the same `layer` / `layerConfig` / `make` naming; read their
`.d.ts` for connection options. Use `layerConfig` so connection strings come
from `Config` (typed startup error if missing), not `process.env`.

## Reading the types

- `Effect<A, SqlError>` from a plain statement; `E | SchemaError` from SqlSchema;
  add `NoSuchElementError` for `findOne`/`findNonEmpty`/`findById`.
- `R` on a query function is `SqlClient` only if you built the statement with
  the `sql` you yielded from `SqlClient`; a statement already holds its
  client, so the *function* has no `R` once built. That is why you `yield*
  SqlClient.SqlClient` at layer-construction time and keep services free of `R`.
- `Request["EncodingServices"]` / `Result["DecodingServices"]` leak into `R` if
  a Schema needs services; normally `never`.

## Changed in 4.1 (SQL)

- `SqlClient.afterCommit`, `SqlClient.driver`, `SqlClient.BeginTransaction`
  (see above); `withTransaction` defers `Reactivity.invalidate`/`mutation` to
  the outermost commit.
- `Migrator.fromFileSystem` moved to `effect/sql/MigratorFileSystem`; a failed
  migration is a typed `MigrationError`; `Migrator.make` accepts
  `transformWrites`; ClickHouse migrations run without a transaction.
  On Postgres the migrations table is checked with `to_regclass` before
  creation.
- `sql.in("col", [])` is safe: `IN ()` renders a match-nothing clause per
  dialect (`= ANY('{}')` on Postgres).
- `sql.insert` / `updateValues` take non-empty arrays at the type level.
- Statement/Segment type ids are exported (`Statement.FragmentTypeId`,
  `SegmentTypeId`, 4.1.1); `Statement.spanTarget` (4.0.1) derives the span
  target. With tracing, connection wait time is recorded as
  `db.client.connection.wait_time_ms`.
- `SqlResolver` batches are separated by the active transaction (of the request's
  client or `makeWithTransaction`), but not by other services: use separate
  resolvers per tenant.
