import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Effect,
	Layer,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Store from "../src/execution/Store.ts"
import * as Watches from "../src/apps/DeveloperWatches.ts"
import * as Rows from "../src/apps/DeveloperRows.ts"
import * as Postgres from "./PostgresTest.ts"
import * as Db from "../src/database/Database.ts"

const database = Layer.effectDiscard(Database.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(Postgres.start, (db) =>
				Database.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = Watches.layer.pipe(
	Layer.provideMerge(Store.layer),
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)

layer(services, { excludeTestServices: true })((it) => {
	it.effect(
		"concurrent checks have one owner and a rollback leaves no watch",
		() =>
			Effect.gen(function* () {
				const watches = yield* Watches.DeveloperWatches
				const store = yield* Store.Store
				const sql = yield* SqlClient.SqlClient
				const ref = { kind: "App", id: "https://example.test/app" } as const
				const keys = yield* Effect.all(
					Arr.makeBy(12, () => watches.ensure(ref, 1000)),
					{ concurrency: "unbounded" },
				)
				const key = keys[0]!
				assert.isTrue(Arr.every(keys, (value) => value.id === key.id))
				const prior = yield* store.get(key)
				yield* sql
					.withTransaction(
						watches.request(ref).pipe(Effect.andThen(Effect.fail("rollback"))),
					)
					.pipe(Effect.flip)
				assert.deepEqual(yield* store.get(key), prior)
				assert.equal((yield* watches.load(key)).row.nextCheckAt, 1000)
				yield* sql
					.withTransaction(
						watches
							.ensure({ kind: "Proof", id: "rollback" }, 0)
							.pipe(Effect.andThen(Effect.fail("rollback"))),
					)
					.pipe(Effect.flip)
				const absent =
					yield* sql`select 1 from openbot_developer_watches where resource_id = 'rollback'`
				assert.equal(absent.length, 0)
			}),
	)
	it.effect(
		"a check commits its notice and cursor together and ignores a late owner",
		() =>
			Effect.gen(function* () {
				const watches = yield* Watches.DeveloperWatches
				const store = yield* Store.Store
				const sql = yield* SqlClient.SqlClient
				const db = yield* Db.make
				const key = yield* watches.ensure({ kind: "Proof", id: "proof" }, 0)
				const first = yield* store.takeOver(key)
				const second = yield* store.takeOver(key)
				const change = Rows.postNotice(db, "public", "member", {
					id: "proof-notice",
					kind: "AccessChanged",
					cardUrl: null,
					issue: null,
					reason: "ProofRemoved",
					reportId: null,
					createdAt: 100,
					readAt: null,
				}).pipe(Effect.as({ value: undefined, nextCheckAt: 2000 }))
				assert.isTrue(
					Schema.is(Execution.Conflict)(
						yield* watches.complete(first, 0, change).pipe(Effect.flip),
					),
				)
				const before = yield* store.get(key)
				yield* watches
					.complete<undefined, Effect.Error<typeof change> | string, never>(
						second,
						0,
						change.pipe(Effect.andThen(Effect.fail("rollback"))),
					)
					.pipe(Effect.flip)
				assert.equal((yield* watches.load(key)).row.revision, 0)
				assert.equal(
					(yield* sql`select 1 from openbot_developer_notices where id = 'proof-notice'`)
						.length,
					0,
				)
				assert.deepEqual(yield* store.get(key), before)
				yield* watches.complete(second, 0, change)
				const saved = yield* store.get(key)
				assert.equal((yield* watches.load(key)).row.revision, 1)
				assert.equal(
					(yield* sql`select 1 from openbot_developer_notices where id = 'proof-notice'`)
						.length,
					1,
				)
				yield* watches.complete(
					second,
					0,
					Effect.die("A saved check must not run again."),
				)
				assert.equal((yield* store.get(key)).sequence, saved.sequence)
			}),
	)
})
