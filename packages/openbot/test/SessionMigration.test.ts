import { assert, it } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { NodeServices } from "@effect/platform-node"
import { DatabasePostgres } from "@openbot-build/openbot"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import {
	Array as Arr,
	Effect,
	Layer,
	Record as Rec,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import * as MigrationTest from "./MigrationTest.ts"
import * as PostgresTest from "./PostgresTest.ts"
import * as Db from "../src/database/Database.ts"

/** The first migration after the Workflows. */
const firstMigration = "20261022111338_drop_workflows"
/**
 * The last migration that this test is about. Later migrations, such as the one that
 * replaces Sessions with Chats, do not run.
 */
const lastMigration = "20261022121205_drop_workflow_audit"
const host = "@openbot-build/openbot/session-host"

/** A throwaway PostgreSQL server. All steps share its one connection pool, as one server would. */
const database = Layer.unwrap(
	Effect.map(PostgresTest.start, (database) =>
		DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
	),
).pipe(Layer.provideMerge(NodeServices.layer))

/** JSON text, as the database keeps it. */
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/** The parts of a stored Session body that the test reads. */
const decodeBody = Schema.decodeEffect(
	Schema.fromJsonString(
		Schema.Struct({
			settings: Schema.Struct({ mode: Schema.String }),
			turns: Schema.Array(
				Schema.Struct({ settings: Schema.Struct({ mode: Schema.String }) }),
			),
			business: Schema.Record(
				Schema.String,
				Schema.Record(Schema.String, Schema.Unknown),
			),
		}),
	),
)
const decodeDocument = Schema.decodeEffect(
	Schema.fromJsonString(Schema.Unknown),
)

const session = Effect.fn("SessionMigration.session")(function* (
	id: string,
	kind: string,
	spaced: boolean,
) {
	const body = yield* encodeJson({
		id,
		revision: 1,
		settings: { mode: "default" },
		turns: [{ id: "turn_1", settings: { mode: "default" } }],
		business: {
			[host]: { bot: "bot_1", kind, run: "run_1" },
		},
	})
	return {
		namespace: "local",
		id,
		// A body that went through jsonb has a space after each colon.
		body: spaced ? Str.replaceAll('":', '": ')(body) : body,
		head: "version_1",
		archived: 0,
		status: "Completed",
		turn: null,
		response: null,
		response_summary: null,
		revision: 1,
	}
})

const migrateWith = Effect.fn("SessionMigration.migrateWith")(function* (
	migrationsFolder: string,
) {
	const db = yield* Db.make
	yield* migrate(db, { migrationsFolder })
})

/** Adds the rows of the time before the migrations. */
const insertOldRows = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	for (const row of [
		yield* session("ses_run", "workflow", false),
		yield* session("ses_direct", "direct", true),
	])
		yield* sql`insert into openbot_session_references ${sql.insert(row)}`
	yield* sql`insert into openbot_settings ${sql.insert({
		scope_kind: "organization",
		scope_id: "org_a",
		document: yield* encodeJson({ requestTimeoutMs: 1000 }),
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

it.layer(database, { excludeTestServices: true })((it) => {
	it.effect(
		"old Sessions get the mode build, Sessions of Runs become direct, Workflow audit entries go, and old organizations get the default plan approval",
		() =>
			Effect.gen(function* () {
				const before = yield* MigrationTest.migrationsWhere(
					(name) => name < firstMigration,
				)
				const through = yield* MigrationTest.migrationsWhere(
					(name) => name <= lastMigration,
				)
				yield* migrateWith(before)
				yield* insertOldRows
				yield* migrateWith(through)
				const sql = yield* PgClient.PgClient
				const rows = yield* sql<{
					readonly id: string
					readonly body: string
				}>`select id, body from openbot_session_references order by id`
				const bodies = Rec.fromEntries(
					yield* Effect.forEach(rows, (row) =>
						Effect.map(decodeBody(row.body), (body) => [row.id, body] as const),
					),
				)
				for (const id of ["ses_direct", "ses_run"]) {
					assert.strictEqual(bodies[id]?.settings.mode, "build", id)
					assert.strictEqual(bodies[id]?.turns[0]?.settings.mode, "build", id)
				}
				assert.deepStrictEqual(bodies["ses_run"]?.business[host], {
					bot: "bot_1",
					kind: "direct",
				})
				assert.strictEqual(
					bodies["ses_direct"]?.business[host]?.["kind"],
					"direct",
				)
				const settings = yield* sql<{
					readonly document: string
				}>`select document from openbot_settings where scope_id = 'org_a'`
				assert.deepStrictEqual(
					yield* Effect.forEach(settings, (row) =>
						decodeDocument(row.document),
					),
					[
						{
							requestTimeoutMs: 1000,
							planApproval: {
								approver: "chain",
								timeoutMs: 86400000,
								onTimeout: "stay",
							},
						},
					],
				)
				// The audit log has no Workflow actions any more.
				const audit = yield* sql<{
					readonly action: string
				}>`select action from openbot_audit_logs order by sequence`
				assert.deepStrictEqual(
					Arr.map(audit, (row) => row.action),
					["bot.created"],
				)
				const cluster = yield* sql<{
					readonly tablename: string
				}>`select tablename from pg_catalog.pg_tables where tablename like 'openbot_cluster%'`
				assert.deepStrictEqual(cluster, [])
			}),
	)
})
