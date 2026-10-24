import { cp, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, it } from "@effect/vitest"
import { fileURLToPath } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"
import * as Db from "../src/database/Database.ts"

/** A later migration gives every organization the default plan approval. */
const planApproval = {
	approver: "chain",
	timeoutMs: 86400000,
	onTimeout: "stay",
}

const migrations = fileURLToPath(new URL("../migrations", import.meta.url))
/** The first migration that knows models as their own table. */
const firstModelMigration = "20261022063828_create_models"

const oldProvider = (input: {
	readonly id: string
	readonly ownerKind: string
	readonly ownerId: string
	readonly createdAt: number
	readonly models: ReadonlyArray<object>
}) => ({
	id: input.id,
	owner_kind: input.ownerKind,
	owner_id: input.ownerId,
	kind: "openai",
	name: input.id,
	endpoint: null,
	api_key: "sealed",
	api_key_hint: null,
	models: JSON.stringify(input.models),
	availability: input.ownerKind === "platform" ? '{"_tag":"All"}' : null,
	version: 1,
	created_at: input.createdAt,
	updated_at: input.createdAt,
})

it("models in old providers move to their own table, and their IDs stay the same", async () => {
	const database = await PostgresTest.start()
	const before = await mkdtemp(join(tmpdir(), "openbot-migrations-"))
	await using runtime = ManagedRuntime.make(
		DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }).pipe(
			Layer.provide(NodeServices.layer),
		),
	)
	try {
		for (const name of await readdir(migrations))
			if (name < firstModelMigration)
				await cp(join(migrations, name), join(before, name), {
					recursive: true,
				})
		await runtime.runPromise(
			Effect.gen(function* () {
				const db = yield* Db.make
				yield* migrate(db, { migrationsFolder: before })
				const sql = yield* PgClient.PgClient
				const rows = [
					oldProvider({
						id: "prov_platform",
						ownerKind: "platform",
						ownerId: "platform",
						createdAt: 1,
						models: [
							{
								id: "small",
								name: "Small",
								reasoningEfforts: ["low"],
								serviceTiers: [],
							},
							{
								id: "big",
								name: "Big",
								reasoningEfforts: [],
								serviceTiers: ["flex"],
								contextWindow: 9000,
							},
						],
					}),
					oldProvider({
						id: "prov_first",
						ownerKind: "organization",
						ownerId: "org_a",
						createdAt: 2,
						models: [
							{
								id: "small",
								name: "Small A",
								reasoningEfforts: [],
								serviceTiers: [],
							},
						],
					}),
					oldProvider({
						id: "prov_second",
						ownerKind: "organization",
						ownerId: "org_a",
						createdAt: 3,
						models: [
							{
								id: "small",
								name: "Small B",
								reasoningEfforts: ["high"],
								serviceTiers: [],
								maxOutputTokens: 50,
							},
						],
					}),
				]
				for (const row of rows)
					yield* sql`insert into openbot_model_providers ${sql.insert(row)}`
			}),
		)
		await runtime.runPromise(DatabasePostgres.migrate)
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const models = yield* sql<{
					readonly owner_kind: string
					readonly owner_id: string
					readonly id: string
					readonly name: string
					readonly reasoning_efforts: string
					readonly service_tiers: string
					readonly context_window: number | null
					readonly availability: string | null
				}>`select owner_kind, owner_id, id, name, reasoning_efforts, service_tiers, context_window, availability
					from openbot_models order by owner_kind, owner_id, id`
				assert.deepStrictEqual(
					models.map((row) => [
						row.owner_kind,
						row.owner_id,
						row.id,
						row.name,
						JSON.parse(row.reasoning_efforts),
						JSON.parse(row.service_tiers),
						row.context_window,
						row.availability,
					]),
					[
						["organization", "org_a", "small", "Small A", [], [], null, null],
						[
							"platform",
							"platform",
							"big",
							"Big",
							[],
							["flex"],
							9000,
							'{"_tag":"All"}',
						],
						[
							"platform",
							"platform",
							"small",
							"Small",
							["low"],
							[],
							null,
							'{"_tag":"All"}',
						],
					],
				)
				const links = yield* sql<{
					readonly provider_id: string
					readonly model_owner_kind: string
					readonly model_id: string
					readonly position: number
					readonly reasoning_efforts: string | null
					readonly max_output_tokens: number | null
				}>`select provider_id, model_owner_kind, model_id, position, reasoning_efforts, max_output_tokens
					from openbot_provider_models order by provider_id, position`
				assert.deepStrictEqual(
					links.map((row) => [
						row.provider_id,
						row.model_owner_kind,
						row.model_id,
						row.position,
						row.reasoning_efforts,
						row.max_output_tokens,
					]),
					[
						["prov_first", "organization", "small", 0, null, null],
						["prov_platform", "platform", "small", 0, null, null],
						["prov_platform", "platform", "big", 1, null, null],
						["prov_second", "organization", "small", 0, '["high"]', 50],
					],
				)
				const columns = yield* sql<{ readonly column_name: string }>`
					select column_name from information_schema.columns
					where table_name = 'openbot_model_providers' and column_name = 'models'`
				assert.strictEqual(columns.length, 0)
			}),
		)
	} finally {
		await rm(before, { recursive: true, force: true })
		await database.close()
	}
})

it("old models become language models, and old organization settings keep no decision model", async () => {
	const database = await PostgresTest.start()
	const before = await mkdtemp(join(tmpdir(), "openbot-migrations-"))
	await using runtime = ManagedRuntime.make(
		DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }).pipe(
			Layer.provide(NodeServices.layer),
		),
	)
	const selection = {
		_tag: "Config.Selection",
		provider: "prov_d",
		model: "jev-latest",
	}
	try {
		for (const name of await readdir(migrations))
			if (name < "20261022070958_add_model_type")
				await cp(join(migrations, name), join(before, name), {
					recursive: true,
				})
		await runtime.runPromise(
			Effect.gen(function* () {
				const db = yield* Db.make
				yield* migrate(db, { migrationsFolder: before })
				const sql = yield* PgClient.PgClient
				yield* sql`insert into openbot_models ${sql.insert({
					owner_kind: "organization",
					owner_id: "org_a",
					id: "small",
					name: "Small",
					reasoning_efforts: "[]",
					service_tiers: "[]",
					context_window: null,
					max_output_tokens: null,
					availability: null,
					version: 1,
					created_at: 1,
					updated_at: 1,
				})}`
				const settings = [
					["organization", "org_a", { defaultModel: null }],
					["organization", "org_b", { decisionModel: selection }],
					["platform", "platform", { publicOrigin: "https://a.example" }],
				] as const
				for (const [kind, id, document] of settings)
					yield* sql`insert into openbot_settings ${sql.insert({
						scope_kind: kind,
						scope_id: id,
						document: JSON.stringify(document),
						version: 1,
						updated_at: 1,
					})}`
			}),
		)
		await runtime.runPromise(DatabasePostgres.migrate)
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const models = yield* sql<{
					readonly type: string
				}>`select type from openbot_models`
				assert.deepStrictEqual(
					models.map((row) => row.type),
					["language"],
				)
				const settings = yield* sql<{
					readonly scope_id: string
					readonly document: string
				}>`select scope_id, document from openbot_settings order by scope_id`
				assert.deepStrictEqual(
					settings.map((row) => [row.scope_id, JSON.parse(row.document)]),
					[
						[
							"org_a",
							{
								rulesModel: null,
								botMemoryModel: null,
								planApproval,
							},
						],
						[
							"org_b",
							{
								rulesModel: null,
								botMemoryModel: null,
								planApproval,
							},
						],
						["platform", { publicOrigin: "https://a.example" }],
					],
				)
			}),
		)
	} finally {
		await rm(before, { recursive: true, force: true })
		await database.close()
	}
})

it("the old default model moves to Bots without a model, and the old helper model moves to rulesModel and botMemoryModel", async () => {
	const database = await PostgresTest.start()
	const before = await mkdtemp(join(tmpdir(), "openbot-migrations-"))
	await using runtime = ManagedRuntime.make(
		DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }).pipe(
			Layer.provide(NodeServices.layer),
		),
	)
	const selection = (model: string) => ({
		_tag: "Config.Selection",
		provider: "prov_a",
		model,
	})
	const bot = (id: string, organizationId: string, extra: object) => ({
		kind: "agent",
		organization_id: organizationId,
		id,
		owner: "user_a",
		scope: "user_a",
		status: "main",
		body: JSON.stringify({ id, name: id, ...extra }),
	})
	try {
		for (const name of await readdir(migrations))
			if (name < "20261022072957_move_default_model")
				await cp(join(migrations, name), join(before, name), {
					recursive: true,
				})
		await runtime.runPromise(
			Effect.gen(function* () {
				const db = yield* Db.make
				yield* migrate(db, { migrationsFolder: before })
				const sql = yield* PgClient.PgClient
				const settings = [
					[
						"org_a",
						{
							defaultModel: selection("big"),
							helperModel: null,
							decisionModel: null,
						},
					],
					[
						"org_b",
						{
							defaultModel: selection("big"),
							helperModel: selection("small"),
							decisionModel: null,
						},
					],
					[
						"org_c",
						{ defaultModel: null, helperModel: null, decisionModel: null },
					],
				] as const
				for (const [id, document] of settings)
					yield* sql`insert into openbot_settings ${sql.insert({
						scope_kind: "organization",
						scope_id: id,
						document: JSON.stringify(document),
						version: 1,
						updated_at: 1,
					})}`
				for (const row of [
					bot("bot_plain", "org_a", {}),
					bot("bot_own", "org_a", { model: selection("own") }),
					bot("bot_none", "org_c", {}),
				])
					yield* sql`insert into openbot_agent_records ${sql.insert(row)}`
			}),
		)
		await runtime.runPromise(DatabasePostgres.migrate)
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const bots = yield* sql<{
					readonly id: string
					readonly body: string
				}>`select id, body from openbot_bot_records order by id`
				assert.deepStrictEqual(
					bots.map((row) => [row.id, JSON.parse(row.body).model]),
					[
						["bot_none", undefined],
						["bot_own", selection("own")],
						["bot_plain", selection("big")],
					],
				)
				const settings = yield* sql<{
					readonly scope_id: string
					readonly document: string
				}>`select scope_id, document from openbot_settings where scope_kind <> 'member' order by scope_id`
				assert.deepStrictEqual(
					settings.map((row) => [row.scope_id, JSON.parse(row.document)]),
					[
						[
							"org_a",
							{
								rulesModel: selection("big"),
								botMemoryModel: selection("big"),
								planApproval,
							},
						],
						[
							"org_b",
							{
								rulesModel: selection("small"),
								botMemoryModel: selection("small"),
								planApproval,
							},
						],
						[
							"org_c",
							{
								rulesModel: null,
								botMemoryModel: null,
								planApproval,
							},
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
