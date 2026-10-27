import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { Authorization, Execution } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import {
	Array as Arr,
	Effect,
	Layer,
	Option,
	Redacted,
	String as Str,
} from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import { files, fileRefs, organizations } from "../src/database/Schema.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Store from "../src/execution/Store.ts"
import * as Tasks from "../src/files/FileTasks.ts"
import * as Fixture from "./OrganizationFixture.ts"
import * as Postgres from "./PostgresTest.ts"

const database = Layer.effectDiscard(Database.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(Postgres.start, (db) =>
				Database.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = Tasks.layer.pipe(
	Layer.provide(
		Authorizer.layer(Authorization.Auth, {
			policy: () =>
				Effect.succeed(
					Policy.define(Authorization.OpenBot)(function* (_) {
						yield* _.allow("*", "*")
					}),
				),
		}),
	),
	Layer.provide(Fixture.layerDefaultSettings),
	Layer.provideMerge(Store.layer),
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const actor = {
	kind: "member",
	organizationId: "files",
	userId: "user",
} as const
const seed = (id: string, status = "ready") =>
	Effect.gen(function* () {
		const db = yield* Db.make
		yield* db
			.insert(organizations)
			.values({
				id: actor.organizationId,
				name: "Files",
				status: "active",
				createdAt: 0,
			})
			.onConflictDoNothing()
		yield* db.insert(files).values({
			id,
			organizationId: actor.organizationId,
			userId: actor.userId,
			filename: "file.txt",
			mediaType: "text/plain",
			bytes: 5,
			status,
			objectKey: `files/${id}`,
			createdAt: 0,
			updatedAt: 0,
		})
	})
layer(services, { excludeTestServices: true })((it) => {
	it.effect(
		"a new delete can resume ended file work, while unknown work stays stopped",
		() =>
			Effect.gen(function* () {
				const tasks = yield* Tasks.FileTasks
				const store = yield* Store.Store
				const db = yield* Db.make
				const id = "imported-file"
				yield* seed(id, "deleting")
				const old = yield* store.submit(
					"old-file-history",
					Execution.CommandKey.make("file"),
					{
						workflow: "old-history",
						identity: Tasks.identity,
						resource: { kind: "File", id },
						input: {},
					},
				)
				const key = { namespace: "old-file-history", id: old.executionId }
				const fence = yield* store.takeOver(key)
				yield* store.transition(fence, "outcome_unknown")
				yield* db
					.update(files)
					.set({ cleanupExecutionId: key.id })
					.where(eq(files.id, id))
				yield* tasks.remove(actor, id)
				const [unknown] = yield* db.select().from(files).where(eq(files.id, id))
				assert.strictEqual(unknown?.cleanupExecutionId, key.id)
				yield* store.transition(fence, "interrupted")
				yield* tasks.remove(actor, id)
				const [next] = yield* db.select().from(files).where(eq(files.id, id))
				if (next?.cleanupExecutionId == null)
					return yield* Effect.die("Expected a new file task.")
				assert.notStrictEqual(next.cleanupExecutionId, key.id)
				const nextKey = {
					namespace: Tasks.namespace,
					id: Execution.Id.make(next.cleanupExecutionId),
				}
				assert.strictEqual((yield* store.get(nextKey)).status, "queued")
				yield* tasks.remove(actor, id)
				const [again] = yield* db.select().from(files).where(eq(files.id, id))
				assert.strictEqual(again?.cleanupExecutionId, nextKey.id)
				yield* tasks.complete(yield* store.takeOver(nextKey))
			}),
	)
	it.effect(
		"a deletion and its task roll back together, and an old owner cannot remove the row",
		() =>
			Effect.gen(function* () {
				const tasks = yield* Tasks.FileTasks
				const store = yield* Store.Store
				const db = yield* Db.make
				const sql = yield* SqlClient.SqlClient
				const id = "atomic-file"
				yield* seed(id)
				assert.propertyVal(
					yield* tasks
						.remove({ ...actor, userId: "other" }, id)
						.pipe(Effect.flip),
					"_tag",
					"FileNotFound",
				)
				yield* sql
					.withTransaction(
						tasks
							.remove(actor, id)
							.pipe(Effect.andThen(Effect.fail("rollback"))),
					)
					.pipe(Effect.flip)
				const before = (yield* db
					.select()
					.from(files)
					.where(eq(files.id, id)))[0]!
				assert.equal(before.status, "ready")
				assert.isNull(before.cleanupExecutionId)
				assert.equal(
					(yield* sql`select id from openbot_executions where namespace = 'file-maintenance' and resource_id = ${id}`)
						.length,
					0,
				)
				yield* tasks.remove(actor, id)
				const row = (yield* db.select().from(files).where(eq(files.id, id)))[0]!
				assert.equal(row.status, "deleting")
				const key = {
					namespace: Tasks.namespace,
					id: Execution.Id.make(row.cleanupExecutionId!),
				}
				const first = yield* store.takeOver(key)
				const second = yield* store.takeOver(key)
				assert.propertyVal(
					yield* tasks.complete(first).pipe(Effect.flip),
					"_tag",
					"ExecutionConflict",
				)
				assert.equal(yield* tasks.objectKey(second), before.objectKey)
				yield* tasks.complete(second)
				assert.equal((yield* store.get(key)).status, "completed")
				assert.equal(
					(yield* db.select().from(files).where(eq(files.id, id))).length,
					0,
				)
				assert.isTrue(
					Arr.some(
						yield* store.events(key, 0),
						(event) => event.body._tag === "Result",
					),
				)
			}),
	)
	it.effect(
		"retention keeps referenced files and concurrent collectors create one task per file",
		() =>
			Effect.gen(function* () {
				const tasks = yield* Tasks.FileTasks
				const store = yield* Store.Store
				const db = yield* Db.make
				yield* seed("pending-file", "pending")
				yield* seed("unused-file")
				yield* seed("used-file")
				yield* db
					.insert(fileRefs)
					.values({ file: "used-file", namespace: "member", chat: "chat" })
				yield* Effect.all(
					Arr.makeBy(8, () => tasks.collect),
					{ concurrency: "unbounded" },
				)
				const rows = yield* db
					.select()
					.from(files)
					.where(eq(files.organizationId, actor.organizationId))
				assert.equal(rows.length, 3)
				for (const row of rows) {
					if (row.id === "used-file") {
						assert.equal(row.status, "ready")
						assert.isNull(row.cleanupExecutionId)
					} else {
						assert.equal(row.status, "deleting")
						assert.isNotNull(row.cleanupExecutionId)
					}
				}
				const pending = Option.getOrThrow(
					Arr.findFirst(rows, (row) => row.id === "pending-file"),
				)
				const key = {
					namespace: Tasks.namespace,
					id: Execution.Id.make(pending.cleanupExecutionId!),
				}
				// The saved object reference remains usable if another database operation removed the metadata.
				yield* db.delete(files).where(eq(files.id, pending.id))
				assert.equal(yield* tasks.objectKey(key), pending.objectKey)
				yield* tasks.complete(yield* store.takeOver(key))
				yield* db
					.delete(fileRefs)
					.where(and(eq(fileRefs.file, "used-file"), eq(fileRefs.chat, "chat")))
				assert.equal(yield* tasks.collect, 1)
			}),
	)
})
