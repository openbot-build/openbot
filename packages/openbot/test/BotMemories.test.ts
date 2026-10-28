import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { Chat, Item } from "@openbot-build/core"
import { Bots } from "@openbot-build/domain"
import {
	Array as Arr,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Order,
	Redacted,
	Ref,
	String as Str,
} from "effect"
import { Statement } from "effect/sql"
import * as BotMemories from "../src/bots/BotMemories.ts"
import * as BotRecords from "../src/bots/BotRecords.ts"
import * as MemoryLogs from "../src/bots/MemoryLogs.ts"
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
	const result = yield* memories.applyLearning(place, {
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
	assert.strictEqual(result.rejected, 0)
	assert.strictEqual(result.changedIds.length, 4)
	return memories
})

const binding = (place: BotMemories.Home, id: string) =>
	JSON.stringify(["bot-memory", place.organizationId, place.bot, id, "content"])

/** Count memory content opens apart from the sealed change log. */
const track = Effect.gen(function* () {
	const secrets = yield* Secrets.Secrets
	const opened = yield* Ref.make<ReadonlyArray<string>>([])
	const sealed = yield* Ref.make<ReadonlyArray<string>>([])
	const memories = yield* BotMemories.make.pipe(
		Effect.provideService(
			Secrets.Secrets,
			Secrets.Secrets.of({
				open: (value, key) =>
					Ref.update(opened, Arr.append(key)).pipe(
						Effect.andThen(secrets.open(value, key)),
					),
				seal: (value, key) =>
					Ref.update(sealed, Arr.append(key)).pipe(
						Effect.andThen(secrets.seal(value, key)),
					),
			}),
		),
	)
	return { memories, opened, sealed }
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
				const before = yield* memories.learningContext(place)
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
				const stored = yield* sql<{
					readonly id: string
				}>`SELECT id FROM openbot_bot_memories WHERE organization_id = ${place.organizationId} AND home_bot = ${place.bot}`
				assert.strictEqual(stored.length, 4)
				const remembered = yield* restarted.edit(
					place,
					{ organizationId: "memory-org", userId: "Ana" },
					{ _tag: "Remember", content: "I like tea." },
				)
				assert.strictEqual(remembered.entries.length, 1)
				assert.strictEqual(remembered.entries[0]?.layer, "pinned")
				assert.match(
					remembered.entries[0]?.id ?? "",
					/^mem_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/,
				)
				const input = yield* restarted.learningContext(place)
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
					const sql = yield* PgClient.PgClient
					if (state === "invalid")
						yield* sql`UPDATE openbot_bot_memories SET invalidated_at = 2 WHERE organization_id = ${place.organizationId} AND home_bot = ${place.bot} AND id = 'Bob'`
					else if (state === "retracted")
						yield* sql`UPDATE openbot_bot_memories SET status = 'retracted' WHERE organization_id = ${place.organizationId} AND home_bot = ${place.bot} AND id = 'Bob'`
					else
						yield* sql`UPDATE openbot_bot_memories SET layer = 'observation', sources = '[{"entry":"next"}]' WHERE organization_id = ${place.organizationId} AND home_bot = ${place.bot} AND id = 'Bob'`
				}
				const visible = yield* memories.view(place, group)
				assert.ok(!ids(visible.entries).includes("both"))
				assert.ok(!ids(visible.entries).includes("next"))
				assert.ok(ids(visible.entries).includes("Ana"))
				if (state === "invalid" || state === "retracted")
					assert.ok(ids(visible.entries).includes("Bob"))
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

	it.effect("a tag read checks sources without opening their content", () =>
		Effect.gen(function* () {
			const place = home("tag-content")
			const memories = yield* prepare(place)
			yield* memories.applyLearning(place, {
				evidence: [],
				operations: [
					{ _tag: "Retag", id: "next", add: ["wanted"], remove: [] },
				],
				now: 2,
				ids: ["unused"],
			})
			const sql = yield* PgClient.PgClient
			// Content has no part in the access proof of a source.
			yield* sql`UPDATE openbot_bot_memories SET content = 'bad cipher' WHERE organization_id = ${place.organizationId} AND home_bot = ${place.bot} AND id <> 'next'`
			const tracked = yield* track
			const view = yield* tracked.memories.view(place, group, ["wanted"])
			assert.deepStrictEqual(ids(view.entries), ["next"])
			assert.strictEqual(view.entries[0]?.content, "Tea helps the group.")
			assert.deepStrictEqual(yield* Ref.get(tracked.opened), [
				binding(place, "next"),
			])
			yield* Ref.set(tracked.opened, [])
			assert.deepStrictEqual(
				(yield* tracked.memories.view(place, viewer("Carol"))).entries,
				[],
			)
			assert.deepStrictEqual(
				yield* tracked.memories.context(place, viewer("Carol"), 8000),
				{ text: "", ids: [], hasEntries: false },
			)
			assert.deepStrictEqual(yield* Ref.get(tracked.opened), [])
		}),
	)

	it.effect("context stops at the first line that does not fit", () =>
		Effect.gen(function* () {
			const place = home("context-budget")
			yield* prepare(place)
			const tracked = yield* track
			const first = "[Ana] Ana likes tea."
			const context = yield* tracked.memories.context(
				place,
				group,
				first.length,
			)
			assert.deepStrictEqual(context, {
				text: first,
				ids: ["Ana"],
				hasEntries: true,
			})
			// Bob is opened to learn its length. No later entry is opened.
			assert.deepStrictEqual(yield* Ref.get(tracked.opened), [
				binding(place, "Ana"),
				binding(place, "Bob"),
			])
		}),
	)

	it.effect(
		"learning opens 300 entries and counts topics from all entries",
		() =>
			Effect.gen(function* () {
				const place = home("learning-limit")
				const memories = yield* BotMemories.BotMemories
				const sql = yield* PgClient.PgClient
				const source = {
					chat: Chat.Id.make("learning-chat"),
					item: Item.Id.make("learning-item"),
				}
				const names = Arr.makeBy(
					301,
					(index) => "entry-" + Str.padStart(3, "0")(String(index)),
				)
				yield* memories.applyLearning(place, {
					evidence: [
						{
							source,
							role: "user",
							outside: false,
							author: "Ana",
							organizationId: place.organizationId,
							audience: Audience.person("Ana"),
							text: "Tea helps.",
						},
					],
					operations: Arr.map(names, (name, index): Memory.Operation => ({
						_tag: "AddFact",
						ref: name,
						content: "Tea helps.",
						topics: [index === 300 ? "last" : "first"],
						sources: [source],
					})),
					now: 1,
					ids: names,
				})
				yield* sql`UPDATE openbot_bot_memories SET content = 'bad cipher' WHERE organization_id = ${place.organizationId} AND home_bot = ${place.bot} AND id = 'entry-300'`
				const tracked = yield* track
				const context = yield* tracked.memories.learningContext(place)
				assert.strictEqual(context.memory.length, 300)
				assert.deepStrictEqual(ids(context.memory), Arr.take(names, 300))
				assert.deepStrictEqual(
					Arr.sort(
						context.topics,
						Order.mapInput(
							Order.String,
							(topic: { readonly topic: string }) => topic.topic,
						),
					),
					[
						{ topic: "first", count: 300 },
						{ topic: "last", count: 1 },
					],
				)
				assert.deepStrictEqual(
					yield* Ref.get(tracked.opened),
					Arr.map(Arr.take(names, 300), (name) => binding(place, name)),
				)
			}),
	)

	it.effect("saved references need not fit the current context budget", () =>
		Effect.gen(function* () {
			const place = home("reference-budget")
			const memories = yield* prepare(place)
			assert.ok(
				(yield* memories.context(place, group, 8000)).ids.includes("Ana"),
			)
			const source = {
				chat: Chat.Id.make("fresh-chat"),
				item: Item.Id.make("fresh-item"),
			}
			yield* memories.applyLearning(place, {
				evidence: [
					{
						source,
						role: "user",
						outside: false,
						author: "Ana",
						organizationId: place.organizationId,
						audience: Audience.channel("group"),
						channel: "group",
						text: "New words fill this context.",
					},
				],
				operations: [
					{
						_tag: "AddFact",
						ref: "fresh",
						content: Str.repeat(8000)("x"),
						topics: [],
						sources: [source],
					},
				],
				now: 2,
				ids: ["fresh"],
			})
			assert.deepStrictEqual(yield* memories.context(place, group, 8000), {
				text: "",
				ids: [],
				hasEntries: true,
			})
			const sql = yield* PgClient.PgClient
			yield* sql`UPDATE openbot_bot_memories SET content = 'bad cipher' WHERE organization_id = ${place.organizationId} AND home_bot = ${place.bot} AND id = 'Ana'`
			const tracked = yield* track
			assert.strictEqual(
				yield* tracked.memories.validateReferences(place, group, ["Ana"]),
				true,
			)
			assert.strictEqual(
				yield* tracked.memories.validateReferences(place, viewer("Carol"), [
					"Ana",
				]),
				false,
			)
			assert.strictEqual(
				yield* tracked.memories.validateReferences(
					place,
					{ organizationId: "other-org", person: "Ana" },
					["Ana"],
				),
				false,
			)
			assert.deepStrictEqual(yield* Ref.get(tracked.opened), [])
		}),
	)

	it.effect(
		"reference checks use current states and source rules without content",
		() =>
			Effect.gen(function* () {
				const place = home("reference-rules")
				yield* prepare(place)
				const sql = yield* PgClient.PgClient
				yield* sql`UPDATE openbot_bot_memories SET content = 'bad cipher' WHERE organization_id = ${place.organizationId} AND home_bot = ${place.bot}`
				const tracked = yield* track
				const check = tracked.memories.validateReferences(place, group, [
					"next",
				])
				assert.strictEqual(yield* check, true)
				assert.strictEqual(
					yield* tracked.memories.validateReferences(place, viewer("Ana"), [
						"next",
					]),
					false,
				)
				for (const id of ["next", "Bob"]) {
					yield* sql`UPDATE openbot_bot_memories SET status = 'retracted' WHERE organization_id = ${place.organizationId} AND home_bot = ${place.bot} AND id = ${id}`
					assert.strictEqual(yield* check, false)
					yield* sql`UPDATE openbot_bot_memories SET status = 'active', invalidated_at = 3 WHERE organization_id = ${place.organizationId} AND home_bot = ${place.bot} AND id = ${id}`
					assert.strictEqual(yield* check, false)
					yield* sql`UPDATE openbot_bot_memories SET invalidated_at = NULL WHERE organization_id = ${place.organizationId} AND home_bot = ${place.bot} AND id = ${id}`
					assert.strictEqual(yield* check, true)
				}
				yield* sql`DELETE FROM openbot_bot_records WHERE kind = 'memory_source_policy' AND organization_id = ${place.organizationId} AND owner = ${place.bot} AND scope = 'Bob'`
				assert.strictEqual(yield* check, false)
				assert.deepStrictEqual(yield* Ref.get(tracked.opened), [])
			}),
	)

	it.effect("a full view reads content in batches", () =>
		Effect.gen(function* () {
			const place = home("view-queries")
			const memories = yield* BotMemories.BotMemories
			const source = {
				chat: Chat.Id.make("view-chat"),
				item: Item.Id.make("view-item"),
			}
			const names = Arr.makeBy(
				80,
				(index) => "entry-" + Str.padStart(3, "0")(String(index)),
			)
			yield* memories.applyLearning(place, {
				evidence: [
					{
						source,
						role: "user",
						outside: false,
						author: "Ana",
						organizationId: place.organizationId,
						audience: Audience.channel("group"),
						channel: "group",
						text: "Tea helps.",
					},
				],
				operations: Arr.map(names, (name): Memory.Operation => ({
					_tag: "AddFact",
					ref: name,
					content: "Tea helps.",
					topics: [],
					sources: [source],
				})),
				now: 1,
				ids: names,
			})
			const queries = yield* Ref.make<ReadonlyArray<string>>([])
			const transform: Statement.Transformer = (statement) =>
				Ref.update(queries, Arr.append(statement.compile()[0])).pipe(
					Effect.as(statement),
				)
			const view = yield* memories
				.view(place, group)
				.pipe(Effect.provideService(Statement.CurrentTransformer, transform))
			assert.deepStrictEqual(ids(view.entries), names)
			const contentReads = Arr.filter(
				yield* Ref.get(queries),
				(query) =>
					Str.includes("content")(query) &&
					Str.includes("openbot_bot_memories")(query),
			)
			assert.ok(contentReads.length > 0)
			assert.ok(
				contentReads.length <= 2,
				"A view must not make one content query for each entry.",
			)
		}),
	)

	it.effect(
		"metadata changes keep content sealed and logs do not open it",
		() =>
			Effect.gen(function* () {
				const place = home("metadata-content")
				yield* prepare(place)
				const sql = yield* PgClient.PgClient
				const stored = sql<{
					readonly id: string
					readonly content: string
				}>`SELECT id, content FROM openbot_bot_memories WHERE organization_id = ${place.organizationId} AND home_bot = ${place.bot} ORDER BY id`
				const before = yield* stored
				const tracked = yield* track
				const applied = yield* tracked.memories.applyLearning(place, {
					evidence: [],
					operations: [
						{ _tag: "Retag", id: "Ana", add: ["old"], remove: [] },
						{ _tag: "RenameTopic", from: "old", to: "tea" },
						{
							_tag: "Widen",
							id: "Ana",
							audience: "person:Ana",
							reason: "Ana may read her source.",
						},
						{ _tag: "Invalidate", id: "Bob", reason: "The fact changed." },
					],
					now: 2,
					ids: ["unused-1", "unused-2", "unused-3", "unused-4"],
				})
				assert.strictEqual(applied.rejected, 0)
				assert.deepStrictEqual(yield* stored, before)
				assert.deepStrictEqual(yield* Ref.get(tracked.opened), [])
				assert.deepStrictEqual(yield* Ref.get(tracked.sealed), [])
				yield* tracked.memories.log(place, group)
				assert.deepStrictEqual(yield* Ref.get(tracked.opened), [])
				yield* tracked.memories.edit(
					place,
					{ organizationId: place.organizationId, userId: "Ana" },
					{ _tag: "Forget", id: "Ana" },
				)
				assert.deepStrictEqual(yield* stored, before)
				assert.deepStrictEqual(yield* Ref.get(tracked.sealed), [])
				assert.ok(
					Arr.every(
						yield* Ref.get(tracked.opened),
						(key) => key === binding(place, "Ana"),
					),
				)
			}),
	)

	it.effect("a read keeps its source proof until its content is read", () =>
		Effect.gen(function* () {
			const place = home("read-lock")
			const memories = yield* prepare(place)
			yield* memories.applyLearning(place, {
				evidence: [],
				operations: [
					{ _tag: "Retag", id: "next", add: ["wanted"], remove: [] },
				],
				now: 2,
				ids: ["unused"],
			})
			const secrets = yield* Secrets.Secrets
			const opened = yield* Deferred.make<void>()
			const resume = yield* Deferred.make<void>()
			const purged = yield* Deferred.make<void>()
			const reader = yield* BotMemories.make.pipe(
				Effect.provideService(
					Secrets.Secrets,
					Secrets.Secrets.of({
						seal: secrets.seal,
						open: (value, key) =>
							key === binding(place, "next")
								? Deferred.succeed(opened, undefined).pipe(
										Effect.andThen(Deferred.await(resume)),
										Effect.andThen(secrets.open(value, key)),
									)
								: secrets.open(value, key),
					}),
				),
			)
			const read = yield* reader
				.view(place, group, ["wanted"])
				.pipe(Effect.forkChild)
			yield* Deferred.await(opened)
			const purge = yield* memories.purge(place, "from:Ana").pipe(
				Effect.tap(() => Deferred.succeed(purged, undefined)),
				Effect.forkChild,
			)
			const sql = yield* PgClient.PgClient
			let waiting = false
			for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
				const rows = yield* sql<{
					readonly waiting: boolean
				}>`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND mode = 'ExclusiveLock' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())) AS waiting`
				waiting = rows[0]?.waiting === true
				if (!waiting) yield* Effect.yieldNow
			}
			assert.strictEqual(waiting, true)
			assert.strictEqual(yield* Deferred.isDone(purged), false)
			yield* Deferred.succeed(resume, undefined)
			assert.deepStrictEqual(ids((yield* Fiber.join(read)).entries), ["next"])
			assert.strictEqual(yield* Fiber.join(purge), 3)
			assert.deepStrictEqual(
				(yield* memories.view(place, group, ["wanted"])).entries,
				[],
			)
		}),
	)

	it.effect(
		"learning uses current sources and joins the caller transaction",
		() =>
			Effect.gen(function* () {
				const place = home("learning-write")
				const memories = yield* prepare(place)
				yield* memories.edit(
					place,
					{ organizationId: place.organizationId, userId: "Bob" },
					{ _tag: "Forget", id: "Bob" },
				)
				const applied = yield* memories.applyLearning(place, {
					evidence: [],
					operations: [
						{
							_tag: "AddObservation",
							ref: "late",
							content: "This plan read Bob before the wait.",
							topics: [],
							supports: ["Bob"],
							confidence: 1,
						},
					],
					now: 3,
					ids: ["late"],
				})
				assert.deepStrictEqual(applied, { changedIds: [], rejected: 1 })
				const before = yield* memories.view(place, group)
				const log = yield* memories.log(place, group)
				const sql = yield* PgClient.PgClient
				const result = yield* sql
					.withTransaction(
						memories
							.applyLearning(place, {
								evidence: [],
								operations: [
									{ _tag: "Retag", id: "Ana", add: ["new"], remove: [] },
								],
								now: 4,
								ids: ["unused"],
							})
							.pipe(Effect.andThen(Effect.fail("The cursor write failed."))),
					)
					.pipe(Effect.flip)
				assert.strictEqual(result, "The cursor write failed.")
				assert.deepStrictEqual(yield* memories.view(place, group), before)
				assert.deepStrictEqual(yield* memories.log(place, group), log)
			}),
	)
})
