import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { Chat, Item } from "@openbot-build/core"
import { Bots } from "@openbot-build/domain"
import {
	Array as Arr,
	Effect,
	Layer,
	Option,
	Order,
	Redacted,
	String as Str,
} from "effect"
import * as BotMemories from "../src/bots/BotMemories.ts"
import * as BotRecords from "../src/bots/BotRecords.ts"
import * as MemoryLogs from "../src/bots/MemoryLogs.ts"
import * as MemoryRules from "../src/bots/MemoryRules.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Audience from "../src/plugins/memory/Audience.ts"
import * as Memory from "../src/plugins/memory/BotMemory.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as PostgresTest from "./PostgresTest.ts"

const database = Layer.effectDiscard(DatabasePostgres.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = BotMemories.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(BotRecords.layer, MemoryLogs.layer)),
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const home = (bot: string): BotMemories.Home => ({
	organizationId: "memory-org",
	bot: Bots.BotId.make(bot),
})
const viewer = (person: string): Audience.Viewer => ({
	organizationId: "memory-org",
	person,
})
const group: Audience.Viewer = {
	organizationId: "memory-org",
	channel: "group",
}
const ids = (entries: ReadonlyArray<{ readonly id: string }>) =>
	Arr.sort(
		Arr.map(entries, (entry) => entry.id),
		Order.String,
	)
const prepare = Effect.fn(function* (place: BotMemories.Home) {
	const memories = yield* BotMemories.BotMemories
	const sql = yield* PgClient.PgClient
	yield* sql`INSERT INTO openbot_organizations (id, name, status, created_at) VALUES ('memory-org', 'Memory tests', 'active', 0) ON CONFLICT DO NOTHING`
	const evidence = Arr.map(["Ana", "Bob"], (author): Memory.Evidence => ({
		source: { chat: Chat.Id.make("group-chat"), item: Item.Id.make(author) },
		role: "user",
		outside: false,
		author,
		organizationId: "memory-org",
		audience: Audience.channel("group"),
		channel: "group",
		text: author + " likes tea.",
	}))
	const result = yield* memories.change(place, (pool) => {
		const applied = Memory.apply({
			pool,
			evidence,
			now: 1,
			ids: ["Ana", "Bob", "both", "next"],
			operations: [
				...Arr.map(evidence, (entry): Memory.Operation => ({
					_tag: "AddFact",
					ref: entry.author,
					content: entry.text,
					topics: [],
					sources: [entry.source],
				})),
				{
					_tag: "AddObservation",
					ref: "both",
					content: "Both like tea.",
					topics: [],
					supports: ["Ana", "Bob"],
					confidence: 1,
				},
				{
					_tag: "AddObservation",
					ref: "next",
					content: "Tea helps the group.",
					topics: [],
					supports: ["both"],
					confidence: 1,
				},
			],
		})
		return Effect.succeed({
			...applied,
			by: "memory_bot" as const,
			result: applied,
		})
	})
	assert.strictEqual(result.rejected, 0)
	assert.strictEqual(result.entries.length, 4)
	return memories
})

layer(services)("Memory source access", (it) => {
	it.effect(
		"stored source rules limit reads, logs and edits after a new service starts",
		() =>
			Effect.gen(function* () {
				const place = home("source-reads")
				const memories = yield* prepare(place)
				assert.deepStrictEqual(
					ids((yield* memories.view(place, group)).entries),
					["Ana", "Bob", "both", "next"],
				)
				for (const person of ["Ana", "Bob"]) {
					const view = yield* memories.view(place, viewer(person))
					assert.deepStrictEqual(ids(view.entries), [person])
					assert.ok(
						Arr.every(view.entries, (entry) => !("sourcePolicies" in entry)),
					)
					const log = yield* memories.log(place, viewer(person))
					assert.deepStrictEqual(
						Arr.flatMap(log, (entry) => entry.ids),
						[person],
					)
					const edit = yield* Effect.flip(
						memories.edit(
							place,
							{ organizationId: "memory-org", userId: person },
							{ _tag: "Forget", id: "both" },
						),
					)
					assert.strictEqual(edit._tag, "BotConflict")
				}
				for (const denied of [
					viewer("Carol"),
					{ organizationId: "other-org", person: "Ana" },
					{ organizationId: "memory-org", channel: "other-group" },
				])
					assert.deepStrictEqual(
						(yield* memories.view(place, denied)).entries,
						[],
					)
				const restarted = yield* BotMemories.make
				assert.deepStrictEqual(
					ids((yield* restarted.view(place, viewer("Ana"))).entries),
					["Ana"],
				)
				assert.deepStrictEqual(
					ids((yield* restarted.view(place, group)).entries),
					["Ana", "Bob", "both", "next"],
				)
				assert.strictEqual(yield* restarted.purge(place, "from:Ana"), 3)
				assert.deepStrictEqual(
					ids((yield* restarted.view(place, group)).entries),
					["Bob"],
				)
				const sql = yield* PgClient.PgClient
				const policies = yield* sql<{
					readonly scope: string
				}>`SELECT scope FROM openbot_bot_records WHERE kind = 'memory_source_policy' AND organization_id = ${place.organizationId} AND owner = ${place.bot}`
				assert.deepStrictEqual(
					Arr.map(policies, (row) => row.scope),
					["Bob"],
				)
			}),
	)

	it.effect(
		"old facts without source proof stay hidden while pinned entries stay private",
		() =>
			Effect.gen(function* () {
				const place = home("old-source-reads")
				const memories = yield* prepare(place)
				const sql = yield* PgClient.PgClient
				const before = MemoryRules.learningInput(
					yield* memories.pool(place),
					[],
					{ name: "Bot", role: "Help" },
				)
				assert.deepStrictEqual(ids(before.memory), [
					"Ana",
					"Bob",
					"both",
					"next",
				])
				// This is the exact state of an older pool, which has no source policy records.
				yield* sql`DELETE FROM openbot_bot_records WHERE kind = 'memory_source_policy' AND organization_id = ${place.organizationId} AND owner = ${place.bot}`
				const restarted = yield* BotMemories.make
				assert.deepStrictEqual(
					(yield* restarted.view(place, group)).entries,
					[],
				)
				assert.deepStrictEqual(yield* restarted.log(place, viewer("Ana")), [])
				assert.strictEqual((yield* memories.pool(place)).length, 4)
				const remembered = yield* restarted.edit(
					place,
					{ organizationId: "memory-org", userId: "Ana" },
					{ _tag: "Remember", content: "I like tea." },
				)
				assert.strictEqual(remembered.entries.length, 1)
				assert.strictEqual(remembered.entries[0]?.layer, "pinned")
				const input = MemoryRules.learningInput(
					yield* restarted.pool(place),
					[],
					{ name: "Bot", role: "Help" },
				)
				assert.deepStrictEqual(ids(input.memory), ids(remembered.entries))
				assert.ok(Arr.every(input.memory, (entry) => entry.layer === "pinned"))
				assert.deepStrictEqual(
					(yield* restarted.view(place, viewer("Bob"))).entries,
					[],
				)
				assert.deepStrictEqual(
					(yield* restarted.view(place, group)).entries,
					[],
				)
			}),
	)

	it.effect("lost, inactive and cyclic sources block all later entries", () =>
		Effect.gen(function* () {
			for (const state of [
				"missing",
				"invalid",
				"retracted",
				"cycle",
			] as const) {
				const place = home("source-" + state)
				const memories = yield* prepare(place)
				if (state === "missing") {
					const sql = yield* PgClient.PgClient
					// An old entry can lose its source without the copied origin tags being removed.
					yield* sql`DELETE FROM openbot_bot_memories WHERE organization_id = ${place.organizationId} AND home_bot = ${place.bot} AND id = 'Bob'`
				} else {
					yield* memories.change(place, (pool) => {
						const entry = Option.getOrThrow(
							Arr.findFirst(pool, (entry) => entry.id === "Bob"),
						)
						const changed: Memory.Entry =
							state === "invalid"
								? { ...entry, invalidatedAt: 2 }
								: state === "retracted"
									? { ...entry, status: "retracted" }
									: {
											...entry,
											layer: "observation",
											sources: [{ entry: "next" }],
										}
						return Effect.succeed({
							entries: [changed],
							by: "person" as const,
							result: undefined,
						})
					})
				}
				const visible = yield* memories.view(place, group)
				assert.ok(!ids(visible.entries).includes("both"))
				assert.ok(!ids(visible.entries).includes("next"))
				assert.ok(ids(visible.entries).includes("Ana"))
				assert.ok(
					Arr.every(
						yield* memories.log(place, group),
						(entry) =>
							!entry.ids.includes("both") && !entry.ids.includes("next"),
					),
				)
			}
		}),
	)
})
