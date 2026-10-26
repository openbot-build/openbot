import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { Effect, Layer, Redacted, Schema } from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as MigrationTest from "./MigrationTest.ts"
import * as PostgresTest from "./PostgresTest.ts"

/**
 * The migration that this test is about. Later migrations do not run, so the table and
 * the settings key still have the names of that time: Agents, not Bots.
 */
const ownMigration = "20261023052657_main_agent_to_default"

/** A throwaway PostgreSQL server. All steps share its one connection pool, as one server would. */
const database = Layer.unwrap(
	Effect.map(PostgresTest.start, (database) =>
		DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
	),
).pipe(Layer.provideMerge(NodeServices.layer))

/** JSON text, as the database keeps it. */
const Json = Schema.fromJsonString(Schema.Unknown)

const decodeKind = Schema.decodeEffect(
	Schema.fromJsonString(Schema.Struct({ kind: Schema.String })),
)

const migrateWith = Effect.fn("DefaultBotMigration.migrateWith")(function* (
	migrationsFolder: string,
) {
	const db = yield* Db.make
	yield* migrate(db, { migrationsFolder })
})

/** Adds a Bot record in the shape of that time. */
const addBot = Effect.fn("DefaultBotMigration.addBot")(function* (
	id: string,
	organizationId: string,
	userId: string,
	kind: string,
) {
	const sql = yield* PgClient.PgClient
	const body = yield* Schema.encodeEffect(Json)({
		id,
		kind,
		owner: { _tag: "Member", userId },
		name: id,
	})
	yield* sql`insert into openbot_agent_records ${sql.insert({
		kind: "agent",
		organization_id: organizationId,
		id,
		owner: userId,
		scope: "",
		status: kind,
		body,
	})}`
})

it.layer(database, { excludeTestServices: true })((it) => {
	it.effect(
		"each old Main Bot becomes a lasting Bot and the default Bot of its member",
		() =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const before = yield* MigrationTest.migrationsWhere(
					(name) => name < ownMigration,
				)
				const through = yield* MigrationTest.migrationsWhere(
					(name) => name <= ownMigration,
				)
				const approval = {
					approver: "person",
					timeoutMs: 1000,
					onTimeout: "run",
				}
				yield* migrateWith(before)
				yield* addBot("bot_main_a", "org_a", "user_a", "main")
				yield* addBot("bot_main_b", "org_a", "user_b", "main")
				yield* addBot("bot_other", "org_a", "user_a", "persistent")
				// This member changed their settings before.
				yield* sql`insert into openbot_settings ${sql.insert({
					scope_kind: "member",
					scope_id: "org_a/user_b",
					document: yield* Schema.encodeEffect(Json)({
						planApproval: approval,
					}),
					version: 3,
					updated_at: 1,
				})}`
				yield* migrateWith(through)
				const bots = yield* sql<{
					readonly id: string
					readonly status: string
					readonly body: string
				}>`select id, status, body from openbot_agent_records order by id`
				assert.deepStrictEqual(
					yield* Effect.forEach(bots, (row) =>
						Effect.map(decodeKind(row.body), ({ kind }) => [
							row.id,
							row.status,
							kind,
						]),
					),
					[
						["bot_main_a", "persistent", "persistent"],
						["bot_main_b", "persistent", "persistent"],
						["bot_other", "persistent", "persistent"],
					],
				)
				const settings = yield* sql<{
					readonly scope_id: string
					readonly document: string
					readonly version: number
				}>`select scope_id, document, version from openbot_settings where scope_kind = 'member' order by scope_id`
				assert.deepStrictEqual(
					yield* Effect.forEach(settings, (row) =>
						Effect.map(Schema.decodeEffect(Json)(row.document), (document) => [
							row.scope_id,
							document,
							row.version,
						]),
					),
					[
						[
							"org_a/user_a",
							{ planApproval: null, defaultAgent: "bot_main_a" },
							1,
						],
						[
							"org_a/user_b",
							{ planApproval: approval, defaultAgent: "bot_main_b" },
							4,
						],
					],
				)
			}),
	)
})
