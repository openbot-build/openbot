---
compatibility: Examples target effect@4.0.0; align @effect/* packages. Effect v3 requires migration.
description: Use when selecting an Effect SQL adapter or implementing parameterized queries, transactions, migrations, and schema-checked database rows.
metadata:
  github-path: skills/effect-sql
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: db8c646361bb84313786b68cbd7e1e009594eca3
name: effect-sql
---

# Effect SQL

Use effect/sql for the database-independent contract and choose an adapter
package such as @effect/sql-pg, @effect/sql-mysql2, @effect/sql-mssql,
@effect/sql-sqlite-node, @effect/sql-sqlite-bun, @effect/sql-sqlite-wasm,
@effect/sql-sqlite-do, @effect/sql-sqlite-react-native, @effect/sql-libsql,
@effect/sql-pglite, @effect/sql-d1, or @effect/sql-clickhouse. The core
modules include SqlClient, SqlConnection, Statement, SqlSchema, SqlModel,
SqlResolver, SqlStream, SqlError, and Migrator.

## Establish the adapter and Scope

Read the lockfile first and choose the adapter that matches the runtime and
database. Construct one scoped SqlClient Layer per application or worker
lifecycle. Keep migrations and transactions out of request-level ad hoc
connection creation.

```ts
import { Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

const UserId = Schema.Struct({ id: Schema.String });
const User = Schema.Struct({ id: Schema.String, name: Schema.String });

const findUser = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = SqlSchema.findOne({
      Request: UserId,
      Result: User,
      execute: (request) =>
        sql`SELECT id, name FROM users WHERE id = ${request.id}`,
    });
    return yield* query({ id });
  });
```

Verify the current SqlSchema signature and SQL tag behavior in the installed
adapter. Interpolation inside the tagged `sql\`...\`` template is parameterized
by the adapter; never concatenate user input into an untagged or raw SQL string.

## Transactions and streams

Define the transaction boundary around all writes that must commit together.
Make retries aware of transaction idempotency and isolation. Use SqlStream for
large result sets; never collect an unbounded table merely to map it.

Run Migrator as an explicit deployment step with an audit trail. Keep schema
versions monotonic and test rollback or forward-only policy before production.

## Review checklist

- Is the adapter package and runtime compatible?
- Are every user value parameterized?
- Are connection, transaction, and cursor resources scoped?
- Are timeouts, cancellation, and pool limits configured?
- Are SQL errors mapped to domain errors without leaking query text or
  credentials?
- Does a migration run exactly once under deployment coordination?

## References

- [Effect SQL modules](https://effect.website/docs/v4/api/effect)
- [Effect SQL source](https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/effect/src/sql)
- [SQL packages](https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/sql)
- [Effect Schema API](https://effect.website/docs/v4/api/effect/Schema)
