import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { Array as Arr, Effect, Layer, Redacted, Schema } from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as MigrationTest from "./MigrationTest.ts"
import * as PostgresTest from "./PostgresTest.ts"

// Instructions are free text. The migration must not change them.
const instructions = 'Say "agent": you are an agent. Use agents.read.'

/** The JSON text of a stored document. */
const Json = Schema.fromJsonString(Schema.Unknown)
const encodeJson = Schema.encodeEffect(Json)
const decodeJson = Schema.decodeEffect(Json)

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
	it.effect(
		"old Agent rows become Bot rows, and free text stays the same",
		() =>
			Effect.gen(function* () {
				const database = yield* PostgresTest.start
				const before = yield* MigrationTest.migrationsWhere(
					(name) => name < "20261023151239_rename_agents_to_bots",
				)
				const body = yield* encodeJson({
					id: "agt_1",
					name: "Helper",
					instructions,
					owner: { _tag: "Agent", agent: "agt_0", userId: "user_a" },
					tags: ["for:agent", "agents.read"],
				})
				const document = yield* encodeJson({ defaultAgent: "agt_1" })
				// The database pool closes with the test, before the server stops.
				const services = yield* Layer.build(
					DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
				)
				yield* Effect.gen(function* () {
					const db = yield* Db.make
					yield* migrate(db, { migrationsFolder: before })
					const sql = yield* PgClient.PgClient
					yield* sql`insert into openbot_agent_records ${sql.insert({
						kind: "agent",
						organization_id: "org_a",
						id: "agt_1",
						owner: "user_a",
						scope: "agent:org_a:agt_0",
						status: "persistent",
						body,
					})}`
					yield* sql`insert into openbot_settings ${sql.insert({
						scope_kind: "member",
						scope_id: "org_a/user_a",
						document,
						version: 1,
						updated_at: 1,
					})}`
					yield* sql`insert into openbot_agent_memories ${sql.insert({
						organization_id: "org_a",
						home_agent: "agt_1",
						id: "mem_1",
						layer: "agent",
						content: "The agent likes tea.",
						sources: "[]",
						status: "active",
						created_at: 1,
						updated_at: 1,
					})}`
					yield* sql`insert into openbot_agent_memory_tags ${sql.insert({
						organization_id: "org_a",
						home_agent: "agt_1",
						memory_id: "mem_1",
						tag: "for:agent",
					})}`
					yield* DatabasePostgres.migrate
					const records = yield* sql<{
						readonly kind: string
						readonly scope: string
						readonly body: string
					}>`select kind, scope, body from openbot_bot_records`
					assert.deepStrictEqual(
						yield* Effect.forEach(records, (row) =>
							Effect.map(decodeJson(row.body), (stored) => [
								row.kind,
								row.scope,
								stored,
							]),
						),
						[
							[
								"bot",
								"bot:org_a:agt_0",
								{
									id: "agt_1",
									name: "Helper",
									instructions,
									owner: { _tag: "Bot", bot: "agt_0", userId: "user_a" },
									tags: ["for:bot", "bots.read"],
								},
							],
						],
					)
					const settings = yield* sql<{
						readonly document: string
					}>`select document from openbot_settings where scope_kind = 'member'`
					assert.deepStrictEqual(
						yield* Effect.forEach(settings, (row) => decodeJson(row.document)),
						[{ defaultBot: "agt_1" }],
					)
					const memories = yield* sql<{
						readonly home_bot: string
						readonly layer: string
						readonly content: string
					}>`select home_bot, layer, content from openbot_bot_memories`
					assert.deepStrictEqual(
						Arr.map(memories, (row) => [row.home_bot, row.layer, row.content]),
						[["agt_1", "bot", "The agent likes tea."]],
					)
					const tags = yield* sql<{
						readonly tag: string
					}>`select tag from openbot_bot_memory_tags`
					assert.deepStrictEqual(
						Arr.map(tags, (row) => row.tag),
						["for:bot"],
					)
				}).pipe(Effect.provideContext(services))
			}),
	)
})
