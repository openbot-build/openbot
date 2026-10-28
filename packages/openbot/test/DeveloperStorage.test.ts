import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { DeveloperApi as Api } from "@openbot-build/api"
import { Effect, Layer, Redacted, Schema } from "effect"
import { eq } from "drizzle-orm"
import {
	appDrafts,
	developerClaims,
	developerInvitations,
	developerMembers,
	developerProofs,
	developerTestFlows,
	developerTests,
} from "../src/database/Schema.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Rows from "../src/apps/DeveloperRows.ts"
import * as Postgres from "./PostgresTest.ts"
import * as Db from "../src/database/Database.ts"

/** A new PostgreSQL server for one test, with the OpenBot database layer on it. */
const freshDatabase = Layer.unwrap(
	Effect.map(Postgres.start, (database) =>
		Database.layer({ databaseUrl: Redacted.make(database.url) }),
	),
).pipe(Layer.provide(NodeServices.layer))

it.live(
	"Drizzle writes join the surrounding SQL transaction and roll back with it",
	() =>
		Effect.gen(function* () {
			yield* Database.migrate
			const sql = yield* PgClient.PgClient
			const db = yield* Db.make
			const failed = yield* sql
				.withTransaction(
					Effect.gen(function* () {
						yield* db.insert(appDrafts).values({
							owner: "alice",
							id: "00000000-0000-4000-8000-000000000001",
							body: "{}",
						})
						// A nested transaction is a savepoint inside the same transaction.
						yield* sql.withTransaction(
							db.insert(appDrafts).values({
								owner: "alice",
								id: "00000000-0000-7000-8000-000000000002",
								body: "{}",
							}),
						)
						return yield* Effect.fail("stop")
					}),
				)
				.pipe(Effect.flip)
			assert.strictEqual(failed, "stop")
			assert.deepStrictEqual(yield* db.select().from(appDrafts), [])
		}).pipe(Effect.provide(freshDatabase)),
)

it.live(
	"the Developer tables keep one membership for each account and remove dependent rows with their parent",
	() =>
		Effect.gen(function* () {
			yield* Database.migrate
			const db = yield* Db.make
			const scope = yield* Schema.encodeEffect(Rows.Json(Api.ManagementScope))({
				_tag: "AppCard",
				cardUrl: "https://a.test",
			})
			yield* db.insert(developerClaims).values({
				id: "00000000-0000-4000-8000-000000000001",
				owner: "alice",
				scopeKey: "card:https://a.test",
				scope,
				token: "token",
				status: "Confirmed",
				createdAt: 0,
				expiresAt: 1,
			})
			yield* db.insert(developerProofs).values({
				id: "00000000-0000-4000-8000-000000000001",
				owner: "alice",
				scopeKey: "card:https://a.test",
				scope,
				token: "token",
				transition: 0,
				status: "Confirmed",
				confirmedAt: 0,
				validUntil: 1,
				nextVerificationAt: 1,
			})
			const member = (id: string) =>
				db
					.insert(developerMembers)
					.values({
						id,
						proofId: "00000000-0000-4000-8000-000000000001",
						owner: "bob",
						role: "viewer",
					})
					.onConflictDoNothing()
					.returning({ id: developerMembers.id })
			assert.strictEqual(
				(yield* member("00000000-0000-7000-8000-000000000002")).length,
				1,
			)
			assert.strictEqual(
				(yield* member("00000000-0000-7000-8000-000000000003")).length,
				0,
			)
			yield* db.insert(developerInvitations).values({
				id: "invitation",
				proofId: "00000000-0000-4000-8000-000000000001",
				owner: "alice",
				role: "viewer",
				expiresAt: 1,
				status: "Pending",
			})
			const sql = yield* PgClient.PgClient
			const [stored] = yield* sql<{
				id: string
				bytes: number
				proofBytes: number
			}>`
				select id, pg_column_size(id) as bytes, pg_column_size(proof_id) as "proofBytes"
				from openbot_developer_members
			`
			assert.deepStrictEqual(stored, {
				id: "00000000-0000-7000-8000-000000000002",
				bytes: 16,
				proofBytes: 16,
			})
			yield* db
				.delete(developerClaims)
				.where(eq(developerClaims.id, "00000000-0000-4000-8000-000000000001"))
			assert.deepStrictEqual(yield* db.select().from(developerProofs), [])
			assert.deepStrictEqual(yield* db.select().from(developerMembers), [])
			assert.deepStrictEqual(yield* db.select().from(developerInvitations), [])

			yield* db.insert(developerTests).values({
				id: "test",
				owner: "alice",
				cardUrl: "https://a.test",
				status: "Queued",
				cleanup: "NotRequired",
				expiresAt: 1,
				value: "{}",
			})
			yield* db.insert(developerTestFlows).values({
				flowId: "flow",
				testId: "test",
				owner: "alice",
				status: "Waiting",
				expiresAt: 1,
				value: "{}",
			})
			yield* db.delete(developerTests).where(eq(developerTests.id, "test"))
			assert.deepStrictEqual(yield* db.select().from(developerTestFlows), [])
		}).pipe(Effect.provide(freshDatabase)),
)
