import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Condition, Domain, Resource } from "@nmnmcc/ability"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { Array as Arr, Effect, Redacted, Schema, String as Str } from "effect"
import { toWhere } from "../src/authorization/Sql.ts"
import * as Db from "../src/database/Database.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"

const resources = pgTable("authorization_test_resources", {
	id: text().primaryKey(),
	ownerUserId: text("owner_user_id"),
	rank: integer(),
})
type Row = typeof resources.$inferSelect
const rows: ReadonlyArray<Row> = [
	{ id: "shared", ownerUserId: null, rank: null },
	{ id: "member", ownerUserId: "member", rank: 1 },
	{ id: "other", ownerUserId: "other", rank: 3 },
]
const RowResource = Resource.make("Row", {
	actions: ["read"],
	fields: {
		id: Schema.String,
		ownerUserId: Schema.NullOr(Schema.String),
		rank: Schema.NullOr(Schema.Finite),
	},
})
const RowDomain = Domain.make({
	principal: Schema.Struct({}),
	resources: [RowResource],
})
const $ = Condition.builder(RowDomain, "Row")
const encodeCondition = Schema.encodeEffect(
	Schema.fromJsonString(Schema.Unknown),
)
const conditions = [
	$.eq("ownerUserId", "member"),
	$.eq("ownerUserId", null),
	$.ne("ownerUserId", "member"),
	$.in("ownerUserId", ["member"]),
	$.in("ownerUserId", [null, "member"]),
	$.lt("rank", 2),
	$.lte("rank", 2),
	$.gt("rank", 2),
	$.gte("rank", 2),
	$.exists("ownerUserId"),
	$.and($.eq("ownerUserId", "member"), $.gte("rank", 2)),
	$.or($.eq("ownerUserId", "member"), $.gte("rank", 2)),
]

it.live(
	"list filters and direct checks agree for shared resources",
	() =>
		Effect.gen(function* () {
			const database = yield* PostgresTest.start
			yield* Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const db = yield* Db.make
				yield* sql`create table authorization_test_resources (id text primary key, owner_user_id text, rank integer)`
				yield* db.insert(resources).values([...rows])
				for (const condition of [
					...conditions,
					...Arr.map(conditions, Condition.not),
				]) {
					const where = yield* toWhere(condition, {
						id: resources.id,
						ownerUserId: resources.ownerUserId,
						rank: resources.rank,
					})
					const actual = yield* db
						.select({ id: resources.id })
						.from(resources)
						.where(where)
						.orderBy(resources.id)
					const expected = Arr.sort(
						Arr.map(
							Arr.filter(rows, (value) =>
								Condition.evaluateSync(condition, {
									value: RowResource.make(value),
								}),
							),
							(row) => row.id,
						),
						Str.Order,
					)
					assert.deepEqual(
						Arr.map(actual, (row) => row.id),
						expected,
						yield* encodeCondition(condition),
					)
				}
			}).pipe(
				Effect.provide(
					DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
				),
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)
