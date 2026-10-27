import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { Array as Arr, Effect, Layer, Redacted } from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as MigrationTest from "./MigrationTest.ts"
import * as PostgresTest from "./PostgresTest.ts"

const ownMigration = "20261026141236_execution_cancel_epoch"
const database = Layer.unwrap(
	Effect.map(PostgresTest.start, (database) =>
		DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
	),
).pipe(Layer.provideMerge(NodeServices.layer))

it.layer(database, { excludeTestServices: true })((it) => {
	it.effect(
		"old cancel commands keep their phase across the schema change",
		() =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const db = yield* Db.make
				const before = yield* MigrationTest.migrationsWhere(
					(name) => name < ownMigration,
				)
				const through = yield* MigrationTest.migrationsWhere(
					(name) => name <= ownMigration,
				)
				yield* migrate(db, { migrationsFolder: before })
				for (const [id, status] of [
					["a", "cancelling"],
					["b", "running"],
					["c", "running"],
				] as const) {
					yield* sql`insert into openbot_executions ${sql.insert({
						namespace: "test",
						id,
						workflow: "test",
						resource_kind: "Chat",
						resource_id: id,
						organization_id: "org",
						user_id: "user",
						identity: "sealed identity",
						input: "sealed input",
						status,
						created_at: 1,
						updated_at: 1,
					})}`
					if (id === "c") continue
					yield* sql`insert into openbot_execution_commands ${sql.insert({
						namespace: "test",
						id,
						execution_id: id,
						organization_id: "org",
						user_id: "user",
						key: id,
						body: "sealed command",
						kind: "cancel",
						sequence: 1,
						created_at: 1,
					})}`
					yield* sql`insert into openbot_execution_outbox ${sql.insert({
						namespace: "test",
						command_id: id,
						execution_id: id,
						created_at: 1,
					})}`
				}
				yield* migrate(db, { migrationsFolder: through })
				yield* migrate(db, { migrationsFolder: through })
				const records = yield* sql<{
					readonly id: string
					readonly status: string
					readonly epoch: number
				}>`
            select id, status, cancel_epoch as epoch from openbot_executions order by id`
				assert.deepStrictEqual(records, [
					{ id: "a", status: "cancelling", epoch: 1 },
					{ id: "b", status: "running", epoch: 1 },
					{ id: "c", status: "running", epoch: 0 },
				])
				const commands = yield* sql<{
					readonly epoch: number
					readonly body: string
				}>`
            select c.cancel_epoch as epoch, c.body from openbot_execution_commands c
            join openbot_execution_outbox o on o.namespace = c.namespace and o.command_id = c.id
            where o.sent_at is null order by c.id`
				assert.deepStrictEqual(
					Arr.map(commands, (row) => row.epoch),
					[1, 1],
				)
				assert.isTrue(
					Arr.every(commands, (row) => row.body === "sealed command"),
				)
			}),
	)
})
