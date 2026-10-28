import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { Authorization, Execution } from "@openbot-build/domain"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import {
	Array as Arr,
	Effect,
	Layer,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as Migrations from "../src/database/Migrations.ts"
import * as Convert from "../src/database/conversion/Convert.ts"
import * as Checks from "../src/database/conversion/Checks.ts"
import * as Resources from "../src/database/conversion/Resources.ts"
import * as Progress from "../src/database/conversion/Progress.ts"
import * as Authority from "../src/database/conversion/Authority.ts"
import * as Imported from "../src/database/conversion/Executions.ts"
import * as Legacy from "../src/database/conversion/LegacyV1.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as MigrationTest from "./MigrationTest.ts"
import * as PostgresTest from "./PostgresTest.ts"

const secret = Redacted.make("test:" + Str.repeat(32)("11"))
const database = () =>
	Store.layer.pipe(
		Layer.provideMerge(
			Layer.unwrap(
				Effect.map(PostgresTest.start, (database) =>
					Layer.merge(
						DatabasePostgres.layer({
							databaseUrl: Redacted.make(database.url),
						}),
						Secrets.layer(secret),
					),
				),
			),
		),
		Layer.provideMerge(NodeServices.layer),
	)
const json = Schema.fromJsonString(Schema.Json)
const encode = Schema.encodeEffect(json)

it.layer(database(), { excludeTestServices: true })((it) => {
	it.effect(
		"old files and model holds keep their data and all saved secrets are checked again",
		() =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const secrets = yield* Secrets.Secrets
				const db = yield* Db.make
				const folder = yield* MigrationTest.migrationsWhere(
					(name) => name < "20261027172121_data_upgrade_gate",
				)
				yield* migrate(db, { migrationsFolder: folder })
				yield* sql`insert into openbot_organizations (id, name, status, created_at) values ('org', 'Organization', 'active', 1)`
				yield* sql`insert into openbot_auth_user (id, name, email, email_verified) values ('person', 'Person', 'person@example.com', true)`
				const policy = yield* Schema.encodeEffect(Authorization.PolicySchema)(
					Authorization.emptyPolicy,
				)
				yield* sql`insert into openbot_members (organization_id, user_id, status, roles, policy, joined_at) values ('org', 'person', 'active', '["member"]', ${policy}, 1)`
				yield* sql`insert into openbot_files ${sql.insert({
					id: "file",
					organization_id: "org",
					user_id: "person",
					filename: "file.txt",
					media_type: "text/plain",
					bytes: 20,
					status: "deleting",
					object_key: "objects/file",
					created_at: 1,
					updated_at: 2,
				})}`
				const apiKey = yield* secrets.seal(
					"private model key",
					"openbot_model_providers:provider:api_key",
				)
				yield* sql`insert into openbot_model_providers ${sql.insert({
					id: "provider",
					owner_kind: "organization",
					owner_id: "org",
					kind: "openai",
					name: "Provider",
					api_key: apiKey,
					version: 1,
					created_at: 1,
					updated_at: 1,
				})}`
				yield* sql`insert into openbot_vaults (organization_id, id, name, version, created_at, updated_at) values ('org', 'vault', 'Vault', 1, 1, 1)`
				yield* sql`insert into openbot_vault_items ${sql.insert({
					organization_id: "org",
					id: "item",
					vault_id: "vault",
					name: "Item",
					description: "Saved key",
					source: '{"_tag":"Builtin"}',
					fields: '["key"]',
					exits: "[]",
					values: yield* secrets.seal(
						'{"key":"private vault key"}',
						"openbot_vault_items:item:values",
					),
					version: 1,
					created_at: 1,
					updated_at: 1,
				})}`
				const usage = {
					status: "pending",
					estimated_tokens: 20,
					organization_id: "org",
					occurred_at: 1,
					source: "turn",
					user_id: "person",
					provider_id: "provider",
					provider_owner: "organization",
					model_id: "model",
					input_uncached: 0,
					input_cache_read: 0,
					input_cache_write: 0,
					output_text: 0,
					output_reasoning: 0,
					cost_micros: 0,
					charged: false,
				}
				yield* sql`insert into openbot_usage_events ${sql.insert({
					...usage,
					id: "usage",
					reservation_known: true,
					reserved_micros: 400,
				})}`
				// This old call has no saved amount.
				yield* sql`insert into openbot_usage_events ${sql.insert({
					...usage,
					id: "usage-lost",
					status: "unknown",
					reservation_known: false,
					reserved_micros: 0,
				})}`
				yield* Migrations.initialize
				yield* Progress.withMaintenance(Resources.run)
				yield* Progress.withMaintenance(Resources.run)
				yield* Resources.verify
				yield* Checks.sealed
				yield* Imported.verify
				yield* Checks.counts
				const [file] = yield* sql<{
					object_key: string
					cleanup_execution_id: string
				}>`select object_key, cleanup_execution_id from openbot_files where id = 'file'`
				assert.strictEqual(file?.object_key, "objects/file")
				assert.isString(file?.cleanup_execution_id)
				const [call] = yield* sql<{
					status: string
					reserved_micros: bigint
					estimated_micros: bigint
					charged: boolean
				}>`select status, reserved_micros, estimated_micros, charged from openbot_usage_events where id = 'usage'`
				assert.deepStrictEqual(call, {
					status: "unknown",
					reserved_micros: 400n,
					estimated_micros: 400n,
					charged: false,
				})
				const [lost] = yield* sql<{
					status: string
					reserved_micros: bigint
					estimated_micros: bigint | null
				}>`select status, reserved_micros, estimated_micros from openbot_usage_events where id = 'usage-lost'`
				assert.deepStrictEqual(lost, {
					status: "unknown",
					reserved_micros: 0n,
					estimated_micros: null,
				})
				const [count] = yield* sql<{
					count: number
				}>`select count(*)::float8 as count from openbot_executions`
				assert.strictEqual(count?.count, 1)
				yield* sql`update openbot_model_providers set api_key = 'broken saved key' where id = 'provider'`
				assert.instanceOf(
					yield* Effect.flip(Resources.verify),
					Progress.InvalidRecord,
				)
				yield* sql`update openbot_model_providers set api_key = ${apiKey} where id = 'provider'`
				yield* Resources.verify
				assert.instanceOf(
					yield* Effect.flip(Effect.scoped(Migrations.checkStartup)),
					Progress.UpgradeRequired,
				)
			}),
	)
})

it.layer(database(), { excludeTestServices: true })((it) => {
	it.effect(
		"an empty database is ready and a live server blocks maintenance",
		() =>
			Effect.gen(function* () {
				yield* Migrations.initialize
				yield* Migrations.initialize
				yield* Convert.run
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* Migrations.checkStartup
						const blocked = yield* Effect.flip(
							Progress.withMaintenance(Effect.void),
						)
						assert.instanceOf(blocked, Progress.UpgradeRequired)
						if (!Schema.is(Progress.UpgradeRequired)(blocked))
							return yield* Effect.die("Expected a maintenance failure.")
						assert.strictEqual(blocked.reason, "Maintenance")
					}),
				)
				yield* Progress.withMaintenance(Effect.void)
				const missing = Authority.missing({
					organizationId: "org",
					userId: "person",
				})
				assert.strictEqual(missing._tag, "NeedsAuthorization")
				assert.isFalse("caller" in missing)
			}),
	)
})

it.layer(database(), { excludeTestServices: true })((it) => {
	it.effect(
		"a broken batch stops the move and its earlier batch resumes once",
		() =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const secrets = yield* Secrets.Secrets
				const db = yield* Db.make
				const folder = yield* MigrationTest.migrationsWhere(
					(name) => name < "20261026084803_execution_records",
				)
				yield* migrate(db, { migrationsFolder: folder })
				for (let index = 0; index <= 100; index++) {
					const id = Str.padStart(3, "0")(String(index))
					const value = {
						id,
						chat: "chat",
						turn: "turn",
						text: "private memory",
						reply: "saved reply",
						at: 1,
					}
					yield* sql`insert into openbot_bot_records ${sql.insert({
						kind: "confession",
						organization_id: "org",
						id,
						owner: "bot",
						scope: "chat",
						status: "",
						body: index === 100 ? "broken private input" : yield* encode(value),
					})}`
				}
				yield* Migrations.initialize
				const first = yield* Effect.flip(
					Progress.withMaintenance(Convert.prepare),
				)
				assert.instanceOf(first, Progress.InvalidRecord)
				if (!Schema.is(Progress.InvalidRecord)(first))
					return yield* Effect.die("Expected an invalid record.")
				const rows = yield* sql<{
					id: string
					body: string
				}>`select id, body from openbot_bot_records order by id`
				assert.strictEqual(rows.length, 101)
				const firstRow = rows[0]
				if (firstRow === undefined)
					return yield* Effect.die("Expected the first saved row.")
				const savedBody = firstRow.body
				assert.notInclude(savedBody, "private memory")
				assert.strictEqual(rows[100]?.body, "broken private input")
				const [step] = yield* sql<{
					rows: string
					complete: boolean
				}>`select rows, complete from openbot_data_upgrade_steps where step = 'seal:confession'`
				assert.strictEqual(Number(step?.rows), 100)
				assert.strictEqual(step?.complete, false)
				const [report] = yield* sql<{
					cause: string
				}>`select cause from openbot_data_upgrade_failures where id = ${first.errorId}`
				if (report === undefined)
					return yield* Effect.die("Expected a sealed failure report.")
				assert.notInclude(report.cause, "broken private input")
				const cause = yield* secrets.open(
					report.cause,
					`data-upgrade-failure:${first.errorId}`,
				)
				assert.include(cause, "Expected a valid JSON string")
				yield* sql`update openbot_bot_records set body = ${yield* encode({ id: "100", chat: "chat", turn: "turn", text: "repaired memory", reply: "saved reply", at: 1 })} where id = '100'`
				yield* Progress.withMaintenance(Convert.prepare)
				yield* Progress.withMaintenance(Convert.prepare)
				yield* Checks.sealed
				const [kept] = yield* sql<{
					body: string
				}>`select body from openbot_bot_records where id = '000'`
				assert.strictEqual(kept?.body, savedBody)
				const [finished] = yield* sql<{
					rows: string
					complete: boolean
				}>`select rows, complete from openbot_data_upgrade_steps where step = 'seal:confession'`
				assert.strictEqual(Number(finished?.rows), 101)
				assert.strictEqual(finished?.complete, true)
				const startup = yield* Effect.flip(
					Effect.scoped(Migrations.checkStartup),
				)
				assert.instanceOf(startup, Progress.UpgradeRequired)
				const [gate] = yield* sql<{
					state: string
					checked_at: string | null
				}>`select state, checked_at from openbot_data_upgrades`
				assert.deepStrictEqual(gate, { state: "blocked", checked_at: null })
				const converted = yield* sql<{
					id: string
					body: string
				}>`select id, body from openbot_bot_records order by id`
				yield* Effect.forEach(converted, (row) =>
					Effect.gen(function* () {
						const binding = yield* encode([
							"bot-record",
							"confession",
							"org",
							row.id,
						])
						const value = yield* secrets.open(row.body, binding)
						yield* Schema.decodeEffect(json)(value)
					}),
				)
				assert.strictEqual(Arr.length(converted), 101)
				yield* sql`update openbot_bot_records set body = 'broken sealed data' where id = '000'`
				assert.instanceOf(
					yield* Effect.flip(Checks.sealed),
					Progress.InvalidRecord,
				)
			}),
	)
})

it.layer(Store.layer.pipe(Layer.provideMerge(database())), {
	excludeTestServices: true,
})((it) => {
	it.effect(
		"imported history uses the shared log and never starts outside work",
		() =>
			Effect.gen(function* () {
				yield* Migrations.initialize
				const sql = yield* PgClient.PgClient
				const writer = yield* Imported.make
				const store = yield* Store.Store
				const input: Imported.RecordInput = {
					namespace: "org",
					collection: "app",
					sourceKey: "old-call",
					resource: { kind: "App", id: "old-call" },
					input: {
						_tag: "Imported",
						format: 1,
						source: Legacy.source,
						owner: { organizationId: "org", userId: "person" },
						authority: Authority.missing({
							organizationId: "org",
							userId: "person",
						}),
						reason: "OutsideResultUnknown",
						history: { id: "old-call", note: "private history" },
					},
					status: "outcome_unknown",
					createdAt: 1,
					updatedAt: 2,
					calls: [
						{
							step: "read",
							attempt: 1,
							status: "completed",
							input: { request: "private read" },
							result: { value: "private result" },
						},
						...Arr.makeBy(100, (index) => ({
							step: `saved:${index}`,
							attempt: 1,
							status: "completed" as const,
							input: { index },
							result: { saved: true },
						})),
						{
							step: "write",
							attempt: 1,
							status: "outcome_unknown",
							input: { request: "private write" },
							result: null,
						},
					],
				}
				yield* sql
					.withTransaction(
						writer.write(input).pipe(Effect.andThen(Effect.fail("rollback"))),
					)
					.pipe(Effect.flip)
				const [rolledBack] = yield* sql<{
					count: number
				}>`select count(*)::float8 as count from openbot_executions`
				assert.strictEqual(rolledBack?.count, 0)
				const key = yield* sql.withTransaction(writer.write(input))
				assert.deepStrictEqual(
					yield* sql.withTransaction(writer.write(input)),
					key,
				)
				const saved = yield* store.loadService(key, Imported.serviceId)
				assert.deepStrictEqual(saved.input, input.input)
				assert.strictEqual(saved.identity.owner.kind, "organization")
				assert.isTrue(
					Schema.is(Execution.Forbidden)(
						yield* store.loadMember(key).pipe(Effect.flip),
					),
				)
				const record = yield* store.get(key)
				assert.strictEqual(record.status, "outcome_unknown")
				assert.strictEqual(record.failure?.category, "outcome_unknown")
				const events = yield* store.events(key, 0)
				assert.deepStrictEqual(
					Arr.map(events, (event) => event.sequence),
					[1, 2, 3],
				)
				assert.strictEqual(events[events.length - 1]?.body._tag, "State")
				yield* Imported.verify
				const calls = yield* store.calls(key)
				assert.strictEqual(calls.length, 102)
				const unknown = Arr.findFirst(
					calls,
					(call) => call.status === "outcome_unknown",
				)
				if (unknown._tag === "None")
					return yield* Effect.die("Expected an unknown call.")
				const decision = yield* store.decision(key, unknown.value.id)
				assert.strictEqual(decision._tag, "Some")
				if (decision._tag === "Some")
					assert.deepStrictEqual(decision.value.choices, ["stop"])
				const [raw] = yield* sql<{
					input: string
				}>`select input from openbot_executions where id = ${key.id}`
				assert.notInclude(raw?.input ?? "", "private history")
				const [outbox] = yield* sql<{
					count: number
				}>`select count(*)::float8 as count from openbot_execution_outbox`
				assert.strictEqual(outbox?.count, 0)
				const changed = yield* sql
					.withTransaction(
						writer.write({
							...input,
							input: { ...input.input, history: { id: "changed" } },
						}),
					)
					.pipe(Effect.flip)
				assert.isTrue(Schema.is(Imported.InvalidImport)(changed))
				const invalid = yield* sql
					.withTransaction(
						writer.write({ ...input, sourceKey: "no-call", calls: [] }),
					)
					.pipe(Effect.flip)
				assert.isTrue(Schema.is(Imported.InvalidImport)(invalid))
				const [report] = yield* sql<{
					id: string
					cause: string
				}>`select id, cause from openbot_execution_failures where execution_id = ${key.id}`
				if (report === undefined)
					return yield* Effect.die("Expected the saved import error.")
				yield* sql`update openbot_execution_failures set cause = 'broken sealed data' where id = ${report.id}`
				assert.instanceOf(
					yield* Effect.flip(Imported.verify),
					Progress.InvalidRecord,
				)
				yield* sql`update openbot_execution_failures set cause = ${report.cause} where id = ${report.id}`
				yield* sql`update openbot_executions set service_id = 'another-service' where id = ${key.id}`
				assert.instanceOf(
					yield* Effect.flip(Imported.verify),
					Progress.InvalidRecord,
				)
				yield* sql`update openbot_executions set service_id = ${Imported.serviceId} where id = ${key.id}`
				yield* Imported.verify
				yield* Checks.sealed
				const [lastCall] = yield* sql<{
					id: string
					input: string
				}>`select id, input from openbot_execution_calls where execution_id = ${key.id} order by id desc limit 1`
				if (lastCall === undefined)
					return yield* Effect.die("Expected the last saved call.")
				yield* sql`update openbot_execution_calls set input = 'broken sealed data' where id = ${lastCall.id}`
				assert.instanceOf(
					yield* Effect.flip(Imported.verify),
					Progress.InvalidRecord,
				)
				yield* sql`update openbot_execution_calls set input = ${lastCall.input} where id = ${lastCall.id}`
				yield* Imported.verify
				yield* sql`update openbot_executions set context_kind = 'Chat', context_id = 'another-chat' where id = ${key.id}`
				assert.instanceOf(
					yield* Effect.flip(Checks.sealed),
					Progress.InvalidRecord,
				)
				yield* sql`update openbot_executions set context_kind = null, context_id = null where id = ${key.id}`
				yield* Checks.sealed
			}),
	)
})
