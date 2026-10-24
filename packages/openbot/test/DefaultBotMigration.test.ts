// The test gives the program its services at the edge.
// @effect-diagnostics strictEffectProvide:off
// Each migration step is its own Effect.gen, so that the names in one step do
// not clash with the names in the next.
// @effect-diagnostics nestedEffectGenYield:off
import { cp, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { Effect, Layer, Redacted } from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as PostgresTest from "./PostgresTest.ts"

const migrations = fileURLToPath(new URL("../migrations", import.meta.url))
/**
 * The migration that this test is about. Later migrations do not run, so the table and
 * the settings key still have the names of that time: Agents, not Bots.
 */
const ownMigration = "20261023052657_main_agent_to_default"

/** A new empty folder, removed at the end of the test. */
const folder = Effect.acquireRelease(
	Effect.promise(() => mkdtemp(join(tmpdir(), "openbot-migrations-"))),
	(folder) =>
		Effect.promise(() => rm(folder, { recursive: true, force: true })),
)

const layer = (url: string) =>
	DatabasePostgres.layer({ databaseUrl: Redacted.make(url) }).pipe(
		Layer.provide(NodeServices.layer),
	)

it.live(
	"each old Main Bot becomes a lasting Bot and the default Bot of its member",
	() =>
		Effect.gen(function* () {
			const database = yield* Effect.acquireRelease(
				Effect.promise(() => PostgresTest.start()),
				(database) => Effect.promise(() => database.close()),
			)
			const before = yield* folder
			const through = yield* folder
			const bot = (
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
			yield* Effect.promise(async () => {
				for (const name of await readdir(migrations)) {
					if (name < ownMigration)
						await cp(join(migrations, name), join(before, name), {
							recursive: true,
						})
					if (name <= ownMigration)
						await cp(join(migrations, name), join(through, name), {
							recursive: true,
						})
				}
			})
			// All steps share one connection pool, as one server would.
			yield* Effect.gen(function* () {
				yield* Effect.gen(function* () {
					const db = yield* Db.make
					yield* migrate(db, { migrationsFolder: before })
					const sql = yield* PgClient.PgClient
					for (const row of [
						bot("bot_main_a", "org_a", "user_a", "main"),
						bot("bot_main_b", "org_a", "user_b", "main"),
						bot("bot_other", "org_a", "user_a", "persistent"),
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
				})
				yield* Effect.gen(function* () {
					const db = yield* Db.make
					yield* migrate(db, { migrationsFolder: through })
				})
				yield* Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					const bots = yield* sql<{
						readonly id: string
						readonly status: string
						readonly body: string
					}>`select id, status, body from openbot_agent_records order by id`
					assert.deepStrictEqual(
						bots.map((row) => [row.id, row.status, JSON.parse(row.body).kind]),
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
						settings.map((row) => [
							row.scope_id,
							JSON.parse(row.document),
							row.version,
						]),
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
				})
			}).pipe(Effect.provide(layer(database.url)))
		}),
)
