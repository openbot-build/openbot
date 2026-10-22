// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
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
import * as Postgres from "./PostgresTest.ts"
import * as Db from "../src/database/Database.ts"

test("Drizzle writes join the surrounding SQL transaction and roll back with it", async () => {
	const database = await Postgres.start()
	const runtime = ManagedRuntime.make(
		Database.layer({ databaseUrl: Redacted.make(database.url) }).pipe(
			Layer.provide(NodeServices.layer),
		),
	)
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* Database.migrate
				const sql = yield* PgClient.PgClient
				const db = yield* Db.make
				const failed = yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* db
								.insert(appDrafts)
								.values({ owner: "alice", id: "first", body: "{}" })
							// A nested transaction is a savepoint inside the same transaction.
							yield* sql.withTransaction(
								db
									.insert(appDrafts)
									.values({ owner: "alice", id: "second", body: "{}" }),
							)
							return yield* Effect.fail("stop")
						}),
					)
					.pipe(Effect.flip)
				assert.equal(failed, "stop")
				assert.deepEqual(yield* db.select().from(appDrafts), [])
			}),
		)
	} finally {
		await runtime.dispose()
		await database.close()
	}
})

test("the Developer tables keep one membership for each account and remove dependent rows with their parent", async () => {
	const database = await Postgres.start()
	const runtime = ManagedRuntime.make(
		Database.layer({ databaseUrl: Redacted.make(database.url) }).pipe(
			Layer.provide(NodeServices.layer),
		),
	)
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* Database.migrate
				const db = yield* Db.make
				const scope = JSON.stringify({
					_tag: "AppCard",
					cardUrl: "https://a.test",
				})
				yield* db.insert(developerClaims).values({
					id: "claim",
					owner: "alice",
					scopeKey: "card:https://a.test",
					scope,
					token: "token",
					status: "Confirmed",
					createdAt: 0,
					expiresAt: 1,
				})
				yield* db.insert(developerProofs).values({
					id: "claim",
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
						.values({ id, proofId: "claim", owner: "bob", role: "viewer" })
						.onConflictDoNothing()
						.returning({ id: developerMembers.id })
				assert.equal((yield* member("first")).length, 1)
				assert.equal((yield* member("second")).length, 0)
				yield* db.insert(developerInvitations).values({
					id: "invitation",
					proofId: "claim",
					owner: "alice",
					role: "viewer",
					expiresAt: 1,
					status: "Pending",
				})
				yield* db.delete(developerClaims).where(eq(developerClaims.id, "claim"))
				assert.deepEqual(yield* db.select().from(developerProofs), [])
				assert.deepEqual(yield* db.select().from(developerMembers), [])
				assert.deepEqual(yield* db.select().from(developerInvitations), [])

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
				assert.deepEqual(yield* db.select().from(developerTestFlows), [])
			}),
		)
	} finally {
		await runtime.dispose()
		await database.close()
	}
})
