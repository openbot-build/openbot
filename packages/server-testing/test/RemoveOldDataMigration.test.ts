import * as TestDatabase from "@openbot-build/server-database/Testing"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Record as Rec,
	Redacted,
	String as Str,
} from "effect"
import type { SqlError } from "effect/sql"
import { ChatStoreRepository, Store } from "@openbot-build/core"
import {
	chatHostId,
	chatHostStore,
} from "@openbot-build/conversation-contract/chats/ChatHost"
import * as StoredChats from "@openbot-build/conversation-contract/chats/StoredChats"
import * as Todos from "@openbot-build/conversation-contract/work/Todos"
import * as Db from "@openbot-build/server-database/Database"
import * as Migrations from "@openbot-build/server-database/Migrations"
import * as BotFixture from "./BotFixture.ts"

const ownMigration = "20261105183225_remove_old_data"
const refusal = "This database holds data of an older OpenBot version"
/** The test server. Each case makes its own database on it. */
class Server extends Context.Service<Server, TestDatabase.Database>()(
	"@openbot-build/server-testing/test/RemoveOldDataMigration.test/Server",
) {}
const server = Layer.effect(Server, TestDatabase.start).pipe(
	Layer.provideMerge(NodeServices.layer),
)

/** A new empty database on the test server, and the pool of its own. */
const database = (name: string) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const { url } = yield* Server
			yield* Effect.flatMap(
				PgClient.PgClient,
				(sql) => sql`create database ${sql(name)}`,
			).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url) })))
			return PgClient.layer({
				url: Redacted.make(Str.replace(/\/postgres$/, "/" + name)(url)),
			})
		}),
	)

/** Applies every migration before this one, so the database looks like the last version. */
const lastVersion = Effect.gen(function* () {
	const db = yield* Db.make
	const before = yield* TestDatabase.migrationsWhere(
		(name) => name < ownMigration,
	)
	yield* migrate(db, { migrationsFolder: before })
})

const tables = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	return Arr.map(
		yield* sql<{
			tablename: string
		}>`select tablename from pg_catalog.pg_tables where schemaname = 'public'`,
		(row) => row.tablename,
	)
})

const execution = (id: string, workflow: string) =>
	Effect.flatMap(
		PgClient.PgClient,
		(sql) =>
			sql`insert into openbot_executions ${sql.insert({
				namespace: "test",
				id,
				workflow,
				resource_kind: "Chat",
				resource_id: id,
				organization_id: "org",
				user_id: "user",
				identity: "sealed identity",
				input: "sealed input",
				status: "completed",
				created_at: 1,
				updated_at: 1,
			})}`,
	)

const chat = (id: string, business: object, state: object) =>
	Effect.flatMap(
		PgClient.PgClient,
		(sql) =>
			sql`insert into openbot_chats ${sql.insert({
				namespace: "test",
				id,
				body: JSON.stringify({ id, business }),
				state: JSON.stringify(state),
				bot: "bot",
				kind: "direct",
				status: "Idle",
				revision: 0,
				inbox_size: 0,
				created_at: 1,
				updated_at: 1,
			})}`,
	)

/** Writes a Chat with its host data and a todo list through the store that the server uses. */
const storedChat = Effect.gen(function* () {
	const definition = yield* Store.define({
		stores: { [chatHostId]: chatHostStore, ...Todos.stores },
		schemaVersion: "chat/1",
	})
	const store = yield* ChatStoreRepository.make({
		definition,
		persistence: StoredChats.persistence(yield* Db.make, "test"),
	})
	const { kind, chain } = BotFixture.direct()
	const created = yield* store.create({
		business: { [chatHostId]: { bot: BotFixture.bot.id, kind, chain } },
	})
	yield* store.modifyEffect({
		chat: created.chat.id,
		update: (view) =>
			Effect.succeed([
				undefined,
				Option.some({
					append: [],
					value: { ...view.state, [Todos.storeKey]: { items: [] } },
				}),
			] as const),
	})
})

const usage = (row: Record<string, unknown>) =>
	Effect.flatMap(
		PgClient.PgClient,
		(sql) =>
			sql`insert into openbot_usage_events ${sql.insert({
				id: "held",
				status: "pending",
				started_at: 1,
				organization_id: "org",
				occurred_at: 1,
				source: "turn",
				provider_id: "provider",
				provider_owner: "platform",
				model_id: "model",
				input_uncached: 0,
				input_cache_read: 0,
				input_cache_write: 0,
				output_text: 0,
				output_reasoning: 0,
				cost_micros: 0,
				charged: false,
				reserved_micros: 0,
				estimated_micros: 0,
				...row,
			})}`,
	)

const settings = (scopeKind: string, scopeId: string, document: object) =>
	Effect.flatMap(
		PgClient.PgClient,
		(sql) =>
			sql`insert into openbot_settings ${sql.insert({
				scope_kind: scopeKind,
				scope_id: scopeId,
				document: JSON.stringify(document),
				version: 1,
				updated_at: 1,
			})}`,
	)

const platform = {
	publicOrigin: "https://openbot.example.com",
	authSecret: "sealed",
	identityProvider: null,
	organizationCreation: "platform_admins",
	registration: { provider: "open", invitations: "members" },
	ceiling: {},
	appRestrictions: [],
	codeMode: {},
	rateLimit: { requestsPerMinute: null },
	tokenRate: {},
	files: { storage: null, quotaBytes: null },
	mail: null,
}

const organization = {
	delegationTimeLimitMs: 3600000,
	toolForegroundBudgetMs: 30000,
	toolMaxDurationMs: 3600000,
	maxBackgroundOperations: 8,
	tokenRate: {},
}

/** Puts one row into a table. */
const row = (table: string, values: Record<string, unknown>) =>
	Effect.flatMap(
		PgClient.PgClient,
		(sql) => sql`insert into ${sql(table)} ${sql.insert(values)}`,
	)

/**
 * Puts one row into a table without the check of its foreign keys. Then a
 * case can put a row into a child table without the row of its parent table,
 * which is a marker of its own.
 */
const orphan = (table: string, values: Record<string, unknown>) =>
	Effect.flatMap(PgClient.PgClient, (sql) =>
		sql.withTransaction(
			Effect.andThen(
				sql`set local session_replication_role = replica`,
				row(table, values),
			),
		),
	)

/** A Channel with all its values, so it is no marker of its own. */
const channel = row("openbot_channels", {
	organization_id: "org",
	id: "channel",
	kind: "telegram",
	name: "Channel",
	bot: "bot",
	actor: "actor",
	enabled: true,
	credentials: "sealed",
	hints: "{}",
	version: 1,
	created_at: 1,
	updated_at: 1,
	execution_id: "channel-execution",
})

const inbox = {
	organization_id: "org",
	channel_id: "channel",
	event_id: "event",
	conversation_key: "conversation",
	event: "{}",
	received_at: 1,
	next_at: 1,
}

const delivery = {
	id: "delivery",
	organization_id: "org",
	channel_id: "channel",
	kind: "reply",
	target: "{}",
	body: "{}",
	state: "{}",
	next_at: 1,
	updated_at: 1,
}

const authorization = {
	id: "authorization",
	owner: "user",
	connection_id: "connection",
	revision: 1,
	expires_at: 1,
	return_to: "https://openbot.example.com",
	status: "pending",
	issuer: "https://issuer.example.com",
	resource: "https://resource.example.com",
	scopes: "[]",
}

const dataMove = "records of a data move"
const dropped = "rows of a table that this version drops"
const oldNames = "Chat data under old names"
const settingMissing = "settings without a value that this version needs"
const valueMissing = "rows without a value that this version needs"

/**
 * Each check of the guard at the top of the migration, and how a test makes
 * data that only this check finds. Each case starts from a new database, so a
 * check that comes earlier in the guard cannot hide a later one.
 */
const markers: ReadonlyArray<{
	readonly name: string
	readonly found: string
	readonly write: Effect.Effect<unknown, SqlError.SqlError, PgClient.PgClient>
}> = [
	{
		name: "an imported execution",
		found: "imported work",
		write: execution("old", "openbot.imported-record"),
	},
	{
		name: "a row of openbot_data_upgrades",
		found: dataMove,
		write: row("openbot_data_upgrades", {
			version: "execution/1",
			source: "test",
			state: "ready",
			counts: "[]",
			started_at: 1,
			updated_at: 1,
			checked_at: 1,
		}),
	},
	{
		name: "a row of openbot_data_upgrade_steps",
		found: dataMove,
		write: orphan("openbot_data_upgrade_steps", {
			version: "execution/1",
			step: "step",
			updated_at: 1,
		}),
	},
	{
		name: "a row of openbot_data_upgrade_records",
		found: dataMove,
		write: orphan("openbot_data_upgrade_records", {
			version: "execution/1",
			collection: "chats",
			key: "chat",
			state: "done",
			body: "{}",
			updated_at: 1,
		}),
	},
	{
		name: "a row of openbot_data_upgrade_failures",
		found: dataMove,
		write: orphan("openbot_data_upgrade_failures", {
			id: "00000000-0000-4000-8000-000000000001",
			version: "execution/1",
			step: "step",
			cause: "broken",
			created_at: 1,
		}),
	},
	{
		name: "a row of openbot_app_invocations",
		found: dropped,
		write: row("openbot_app_invocations", {
			owner: "user",
			id: "invocation",
			chat: "chat",
			status: "Running",
			body: "{}",
		}),
	},
	{
		name: "a row of openbot_code_runs",
		found: dropped,
		write: row("openbot_code_runs", {
			owner: "user",
			id: "run",
			chat: "chat",
			call_id: "call",
			status: "Running",
			body: "{}",
		}),
	},
	{
		name: "a row of openbot_computer_calls",
		found: dropped,
		write: row("openbot_computer_calls", {
			id: "call",
			computer_id: "computer",
			call: "{}",
			created_at: 1,
		}),
	},
	{
		name: "a row of openbot_operations",
		found: dropped,
		write: row("openbot_operations", {
			namespace: "test",
			id: "operation",
			chat: "chat",
			status: "Running",
			body: "{}",
			heartbeat_at: 1,
			started_at: 1,
		}),
	},
	{
		name: "Chat host data under its old name",
		found: oldNames,
		write: chat("old-host", { "@openbot-build/openbot/chat-host": {} }, {}),
	},
	{
		name: "a todo list under its old name",
		found: oldNames,
		write: chat(
			"old-todos",
			{},
			{
				"@openbot-build/openbot/todos": { items: [] },
			},
		),
	},
	{
		name: "todo reminders under their old name",
		found: oldNames,
		write: chat(
			"old-reminders",
			{},
			{
				"@openbot-build/openbot/todo-reminders": { turn: "turn", lists: [] },
			},
		),
	},
	...Arr.map(
		[
			"registration",
			"codeMode",
			"rateLimit",
			"tokenRate",
			"files",
			"mail",
		] as const,
		(key) => ({
			name: `platform settings without ${key}`,
			found: settingMissing,
			write: settings("platform", "platform", Rec.remove(platform, key)),
		}),
	),
	{
		name: "platform settings without files.quotaBytes",
		found: settingMissing,
		write: settings("platform", "platform", {
			...platform,
			files: { storage: null },
		}),
	},
	...Arr.map(
		[
			"delegationTimeLimitMs",
			"toolForegroundBudgetMs",
			"toolMaxDurationMs",
			"maxBackgroundOperations",
			"tokenRate",
		] as const,
		(key) => ({
			name: `organization settings without ${key}`,
			found: settingMissing,
			write: settings("organization", "org", Rec.remove(organization, key)),
		}),
	),
	{
		name: "member settings without defaultBot",
		found: settingMissing,
		write: settings("member", "org/user", { planApproval: null }),
	},
	...Arr.map(["pending", "unknown"] as const, (status) => ({
		name: `a ${status} usage hold with a reservation unlike its estimate`,
		found: "usage holds of an older version",
		write: usage({ status, reserved_micros: 0, estimated_micros: 1000 }),
	})),
	{
		name: "usage without started_at",
		found: valueMissing,
		write: usage({ started_at: null }),
	},
	{
		name: "usage without estimated_micros",
		found: valueMissing,
		write: usage({ estimated_micros: null }),
	},
	{
		name: "a Channel without execution_id",
		found: valueMissing,
		write: row("openbot_channels", {
			organization_id: "org",
			id: "channel",
			kind: "telegram",
			name: "Channel",
			bot: "bot",
			actor: "actor",
			enabled: true,
			credentials: "sealed",
			hints: "{}",
			version: 1,
			created_at: 1,
			updated_at: 1,
		}),
	},
	{
		name: "a Channel inbox event without execution_id",
		found: valueMissing,
		write: Effect.andThen(channel, row("openbot_channel_inbox", inbox)),
	},
	{
		name: "a Channel delivery without execution_id",
		found: valueMissing,
		write: Effect.andThen(channel, row("openbot_channel_deliveries", delivery)),
	},
	{
		name: "a developer index request without execution_id",
		found: valueMissing,
		write: row("openbot_developer_index_requests", {
			id: "00000000-0000-4000-8000-000000000002",
			owner: "user",
			card_url: "https://app.example.com/card.json",
			generation: "1",
			accepted_at: 1,
		}),
	},
	{
		name: "an App authorization without actor",
		found: valueMissing,
		write: row("openbot_app_authorizations", {
			...authorization,
			execution_id: "authorization-execution",
		}),
	},
	{
		name: "an App authorization without execution_id",
		found: valueMissing,
		write: row("openbot_app_authorizations", {
			...authorization,
			actor: "actor",
		}),
	},
]

/** The rows of every table, the journal of the migrator too, in a fixed order. */
const contents = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const names = yield* sql<{
		schema: string
		name: string
	}>`select schemaname as schema, tablename as name from pg_catalog.pg_tables
		where schemaname in ('public', 'drizzle') order by schemaname, tablename`
	return yield* Effect.forEach(names, ({ schema, name }) =>
		Effect.map(
			sql<{ rows: unknown }>`select coalesce(
				jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb
			) as rows from ${sql(schema)}.${sql(name)} t`,
			(result) => ({ table: `${schema}.${name}`, rows: result[0]?.rows }),
		),
	)
})

it.layer(server, { excludeTestServices: true, timeout: "120 seconds" })(
	(it) => {
		it.effect("an empty database passes and loses the old tables", () =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* Migrations.migrate
					const names = yield* tables
					assert.isFalse(Arr.contains(names, "openbot_data_upgrades"))
					assert.isFalse(Arr.contains(names, "openbot_operations"))
					assert.isFalse(Arr.contains(names, "openbot_code_runs"))
					assert.isFalse(Arr.contains(names, "openbot_app_invocations"))
					assert.isFalse(Arr.contains(names, "openbot_computer_calls"))
					// A second run has nothing to do.
					yield* Migrations.migrate
				}).pipe(Effect.provide(database("empty"))),
			),
		)

		it.effect.each(Arr.map(markers, (marker, index) => ({ ...marker, index })))(
			"$name stops the migration and changes no row",
			({ found, write, index }) =>
				Effect.scoped(
					Effect.gen(function* () {
						yield* lastVersion
						yield* write
						const before = yield* contents
						const error = yield* Effect.flip(Migrations.migrate)
						assert.strictEqual(error._tag, "MigrationFailed")
						assert.include(error.message, refusal)
						assert.include(error.message, `(${found})`)
						// The migration runs in one transaction, so every table and row stays as it was.
						assert.deepStrictEqual(yield* contents, before)
					}).pipe(Effect.provide(database(`marker_${index}`))),
				),
		)

		it.effect(
			"the startup check refuses a database of the last version until it is migrated",
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						yield* lastVersion
						const error = yield* Effect.flip(Migrations.check)
						assert.strictEqual(error._tag, "SchemaMismatch")
						assert.include(String(error.cause), ownMigration)
						yield* Migrations.migrate
						yield* Migrations.check
					}).pipe(Effect.provide(database("startup_check"))),
				),
		)

		it.effect("a database with data of this version passes", () =>
			Effect.scoped(
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					yield* lastVersion
					yield* execution("turn", "openbot.chat-turn")
					yield* storedChat
					yield* usage({ reserved_micros: 1000, estimated_micros: 1000 })
					yield* settings("platform", "platform", platform)
					yield* settings("organization", "org", {
						delegationTimeLimitMs: 3600000,
						toolForegroundBudgetMs: 30000,
						toolMaxDurationMs: 3600000,
						maxBackgroundOperations: 8,
						tokenRate: {},
					})
					yield* settings("member", "org/user", {
						planApproval: null,
						defaultBot: null,
					})
					yield* Migrations.migrate
					const [rows] = yield* sql<{
						chats: number
						settings: number
						executions: number
						usage: number
					}>`select
						(select count(*) from openbot_chats)::int as chats,
						(select count(*) from openbot_settings)::int as settings,
						(select count(*) from openbot_executions)::int as executions,
						(select count(*) from openbot_usage_events)::int as usage`
					// The Chat keeps its data under the names of this version.
					const [stored] = yield* sql<{ host: boolean; todos: boolean }>`select
						(body::jsonb -> 'business') ? ${chatHostId} as host,
						state::jsonb ? ${Todos.storeKey} as todos
						from openbot_chats`
					assert.deepStrictEqual(stored, { host: true, todos: true })
					assert.deepStrictEqual(rows, {
						chats: 1,
						settings: 3,
						executions: 1,
						usage: 1,
					})
					yield* Migrations.migrate
					yield* Migrations.check
				}).pipe(Effect.provide(database("current"))),
			),
		)
	},
)
