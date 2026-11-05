# Effect SQL

## How to think about it

A database is the most hostile boundary your program has. Every row that comes
back is `unknown`, every query can fail for reasons the caller cannot fix
(connection lost, deadlock, constraint violated), and every connection is a
leased resource. Effect SQL gives each of those facts a place in the type:

- `sql` is a **template tag that builds a `Statement`**, which *is* an
  `Effect<ReadonlyArray<Row>, SqlError>`. Nothing runs until you `yield*` it.
  Every `${value}` in the template becomes a bound parameter, never text.
- The `SqlClient` is a **service** (`R`). Domain code asks for it; a Layer from
  an adapter package (`@effect/sql-pglite`, `@effect/sql-pg`,
  `@effect/sql-sqlite-node`, ...) provides it and owns the pool/connection
  scope. Swapping the adapter does not change the query code.
- `SqlSchema` is the **decode boundary**: it encodes the request with a Schema,
  runs your query, and decodes `unknown` rows into domain types. A cast
  (`rows[0] as User`) proves nothing; `SqlSchema.findOne` proves it.
- `sql.withTransaction(effect)` is a **scope around an Effect**, not a
  connection you pass around. Any statement run inside it, on any fiber it
  forks, joins the same transaction; failure, defect, or interruption rolls it
  back.

If you come from Express + an ORM or `pg`: there is no `client.query(text,
params)` and no `try { BEGIN ... COMMIT } catch { ROLLBACK }`. You do not pass a
`tx` handle; the transaction is ambient in the Effect context. You also do not
let `SqlError` leak to callers: your service translates the three or four
database outcomes callers can act on (not found, duplicate, insufficient funds)
into tagged domain errors and turns everything else into a defect.

## Choose

| Situation | Use | Why / when not |
| --- | --- | --- |
| One-off statement, rows you only log | `` sql`...` `` | Rows are untyped; do not return them from a service |
| Query whose rows become domain values | `SqlSchema.findAll / findOne / findOneOption / findNonEmpty` | Encodes request, decodes rows, typed `SchemaError` |
| Statement whose result you ignore | `SqlSchema.void` | Still encodes the request |
| Plain CRUD on one table | `SqlModel.makeRepository` + `Model.Class` | Derives insert/update/findById/delete; not for joins or filters |
| Many concurrent lookups by key (N+1) | `SqlResolver.findById / grouped / ordered / void` | Batches one `WHERE id IN (...)` per tick |
| Several writes that commit together | `sql.withTransaction(effect)` | One boundary per use case, not per statement |
| Millions of rows | `` sql`...`.stream `` (a `Stream<Row, SqlError>`) | Never `yield*` an unbounded table into an array |
| Dynamic filters / bulk insert / `IN` list | `sql.and`, `sql.or`, `sql.in`, `sql.insert`, `sql.update`, `sql.csv` | Parameterized by construction |
| Dynamic table or column name | `sql(name)` identifier, from a closed set | Identifiers are quoted, but you must still allowlist them |
| Schema changes | `<Adapter>Migrator.layer({ loader })` | Runs once, ordered, recorded in a table |
| Relational data across services | not this skill | See Boundaries |
| Durable queue/log with no relational queries | [persistence](../persistence/guide.md) | A KV store is simpler than a table |

## Recipe

### The pitfall: a Promise-shaped repository

```ts skip
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Wrong in four ways: injection (unsafe takes raw text), an unchecked cast,
// two writes that can half-apply, and nothing in the type says it can fail.
export const transfer = (from: string, to: string, cents: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql.unsafe(`SELECT * FROM accounts WHERE id = '${from}'`)
    const src = rows[0] as { balance_cents: number }
    if (src.balance_cents < cents) throw new Error("insufficient funds")
    yield* sql`UPDATE accounts SET balance_cents = balance_cents - ${cents} WHERE id = ${from}`
    yield* sql`UPDATE accounts SET balance_cents = balance_cents + ${cents} WHERE id = ${to}`
  })
```

### The idiomatic version: a `Ledger` service

One file you can run. It shows the full shape: Schema for rows and requests,
tagged domain errors, migrations in the Layer, a service whose methods hide
`SqlClient`, a transaction around the use case, and a single provide.

```ts import.meta.vitest name="references/sql/guide.md#2"
import { PgliteClient, PgliteMigrator } from "@effect/sql-pglite"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"

// --- Domain types -----------------------------------------------------------

export const AccountId = Schema.String.pipe(Schema.brand("AccountId"))
export type AccountId = typeof AccountId.Type

// Column names are snake_case in the table, so the row schema uses them as-is.
// (Use the adapter's transformResultNames/transformQueryNames to map to
// camelCase globally instead; see references/api.md.)
export class Account extends Schema.Class<Account>("Account")({
  id: AccountId,
  owner: Schema.String,
  balance_cents: Schema.Int
}) {}

// Expected failures a caller can branch on. Everything else is a defect.
export class AccountNotFound extends Schema.TaggedError<AccountNotFound>()("AccountNotFound", {
  id: AccountId
}) {}
export class AccountExists extends Schema.TaggedError<AccountExists>()("AccountExists", {
  id: AccountId
}) {}
export class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()("InsufficientFunds", {
  id: AccountId,
  balance_cents: Schema.Int
}) {}

// --- Database layer: client + migrations, assembled once ---------------------

// A migration is an Effect<void, _, SqlClient> keyed "<number>_<name>". They
// run in numeric order inside the layer's build, so anything that depends on
// `Database` sees a migrated schema. A failing migration fails the layer with a
// typed `MigrationError` (4.1; it was a defect in 4.0).
const Migrations = PgliteMigrator.layer({
  loader: PgliteMigrator.fromRecord({
    "0001_accounts": Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        CREATE TABLE accounts (
          id text PRIMARY KEY,
          owner text NOT NULL,
          balance_cents integer NOT NULL CHECK (balance_cents >= 0)
        )`
    })
  })
})

// provideMerge keeps SqlClient in the output so the service layer can use it.
// PgliteClient.layer({}) is an in-memory Postgres: a fresh one per layer build.
export const Database = Migrations.pipe(Layer.provideMerge(PgliteClient.layer({})))

// --- Service ---------------------------------------------------------------

export class Ledger extends Context.Service<Ledger, {
  open(id: AccountId, owner: string, cents: number): Effect.Effect<void, AccountExists>
  balance(id: AccountId): Effect.Effect<number, AccountNotFound>
  transfer(from: AccountId, to: AccountId, cents: number): Effect.Effect<void, AccountNotFound | InsufficientFunds>
}>()("app/Ledger") {
  // `layerNoDb` states its real requirement (SqlClient) in R; `layer` closes it.
  static readonly layerNoDb = Layer.effect(
    Ledger,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      // Each query is built once. Request is encoded, rows are decoded.
      const insert = SqlSchema.void({
        Request: Schema.Struct({ id: AccountId, owner: Schema.String, cents: Schema.Int }),
        execute: ({ id, owner, cents }) =>
          // sql.insert builds "(id, owner, balance_cents) VALUES ($1, $2, $3)"
          sql`INSERT INTO accounts ${sql.insert({ id, owner, balance_cents: cents })}`
      })
      const find = SqlSchema.findOne({
        Request: AccountId,
        Result: Account,
        execute: (id) => sql`SELECT * FROM accounts WHERE id = ${id}`
      })
      // FOR UPDATE: lock the row for the rest of the transaction so two
      // concurrent transfers cannot both pass the balance check.
      const lock = SqlSchema.findOne({
        Request: AccountId,
        Result: Account,
        execute: (id) => sql`SELECT * FROM accounts WHERE id = ${id} FOR UPDATE`
      })
      const adjust = SqlSchema.void({
        Request: Schema.Struct({ id: AccountId, delta: Schema.Int }),
        execute: ({ id, delta }) =>
          sql`UPDATE accounts SET balance_cents = balance_cents + ${delta} WHERE id = ${id}`
      })

      const open = Effect.fn("Ledger.open")(function*(id: AccountId, owner: string, cents: number) {
        yield* insert({ id, owner, cents }).pipe(
          // SqlError carries a structured `reason`. Translate the one reason
          // the caller can act on; the remaining SqlError (connection, syntax)
          // and SchemaError are outages or bugs, not domain outcomes.
          Effect.catchReason("SqlError", "UniqueViolation", () => Effect.fail(new AccountExists({ id }))),
          Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die })
        )
      })

      const balance = Effect.fn("Ledger.balance")(function*(id: AccountId) {
        const account = yield* find(id).pipe(
          // NoSuchElementError is what findOne raises for "no row".
          Effect.catchTag("NoSuchElementError", () => Effect.fail(new AccountNotFound({ id }))),
          Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die })
        )
        return account.balance_cents
      })

      const transfer = Effect.fn("Ledger.transfer")(
        function*(from: AccountId, to: AccountId, cents: number) {
          // Lock in a fixed order (by id) to avoid deadlocks between A->B and B->A.
          const [first, second] = from < to ? [from, to] : [to, from]
          const a = yield* lock(first).pipe(
            Effect.catchTag("NoSuchElementError", () => Effect.fail(new AccountNotFound({ id: first })))
          )
          const b = yield* lock(second).pipe(
            Effect.catchTag("NoSuchElementError", () => Effect.fail(new AccountNotFound({ id: second })))
          )
          const source = a.id === from ? a : b
          if (source.balance_cents < cents) {
            // A typed failure inside the transaction rolls it back.
            return yield* new InsufficientFunds({ id: from, balance_cents: source.balance_cents })
          }
          yield* adjust({ id: from, delta: -cents })
          yield* adjust({ id: to, delta: cents })
        },
        // The transaction wraps the whole use case, including the checks.
        (self) => sql.withTransaction(self),
        // SqlError / SchemaError remain possible here: now they are defects.
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die })
      )

      return Ledger.of({ open, balance, transfer })
    })
  )

  static readonly layer = this.layerNoDb.pipe(Layer.provide(Database))
}

// --- Use it ------------------------------------------------------------------

const program = Effect.gen(function*() {
  const ledger = yield* Ledger
  const ada = Schema.decodeSync(AccountId)("ada")
  const bob = Schema.decodeSync(AccountId)("bob")
  yield* ledger.open(ada, "Ada", 100)
  yield* ledger.open(bob, "Bob", 0)
  yield* ledger.transfer(ada, bob, 30)
  const tooMuch = yield* ledger.transfer(ada, bob, 500).pipe(Effect.flip)
  return { failure: tooMuch._tag, ada: yield* ledger.balance(ada), bob: yield* ledger.balance(bob) }
})

// Provide once, run once.
const out = await Effect.runPromise(program.pipe(Effect.provide(Ledger.layer)))
out // => { failure: "InsufficientFunds", ada: 70, bob: 30 }
```

Read the design off the signatures. `transfer` can fail with exactly two
things a caller can handle. Its `R` is empty because `Ledger.layer` closed
over the database. Nothing outside this file knows SQL exists, so a test can
replace the whole service with `Ref` state or swap the adapter for another.

### Side effects that must follow a commit: `sql.afterCommit`

Notify, invalidate or wake workers only after the data is durable.
`sql.afterCommit(effect)` runs once the *outermost* transaction commits, and is
discarded on rollback. Outside a transaction it runs immediately.

```ts import.meta.vitest name="references/sql/guide.md#3"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Ref } from "effect"
import { SqlClient } from "effect/sql"

const program = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const notified = yield* Ref.make<ReadonlyArray<string>>([])
  yield* sql`CREATE TABLE jobs (id integer PRIMARY KEY)`

  const enqueue = (id: number, fail: boolean) =>
    sql.withTransaction(Effect.gen(function*() {
      yield* sql`INSERT INTO jobs ${sql.insert({ id })}`
      yield* sql.afterCommit(Ref.update(notified, (all) => [...all, `job ${id} ready`]))
      if (fail) return yield* Effect.fail("rollback")
    }))

  yield* enqueue(1, true).pipe(Effect.ignore) // rolled back: no insert, no notification
  yield* enqueue(2, false)
  const rows = yield* sql<{ id: number }>`SELECT id FROM jobs`
  return { ids: rows.map((r) => r.id), notified: yield* Ref.get(notified) }
}).pipe(Effect.provide(PgliteClient.layer({})))

const out = await Effect.runPromise(program)
out // => { ids: [2], notified: ["job 2 ready"] }
```

Callbacks are lost if the process dies first, so work that must happen belongs
in a table written in the same transaction (an outbox).

### More recipes

Dynamic filters with `sql.and`/`sql.in`, `SqlResolver.findById` to kill N+1
queries, and streaming rows are worked through in
[references/examples.md](examples.md).

## Anti-patterns

**Concatenating values into SQL text.** Consequence: injection.

```ts skip
yield* sql.unsafe(`SELECT * FROM users WHERE name = '${name}'`)
```

Right: ``yield* sql`SELECT * FROM users WHERE name = ${name}` ``. Use `sql.unsafe`
only for text you wrote; use `sql(identifier)` for a name chosen from an
allowlist.

**Casting rows.** `rows[0] as User` compiles and lies when a column is null or
renamed. Right: `SqlSchema.findOne({ Request, Result: User, execute })`, which
fails with `SchemaError` at the boundary.

**Letting `SqlError` into the domain.** A signature of
`Effect<User, SqlError>` forces every caller to know what a constraint is.
Right: catch `UniqueViolation` with `Effect.catchReason("SqlError",
"UniqueViolation", ...)`, map "no row" to a tagged `NotFound`, `Effect.orDie`
the rest at the edge of the service implementation.

**One transaction per statement, or none around a read-check-write.**

```ts skip
const row = yield* find(id)                    // read
if (row.balance_cents >= cents) yield* debit() // write: another fiber may have spent it
```

Consequence: lost updates. Right: put the check and the writes in one
`sql.withTransaction`, and lock the rows you check (`FOR UPDATE`) or use a
conditional `UPDATE ... WHERE balance_cents >= ${cents}`.

**Retrying inside a transaction, or retrying a non-idempotent one.** Retrying
a single statement after a deadlock leaves the transaction already aborted.
Right: wrap the *whole* `sql.withTransaction(...)` and retry only on
`DeadlockError` / `SerializationError` reasons (`error.isRetryable` also admits
`ConnectionError`, which is unsafe around a `COMMIT`). Each attempt starts a fresh transaction. This runnable
version simulates a deadlock on the first attempt (a real driver raises the
same `DeadlockError` reason) and shows the first attempt's write is gone:

```ts import.meta.vitest name="references/sql/guide.md#4"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Ref } from "effect"
import { SqlClient, SqlError } from "effect/sql"

const program = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE audit (note text NOT NULL)`
  const attempts = yield* Ref.make(0)

  const use = sql.withTransaction(Effect.gen(function*() {
    const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
    yield* sql`INSERT INTO audit ${sql.insert({ note: `attempt ${attempt}` })}`
    if (attempt === 1) {
      return yield* new SqlError.SqlError({ reason: new SqlError.DeadlockError({ cause: "simulated" }) })
    }
  }))

  yield* use.pipe(Effect.retry({
    while: (e) => e.reason._tag === "DeadlockError" || e.reason._tag === "SerializationError",
    times: 3
  }))
  const notes = yield* sql<{ note: string }>`SELECT note FROM audit`
  return notes.map((row) => row.note)
}).pipe(Effect.provide(PgliteClient.layer({})))

const notes = await Effect.runPromise(program)
notes // => ["attempt 2"]
```

Only retry whole transactions that are safe to re-run (the callbacks you gave
to `afterCommit` are dropped with a failed attempt, but other side effects are
not), and never retry `ConnectionError` around a `COMMIT` (it may have
committed). To start the
transaction with another statement, e.g. `SERIALIZABLE`, provide
`SqlClient.BeginTransaction` (see 4.1 below).

**Calling `Effect.provide(SqlLayer)` per query/request.** Each provide builds a
new pool (and re-runs migrations). Right: build `Database` once in the layer
graph; services depend on `SqlClient` via `Layer.provide` at the root.

**Loading a whole table to map it.** `yield* sql`SELECT * FROM events`` holds
every row in memory. Right: ``sql`...`.stream`` with `Stream.mapEffect` /
`Stream.grouped`, or paginate with keyset conditions.

**Per-item queries in a loop.** `Effect.forEach(ids, find)` issues N queries.
Right: one `sql.in("id", ids)` query, or `SqlResolver.findById` so callers stay
simple and batching is automatic.

**Running migrations from request handlers.** Right: put the migrator layer
in the root layer (or a dedicated deploy command). Its first statement takes a
table lock on Postgres, so concurrent instances serialize instead of racing.

## Testing it

Test against a real engine, not a mock of SQL. `PgliteClient.layer({})` is an
in-memory Postgres compiled to WASM: each layer build is an isolated, empty
database, with no network and no cleanup. Because the service closes over the
layer, the test only provides what production provides.

```ts import.meta.vitest name="references/sql/guide.md#6"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import assert from "node:assert/strict"

const Row = Schema.Struct({ n: Schema.Int })

const test = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE t (n integer PRIMARY KEY)`

  // 1. A transaction that fails rolls everything back.
  yield* sql.withTransaction(
    Effect.gen(function*() {
      yield* sql`INSERT INTO t ${sql.insert({ n: 1 })}`
      return yield* Effect.fail("boom")
    })
  ).pipe(Effect.ignore)
  const count = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Row,
    execute: () => sql`SELECT count(*)::int AS n FROM t`
  })
  assert.equal((yield* count()).n, 0)

  // 2. Constraint violations arrive as structured reasons, not strings.
  yield* sql`INSERT INTO t ${sql.insert({ n: 1 })}`
  const outcome = yield* sql`INSERT INTO t ${sql.insert({ n: 1 })}`.pipe(
    Effect.catchReason("SqlError", "UniqueViolation", () => Effect.succeed("duplicate" as const))
  )
  assert.equal(outcome, "duplicate")
})

// Fresh database per run: provide the layer where the test is run.
await Effect.runPromise(test.pipe(Effect.provide(PgliteClient.layer({}))))
```

With `@effect/vitest`, `it.effect` runs each case as an Effect and
`layer(...)` builds the database once for a `describe` block (each `it` shares
it, so give tests distinct tables or ids). This is a real test file, typechecked
with the other snippets and run with `vitest`:

```ts
import { PgliteClient } from "@effect/sql-pglite"
import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

layer(PgliteClient.layer({}))("accounts table", (it) => {
  it.effect("rolls back a failed transfer", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE acct (id text PRIMARY KEY, cents integer NOT NULL CHECK (cents >= 0))`
      yield* sql`INSERT INTO acct ${sql.insert({ id: "ada", cents: 100 })}`

      // The debit succeeds, then the CHECK constraint rejects the second one.
      const failed = yield* sql.withTransaction(
        Effect.gen(function*() {
          yield* sql`UPDATE acct SET cents = cents - 60 WHERE id = 'ada'`
          yield* sql`UPDATE acct SET cents = cents - 60 WHERE id = 'ada'`
        })
      ).pipe(Effect.catchReason("SqlError", "ConstraintError", () => Effect.succeed("rolled back")))

      const rows = yield* sql<{ cents: number }>`SELECT cents FROM acct WHERE id = 'ada'`
      expect(failed).toBe("rolled back")
      expect(rows[0]?.cents).toBe(100)
    }))
})
```

For use-case tests that do not care about SQL, give the service an in-memory
`layerMemory` (a `Ref` of a `Map`) next to `layer`, as in the entry skill.

## Boundaries

- [schema](../schema/guide.md): owns `Schema`, `Schema.Class`, brands, and `Model.Class`
  variants. SQL only supplies unknown rows and consumes codecs.
- [services](../services/guide.md): owns `Context.Service`, `Layer.provide`/`provideMerge`
  and scopes. The client's pool lives in the adapter Layer's scope.
- [core](../core/guide.md): owns `Effect.catchTag`, `catchReason`, `orDie`, `retry`. This
  skill only says *which* failures to type.
- [streams](../streams/guide.md): owns `Stream` operators used on `.stream`.
- [http-api](../http-api/guide.md) / [rpc](../rpc/guide.md): map your domain errors (`AccountNotFound`)
  to status codes or RPC errors; do not let `SqlError` reach them.
- [persistence](../persistence/guide.md): key-value and queue storage, not relational queries.
- [workflow](../workflow/guide.md) / [cluster](../cluster/guide.md): durable multi-step processes; keep
  transactions *inside* one activity, never across one.
- [testing](../testing/guide.md): the general Layer-swap test strategy.

Errors cross at the service boundary: `SqlError`/`SchemaError` in, domain tags
(or defects) out. Resources cross at the Layer: the client's scope is the
application's scope.

## Changed in 4.1

- `sql.afterCommit(effect)`: run notifications after the outermost commit
  (recipe above); `withTransaction` also defers `Reactivity` invalidation until
  commit and drops it on rollback.
- `SqlClient.BeginTransaction` service: choose the `BEGIN` statement (isolation
  level) for top-level transactions; wrap the outermost `withTransaction` in
  `Effect.retry` for deadlocks and serialization failures.
- `sql.driver` names the adapter (`"pglite"`, `"pg"`, `"sqlite-node"`, ...).
- `Migrator.fromFileSystem` lives in `effect/sql/MigratorFileSystem`; import
  it through your adapter's migrator module. Failed migrations are a typed
  `MigrationError`.
- `sql.in("id", [])` and a non-empty-array type on `sql.insert`; see
  [api.md](api.md#changed-in-41-sql).
- `SqlResolver` separates batches per transaction, not per caller service.

## References

- Batching, dynamic filters, streaming: [references/examples.md](examples.md)
- Deeper reference with verified signatures, Model repositories, adapters,
  naming transforms, error reasons:
  [references/api.md](api.md)
- [Effect SQL modules](https://effect.website/docs/v4/api/effect/sql/SqlClient)
- [SqlSchema API](https://effect.website/docs/v4/api/effect/sql/SqlSchema)
- [Statement API](https://effect.website/docs/v4/api/effect/sql/Statement)
- [Pinned SqlSchema source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/sql/SqlSchema.ts)
- [Pinned SqlClient source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/sql/SqlClient.ts)
- [Pinned SqlError source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/sql/SqlError.ts)
