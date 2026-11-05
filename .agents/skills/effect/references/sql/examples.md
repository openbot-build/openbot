# Effect SQL: worked examples

## Batching, dynamic filters, streaming

```ts import.meta.vitest name="references/sql/examples.md#1"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Schema, Stream } from "effect"
import { SqlClient, SqlResolver, SqlSchema, type Statement } from "effect/sql"

const Product = Schema.Struct({ id: Schema.Int, name: Schema.String, price: Schema.Int })

const program = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE products (id integer PRIMARY KEY, name text NOT NULL, price integer NOT NULL)`
  yield* sql`INSERT INTO products ${sql.insert([
    { id: 1, name: "pen", price: 2 },
    { id: 2, name: "ink", price: 9 },
    { id: 3, name: "pad", price: 5 }
  ])}`

  // Dynamic filter: build fragments, combine with sql.and. Every value is
  // still a bound parameter; only fragments you wrote become SQL text.
  const search = SqlSchema.findAll({
    Request: Schema.Struct({
      maxPrice: Schema.optional(Schema.Int),
      ids: Schema.optional(Schema.Array(Schema.Int))
    }),
    Result: Product,
    execute: ({ maxPrice, ids }) => {
      const clauses: Array<Statement.Fragment> = [sql`true`]
      if (maxPrice !== undefined) clauses.push(sql`price <= ${maxPrice}`)
      if (ids !== undefined) clauses.push(sql.in("id", ids))
      return sql`SELECT * FROM products WHERE ${sql.and(clauses)} ORDER BY id`
    }
  })
  const cheap = yield* search({ maxPrice: 5 })
  // An empty list is valid: sql.in renders a clause that matches nothing.
  const none = yield* search({ ids: [] })

  // N+1 killer: each caller asks for one id; the resolver collects everything
  // requested in the same tick into ONE query with `id IN (...)`.
  const byId = SqlResolver.findById({
    Id: Schema.Int,
    Result: Product,
    ResultId: (product) => product.id,
    execute: (ids) => sql`SELECT * FROM products WHERE ${sql.in("id", ids)}`
  })
  const three = yield* Effect.forEach([1, 2, 3], (id) => SqlResolver.request(id, byId), {
    concurrency: "unbounded"
  })

  // Streaming: rows arrive incrementally with backpressure. Decode each row
  // with a Schema if you need typed values.
  const total = yield* sql<{ price: number }>`SELECT price FROM products`.stream.pipe(
    Stream.map((row) => row.price),
    Stream.runFold(() => 0, (sum, price) => sum + price)
  )

  return { cheap: cheap.map((p) => p.name), none: none.length, three: three.map((p) => p.name), total }
}).pipe(Effect.provide(PgliteClient.layer({})))

const out = await Effect.runPromise(program)
out // => { cheap: ["pen", "pad"], none: 0, three: ["pen", "ink", "pad"], total: 16 }
```
