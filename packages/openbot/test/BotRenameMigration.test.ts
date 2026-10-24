// The test gives the program its services at the edge.
// @effect-diagnostics strictEffectProvide:off
import { cp, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { Effect, Layer, Redacted } from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as PostgresTest from "./PostgresTest.ts"

const migrations = fileURLToPath(new URL("../migrations", import.meta.url))

// Instructions are free text. The migration must not change them.
const instructions = 'Say "agent": you are an agent. Use agents.read.'

it.live("old Agent rows become Bot rows, and free text stays the same", () =>
	Effect.gen(function* () {
		const database = yield* Effect.acquireRelease(
			Effect.promise(() => PostgresTest.start()),
			(database) => Effect.promise(() => database.close()),
		)
		const before = yield* Effect.acquireRelease(
			Effect.promise(() => mkdtemp(join(tmpdir(), "openbot-migrations-"))),
			(folder) =>
				Effect.promise(() => rm(folder, { recursive: true, force: true })),
		)
		yield* Effect.promise(async () => {
			for (const name of await readdir(migrations))
				if (name < "20261023151239_rename_agents_to_bots")
					await cp(join(migrations, name), join(before, name), {
						recursive: true,
					})
		})
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
				body: JSON.stringify({
					id: "agt_1",
					name: "Helper",
					instructions,
					owner: { _tag: "Agent", agent: "agt_0", userId: "user_a" },
					tags: ["for:agent", "agents.read"],
				}),
			})}`
			yield* sql`insert into openbot_settings ${sql.insert({
				scope_kind: "member",
				scope_id: "org_a/user_a",
				document: JSON.stringify({ defaultAgent: "agt_1" }),
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
				records.map((row) => [row.kind, row.scope, JSON.parse(row.body)]),
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
				settings.map((row) => JSON.parse(row.document)),
				[{ defaultBot: "agt_1" }],
			)
			const memories = yield* sql<{
				readonly home_bot: string
				readonly layer: string
				readonly content: string
			}>`select home_bot, layer, content from openbot_bot_memories`
			assert.deepStrictEqual(
				memories.map((row) => [row.home_bot, row.layer, row.content]),
				[["agt_1", "bot", "The agent likes tea."]],
			)
			const tags = yield* sql<{
				readonly tag: string
			}>`select tag from openbot_bot_memory_tags`
			assert.deepStrictEqual(
				tags.map((row) => row.tag),
				["for:bot"],
			)
		}).pipe(
			Effect.provide(
				DatabasePostgres.layer({
					databaseUrl: Redacted.make(database.url),
				}).pipe(Layer.provide(NodeServices.layer)),
			),
		)
	}),
)
