import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { Effect, Layer, Redacted, Schema, String as Str } from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Store from "../src/execution/Store.ts"
import * as MigrationTest from "./MigrationTest.ts"
import * as PostgresTest from "./PostgresTest.ts"

const ownMigration = "20261027055615_execution_service_identity"
const database = Store.layer.pipe(
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
	),
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (database) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
			),
		),
	),
	Layer.provideMerge(NodeServices.layer),
)

it.layer(database, { excludeTestServices: true })((it) => {
	it.effect(
		"the service schema keeps old sealed member data and command receipts",
		() =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const db = yield* Db.make
				const store = yield* Store.Store
				const secrets = yield* Secrets.Secrets
				const before = yield* MigrationTest.migrationsWhere(
					(name) => name < ownMigration,
				)
				const through = yield* MigrationTest.migrationsWhere(
					(name) => name <= ownMigration,
				)
				yield* migrate(db, { migrationsFolder: before })
				const key = { namespace: "test", id: Execution.Id.make("old-member") }
				const identity = {
					owner: { organizationId: "org", userId: "user" },
					actor: {
						kind: "member" as const,
						organizationId: "org",
						userId: "user",
					},
				}
				const input = { text: "saved private input" }
				const body = { input: "saved command" }
				const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))
				const seal = (field: string, value: Schema.Json) =>
					Effect.gen(function* () {
						return yield* secrets.seal(
							yield* json(value),
							yield* json(["execution", key.namespace, key.id, field]),
						)
					})
				const sealedIdentity = yield* seal("identity", identity)
				yield* sql`insert into openbot_executions ${sql.insert({
					namespace: key.namespace,
					id: key.id,
					workflow: "test",
					resource_kind: "Chat",
					resource_id: "chat",
					organization_id: "org",
					user_id: "user",
					identity: sealedIdentity,
					input: yield* seal("input", input),
					status: "queued",
					sequence: 1,
					created_at: 1,
					updated_at: 1,
				})}`
				yield* sql`insert into openbot_execution_commands ${sql.insert({
					namespace: key.namespace,
					id: "command",
					execution_id: key.id,
					organization_id: "org",
					user_id: "user",
					key: "start",
					body: yield* seal("command:command", body),
					kind: "start",
					sequence: 1,
					created_at: 1,
				})}`
				yield* sql`insert into openbot_execution_outbox ${sql.insert({ namespace: key.namespace, command_id: "command", execution_id: key.id, created_at: 1 })}`
				yield* migrate(db, { migrationsFolder: through })
				yield* migrate(db, { migrationsFolder: through })
				const saved = yield* store.loadMember(key)
				assert.deepEqual(saved.identity, identity)
				assert.deepEqual(saved.input, input)
				const receipt = yield* store.accept(
					key.namespace,
					Execution.CommandKey.make("start"),
					{ actor: identity.actor, body },
					() => Effect.die("A saved command must not run again."),
				)
				assert.deepEqual(receipt, {
					executionId: key.id,
					commandKey: "start",
					sequence: 1,
				})
				assert.strictEqual((yield* store.pending(["test"])).length, 1)
				const rows = yield* sql<{
					readonly principal_kind: string
					readonly service_id: string | null
					readonly identity: string
				}>`select principal_kind, service_id, identity from openbot_executions where id = ${key.id}`
				assert.deepEqual(rows, [
					{
						principal_kind: "member",
						service_id: null,
						identity: sealedIdentity,
					},
				])
			}),
	)
})
