// The test gives the program its services at the edge.
// @effect-diagnostics strictEffectProvide:off
// Each migration step is its own Effect.gen, so that the names in one step do
// not clash with the names in the next.
// @effect-diagnostics nestedEffectGenYield:off
import { cp, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, it } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { NodeServices } from "@effect/platform-node"
import { DatabasePostgres } from "@openbot-build/openbot"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { Effect, Layer, Redacted } from "effect"
import * as PostgresTest from "./PostgresTest.ts"
import * as Db from "../src/database/Database.ts"

const migrations = fileURLToPath(new URL("../migrations", import.meta.url))
/** The first migration after the Workflows. */
const firstMigration = "20261022111338_drop_workflows"
/**
 * The last migration that this test is about. Later migrations, such as the one that
 * replaces Sessions with Chats, do not run.
 */
const lastMigration = "20261022121205_drop_workflow_audit"
const host = "@openbot-build/openbot/session-host"

const session = (id: string, kind: string, spaced: boolean) => {
	const body = {
		id,
		revision: 1,
		settings: { mode: "default" },
		turns: [{ id: "turn_1", settings: { mode: "default" } }],
		business: {
			[host]: { bot: "bot_1", kind, run: "run_1" },
		},
	}
	return {
		namespace: "local",
		id,
		// A body that went through jsonb has a space after each colon.
		body: spaced
			? JSON.stringify(body).replaceAll('":', '": ')
			: JSON.stringify(body),
		head: "version_1",
		archived: 0,
		status: "Completed",
		turn: null,
		response: null,
		response_summary: null,
		revision: 1,
	}
}

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
	"old Sessions get the mode build, Sessions of Runs become direct, Workflow audit entries go, and old organizations get the default plan approval",
	() =>
		Effect.gen(function* () {
			const database = yield* Effect.acquireRelease(
				Effect.promise(() => PostgresTest.start()),
				(database) => Effect.promise(() => database.close()),
			)
			const before = yield* folder
			const through = yield* folder
			yield* Effect.promise(async () => {
				for (const name of await readdir(migrations)) {
					if (name < firstMigration)
						await cp(join(migrations, name), join(before, name), {
							recursive: true,
						})
					if (name <= lastMigration)
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
						session("ses_run", "workflow", false),
						session("ses_direct", "direct", true),
					])
						yield* sql`insert into openbot_session_references ${sql.insert(row)}`
					yield* sql`insert into openbot_settings ${sql.insert({
						scope_kind: "organization",
						scope_id: "org_a",
						document: JSON.stringify({ requestTimeoutMs: 1000 }),
						version: 1,
						updated_at: 1,
					})}`
					for (const action of ["workflow.run_started", "bot.created"])
						yield* sql`insert into openbot_audit_logs ${sql.insert({
							organization_id: "org_a",
							created_at: 1,
							action,
							actor_user_id: "user_a",
							actor: "{}",
							resource: "openbot.org.org_a",
							details: "{}",
						})}`
					// Effect made these tables for the Workflow Runs.
					yield* sql`create table openbot_cluster_runners (id text)`
				})
				yield* Effect.gen(function* () {
					const db = yield* Db.make
					yield* migrate(db, { migrationsFolder: through })
				})
				yield* Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					const rows = yield* sql<{
						readonly id: string
						readonly body: string
					}>`select id, body from openbot_session_references order by id`
					const bodies = Object.fromEntries(
						rows.map((row) => [row.id, JSON.parse(row.body)]),
					)
					for (const id of ["ses_direct", "ses_run"]) {
						assert.strictEqual(bodies[id].settings.mode, "build", id)
						assert.strictEqual(bodies[id].turns[0].settings.mode, "build", id)
					}
					assert.deepStrictEqual(bodies["ses_run"].business[host], {
						bot: "bot_1",
						kind: "direct",
					})
					assert.strictEqual(bodies["ses_direct"].business[host].kind, "direct")
					const settings = yield* sql<{
						readonly document: string
					}>`select document from openbot_settings where scope_id = 'org_a'`
					assert.deepStrictEqual(JSON.parse(settings[0]!.document), {
						requestTimeoutMs: 1000,
						planApproval: {
							approver: "chain",
							timeoutMs: 86400000,
							onTimeout: "stay",
						},
					})
					// The audit log has no Workflow actions any more.
					const audit = yield* sql<{
						readonly action: string
					}>`select action from openbot_audit_logs order by sequence`
					assert.deepStrictEqual(
						audit.map((row) => row.action),
						["bot.created"],
					)
					const cluster = yield* sql<{
						readonly tablename: string
					}>`select tablename from pg_catalog.pg_tables where tablename like 'openbot_cluster%'`
					assert.deepStrictEqual(cluster, [])
				})
			}).pipe(Effect.provide(layer(database.url)))
		}),
)
