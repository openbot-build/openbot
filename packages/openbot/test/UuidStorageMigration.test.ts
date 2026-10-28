import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { Crypto, Effect, Layer, Redacted, Schema } from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as Tables from "../src/database/Schema.ts"
import * as MigrationTest from "./MigrationTest.ts"
import * as PostgresTest from "./PostgresTest.ts"

const ownMigration = "20261028180513_binary_uuid"
const database = Layer.unwrap(
	Effect.map(PostgresTest.start, (database) =>
		DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
	),
).pipe(Layer.provideMerge(NodeServices.layer))

const columns = [
	["openbot_developer_claims", "id"],
	["openbot_developer_proofs", "id"],
	["openbot_developer_members", "id"],
	["openbot_developer_members", "proof_id"],
	["openbot_developer_invitations", "proof_id"],
	["openbot_developer_reports", "id"],
	["openbot_developer_notices", "report_id"],
	["openbot_developer_index_requests", "id"],
	["openbot_tokens", "id"],
	["openbot_app_drafts", "id"],
	["openbot_execution_commands", "id"],
	["openbot_execution_outbox", "command_id"],
	["openbot_execution_permits", "id"],
	["openbot_resource_owners", "lease"],
	["openbot_resource_owners", "node"],
	["openbot_resource_leases", "lease"],
	["openbot_resource_leases", "node"],
	["openbot_data_upgrade_failures", "id"],
] as const

it.layer(database, { excludeTestServices: true })((it) => {
	it.effect("UUID storage keeps old IDs and links and accepts version 7", () =>
		Effect.gen(function* () {
			const sql = yield* PgClient.PgClient
			const db = yield* Db.make
			const crypto = yield* Crypto.Crypto
			const before = yield* MigrationTest.migrationsWhere(
				(name) => name < ownMigration,
			)
			const through = yield* MigrationTest.migrationsWhere(
				(name) => name <= ownMigration,
			)
			yield* migrate(db, { migrationsFolder: before })
			const oldId = "00000000-0000-4000-8000-000000000001"
			const executionId = "import_saved_work"
			yield* sql`insert into openbot_executions ${sql.insert({
				namespace: "uuid-storage",
				id: executionId,
				workflow: "test",
				resource_kind: "Chat",
				resource_id: "saved-chat",
				organization_id: "saved-organization",
				user_id: "saved-user",
				identity: "sealed identity",
				input: "sealed input",
				status: "queued",
				created_at: 1,
				updated_at: 1,
			})}`
			yield* sql`insert into openbot_data_upgrades ${sql.insert({
				version: "uuid-storage",
				source: "test",
				state: "blocked",
				counts: "[]",
				started_at: 1,
				updated_at: 1,
			})}`
			yield* db.insert(Tables.organizations).values({
				id: "saved-organization",
				name: "Saved group",
				status: "active",
				createdAt: 1,
			})
			yield* sql`insert into openbot_auth_user ${sql.insert({
				id: "saved-user",
				name: "Saved user",
				email: "saved@example.com",
			})}`
			const write = (id: string) =>
				Effect.gen(function* () {
					const db = yield* Db.make
					const claim = {
						namespace: "uuid-storage",
						id,
						owner: "saved-user",
						scopeKey: id,
						scope: "saved scope",
						token: "saved token",
						status: "Active",
					}
					yield* db.insert(Tables.developerClaims).values({
						...claim,
						createdAt: 1,
						expiresAt: 100,
					})
					yield* db.insert(Tables.developerProofs).values({
						...claim,
						transition: 1,
						validUntil: 100,
						nextVerificationAt: 100,
					})
					const member = {
						namespace: "uuid-storage",
						id,
						proofId: id,
						owner: "saved-user",
						role: "Admin",
					}
					yield* db.insert(Tables.developerMembers).values(member)
					yield* db.insert(Tables.developerInvitations).values({
						...member,
						id: `secret-${id}`,
						expiresAt: 100,
						status: "Pending",
					})
					yield* db.insert(Tables.developerReports).values({
						namespace: "uuid-storage",
						id,
						cardUrl: "https://example.com/app.json",
						checkedAt: 1,
						report: "saved report",
					})
					yield* db.insert(Tables.developerNotices).values({
						namespace: "uuid-storage",
						id: `saved-${id}`,
						owner: "saved-user",
						kind: "IssueFound",
						reportId: id,
						createdAt: 1,
					})
					yield* db.insert(Tables.developerIndexRequests).values({
						namespace: "uuid-storage",
						id,
						owner: "saved-user",
						cardUrl: "https://example.com/app.json",
						generation: "saved-generation",
						acceptedAt: 1,
					})
					yield* db.insert(Tables.tokens).values({
						id,
						organizationId: "saved-organization",
						userId: "saved-user",
						name: "Saved token",
						prefix: "saved",
						hash: id,
						policy: "saved policy",
						createdAt: 1,
					})
					yield* db.insert(Tables.appDrafts).values({
						owner: "saved-user",
						id,
						body: "saved draft",
					})
					yield* db.insert(Tables.executionCommands).values({
						namespace: "uuid-storage",
						id,
						executionId,
						organizationId: "saved-organization",
						userId: "saved-user",
						key: id,
						body: "sealed command",
						kind: "start",
						sequence: 1,
						createdAt: 1,
					})
					yield* db.insert(Tables.executionOutbox).values({
						namespace: "uuid-storage",
						commandId: id,
						executionId,
						createdAt: 1,
					})
					yield* db.insert(Tables.executionPermits).values({
						namespace: "uuid-storage",
						executionId,
						generation: 1,
						id,
						pool: "test",
						deadline: 100,
					})
					const address = {
						namespace: "uuid-storage",
						kind: "test",
						id,
						lease: id,
						node: id,
						host: "127.0.0.1",
						port: 1,
					}
					yield* db.insert(Tables.resourceOwners).values(address)
					yield* db.insert(Tables.resourceLeases).values(address)
					yield* db.insert(Tables.dataUpgradeFailures).values({
						id,
						version: "uuid-storage",
						step: "test",
						cause: "sealed cause",
						createdAt: 1,
					})
				})
			yield* write(oldId)
			yield* migrate(db, { migrationsFolder: through })
			yield* migrate(db, { migrationsFolder: through })
			const newId = yield* crypto.randomUUIDv7()
			assert.isTrue(Schema.is(Schema.String.check(Schema.isUUID(7)))(newId))
			// The server starts with a new pool after the schema change.
			yield* write(newId).pipe(Effect.provide(PgClient.layer(sql.config)))
			const nativeColumns = yield* sql`
                select table_name, column_name from information_schema.columns
                where table_schema = 'public' and data_type = 'uuid'`
			assert.strictEqual(nativeColumns.length, columns.length)
			for (const [table, column] of columns) {
				const rows = yield* sql<{
					readonly id: string
					readonly type: string
					readonly bytes: number
				}>`select ${sql(column)}::text as id,
                    pg_typeof(${sql(column)})::text as type,
                    pg_column_size(${sql(column)}) as bytes
                    from ${sql(table)} order by ${sql(column)}`
				assert.deepEqual(rows, [
					{ id: oldId, type: "uuid", bytes: 16 },
					{ id: newId, type: "uuid", bytes: 16 },
				])
			}
			const commands = yield* sql<{
				readonly id: string
				readonly execution: string
				readonly body: string
			}>`select c.id, c.execution_id as execution, c.body
                from openbot_execution_commands c
                join openbot_execution_outbox o
                on o.namespace = c.namespace and o.command_id = c.id
                order by c.id`
			assert.deepEqual(commands, [
				{ id: oldId, execution: executionId, body: "sealed command" },
				{ id: newId, execution: executionId, body: "sealed command" },
			])
			const missingId = yield* crypto.randomUUIDv7()
			const error =
				yield* sql`insert into openbot_execution_outbox ${sql.insert({
					namespace: "uuid-storage",
					command_id: missingId,
					execution_id: executionId,
					created_at: 1,
				})}`.pipe(Effect.flip)
			assert.strictEqual(error.reason._tag, "ConstraintError")
			yield* sql`delete from openbot_developer_claims where id = ${oldId}`
			for (const [table, column] of [
				["openbot_developer_proofs", "id"],
				["openbot_developer_members", "proof_id"],
				["openbot_developer_invitations", "proof_id"],
			] as const) {
				const rows = yield* sql<{ readonly id: string }>`
                    select ${sql(column)} as id from ${sql(table)}`
				assert.deepEqual(rows, [{ id: newId }])
			}
		}),
	)
})
