import assert from "node:assert/strict"
import { cp, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as PostgresTest from "./PostgresTest.ts"

const migrations = fileURLToPath(new URL("../migrations", import.meta.url))

test("each old Main Agent becomes a lasting Agent and the default Agent of its member", async () => {
	const database = await PostgresTest.start()
	const before = await mkdtemp(join(tmpdir(), "openbot-migrations-"))
	await using runtime = ManagedRuntime.make(
		DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }).pipe(
			Layer.provide(NodeServices.layer),
		),
	)
	const agent = (
		id: string,
		organizationId: string,
		userId: string,
		kind: string,
	) => ({
		kind: "agent",
		organization_id: organizationId,
		id,
		owner: userId,
		scope: "",
		status: kind,
		body: JSON.stringify({
			id,
			kind,
			owner: { _tag: "Member", userId },
			name: id,
		}),
	})
	const approval = { approver: "person", timeoutMs: 1000, onTimeout: "run" }
	try {
		for (const name of await readdir(migrations))
			if (name < "20261023052657_main_agent_to_default")
				await cp(join(migrations, name), join(before, name), {
					recursive: true,
				})
		await runtime.runPromise(
			Effect.gen(function* () {
				const db = yield* Db.make
				yield* migrate(db, { migrationsFolder: before })
				const sql = yield* PgClient.PgClient
				for (const row of [
					agent("agt_main_a", "org_a", "user_a", "main"),
					agent("agt_main_b", "org_a", "user_b", "main"),
					agent("agt_other", "org_a", "user_a", "persistent"),
				])
					yield* sql`insert into openbot_agent_records ${sql.insert(row)}`
				// This member changed their settings before.
				yield* sql`insert into openbot_settings ${sql.insert({
					scope_kind: "member",
					scope_id: "org_a/user_b",
					document: JSON.stringify({ planApproval: approval }),
					version: 3,
					updated_at: 1,
				})}`
			}),
		)
		await runtime.runPromise(DatabasePostgres.migrate)
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const agents = yield* sql<{
					readonly id: string
					readonly status: string
					readonly body: string
				}>`select id, status, body from openbot_agent_records order by id`
				assert.deepEqual(
					agents.map((row) => [row.id, row.status, JSON.parse(row.body).kind]),
					[
						["agt_main_a", "persistent", "persistent"],
						["agt_main_b", "persistent", "persistent"],
						["agt_other", "persistent", "persistent"],
					],
				)
				const settings = yield* sql<{
					readonly scope_id: string
					readonly document: string
					readonly version: number
				}>`select scope_id, document, version from openbot_settings where scope_kind = 'member' order by scope_id`
				assert.deepEqual(
					settings.map((row) => [
						row.scope_id,
						JSON.parse(row.document),
						row.version,
					]),
					[
						[
							"org_a/user_a",
							{ planApproval: null, defaultAgent: "agt_main_a" },
							1,
						],
						[
							"org_a/user_b",
							{ planApproval: approval, defaultAgent: "agt_main_b" },
							4,
						],
					],
				)
			}),
		)
	} finally {
		await rm(before, { recursive: true, force: true })
		await database.close()
	}
})
