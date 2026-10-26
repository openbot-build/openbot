import { NodeCrypto } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { BotsApi } from "@openbot-build/api"
import { Chat, Item, Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Context,
	Deferred,
	Effect,
	Fiber,
	HashMap,
	HashSet,
	Layer,
	Logger,
	Option,
	pipe,
	Ref,
	References,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, Prompt, Response } from "effect/ai"
import { TestClock } from "effect/testing"
import { Billing } from "../src/billing/Billing.ts"
import { BotMemories, type Home } from "../src/bots/BotMemories.ts"
import {
	BotRecords,
	type Collection,
	type Keys,
} from "../src/bots/BotRecords.ts"
import * as MemoryBot from "../src/bots/MemoryBot.ts"
import { HelperModel } from "../src/capabilities/Judge.ts"
import { type ChatHostState, chatHostId } from "../src/chats/ChatHost.ts"
import type * as BotMemory from "../src/plugins/memory/BotMemory.ts"

const bot = BotsApi.BotId.make("bot_1")
const home: Home = { organizationId: "org_1", bot }
const chatId = Chat.Id.make("chat_1")
const turn = Turn.Id.make("turn_1")
const host: ChatHostState = {
	bot,
	kind: "direct",
	chain: { organizationId: "org_1", userId: "alice", bots: [bot], chats: [] },
}
const chat: Chat.Ref = {
	id: chatId,
	revision: Chat.Revision.make(1),
	settings: { mode: "build" },
	inbox: [],
	seq: Item.Seq.make(1),
	business: { [chatHostId]: host },
	createdAt: 0,
}
const items: ReadonlyArray<Item.Record> = [
	{
		id: Item.Id.make("item_1"),
		seq: Item.Seq.make(1),
		content: Prompt.make([
			{ role: "user", content: "I drink green tea every morning." },
		]),
	},
]
const read = (after: number) =>
	Effect.succeed({
		items: Arr.filter(items, (item) => item.seq > after),
		authors: new Map<Turn.Id, Turn.Author>(),
	})
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/** Bot records in memory. A transaction runs its operation as it is. */
const records = Effect.gen(function* () {
	const rows = yield* Ref.make(
		HashMap.empty<string, { readonly keys: Keys; readonly value: unknown }>(),
	)
	const collection = <
		S extends Schema.Codec<any, any>,
		Status extends string = string,
	>(
		kind: string,
	): Collection<S["Type"], Status> => {
		const key = (organizationId: string, id: string) =>
			kind + "/" + organizationId + "/" + id
		const all = Effect.map(Ref.get(rows), (map) =>
			pipe(
				HashMap.toEntries(map),
				Arr.filter(([id]) => Str.startsWith(kind + "/")(id)),
				Arr.map(([, row]) => row),
			),
		)
		return {
			find: (organizationId, id) =>
				Effect.map(Ref.get(rows), (map) =>
					Option.map(
						HashMap.get(map, key(organizationId, id)),
						(row) => row.value as S["Type"],
					),
				),
			list: (organizationId, filter = {}) =>
				Effect.map(all, (list) =>
					pipe(
						list,
						Arr.filter(
							(row) =>
								row.keys.organizationId === organizationId &&
								(filter.owner === undefined ||
									row.keys.owner === filter.owner) &&
								(filter.scope === undefined ||
									row.keys.scope === filter.scope) &&
								(filter.status === undefined ||
									row.keys.status === filter.status),
						),
						Arr.map((row) => row.value as S["Type"]),
					),
				),
			withStatus: (status) =>
				Effect.map(all, (list) =>
					pipe(
						list,
						Arr.filter((row) => row.keys.status === status),
						Arr.map((row) => ({
							organizationId: row.keys.organizationId,
							value: row.value as S["Type"],
						})),
					),
				),
			put: (keys, value) =>
				Ref.update(rows, (map) =>
					HashMap.set(map, key(keys.organizationId, keys.id), {
						keys,
						value,
					}),
				),
			remove: (organizationId, id) =>
				Ref.update(rows, HashMap.remove(key(organizationId, id))),
		}
	}
	return BotRecords.of({
		collection,
		transaction: (_key, operation) => operation,
		lock: () => Effect.void,
	})
})

/** A memory pool in memory. `entries` reads it. */
const pool = Effect.gen(function* () {
	const entries = yield* Ref.make<ReadonlyArray<BotMemory.Entry>>([])
	const service = BotMemories.of({
		...({} as BotMemories["Service"]),
		pool: () => Ref.get(entries),
		change: (_home, run) =>
			Effect.gen(function* () {
				const changed = yield* run(yield* Ref.get(entries))
				yield* Ref.update(entries, (current) => [
					...changed.entries,
					...Arr.filter(
						current,
						(entry) =>
							!Arr.some(changed.entries, (next) => next.id === entry.id),
					),
				])
				return changed.result
			}),
	})
	return { service, entries: Ref.get(entries) }
})

/**
 * A memory model that counts its calls and tells `asked` about each one. A
 * call to learn waits until `open` is done, and then adds one fact about the
 * first Item. A confession gets its answer at once.
 */
const model = (input: {
	readonly calls: Ref.Ref<number>
	readonly asked: Deferred.Deferred<void>
	readonly open: Deferred.Deferred<void>
}) =>
	LanguageModel.make({
		generateText: ({ prompt }) =>
			Effect.gen(function* () {
				yield* Ref.update(input.calls, (count) => count + 1)
				yield* Deferred.succeed(input.asked, undefined)
				const system = pipe(
					prompt.content,
					Arr.filter((message) => message.role === "system"),
					Arr.map((message) => message.content),
					Arr.join("\n"),
				)
				if (!Str.includes("You keep the memory of an AI Bot.")(system))
					return [Response.makePart("text", { text: "I hear you." })]
				yield* Deferred.await(input.open)
				const text = yield* encodeJson({
					operations: [
						{
							_tag: "AddFact",
							ref: "tea",
							content: "Alice likes green tea.",
							topics: ["drinks"],
							sources: [{ chat: chatId, item: "item_1" }],
						},
					],
				})
				return [
					Response.makePart("text", { text }),
					Response.makePart("finish", { reason: "stop", usage }),
				]
			}).pipe(
				// A script that cannot write its answer is a broken test.
				Effect.orDie,
			),
		streamText: () => Stream.never,
	})

const botOf: BotsApi.Bot = {
	...({} as BotsApi.Bot),
	id: bot,
	name: "Assistant",
	role: "Helps people.",
}

/** The memory Bot with fakes around it. The Billing fake says that it spent `spent`. */
const setup = (options: { readonly spent?: number } = {}) =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const asked = yield* Deferred.make<void>()
		const open = yield* Deferred.make<void>()
		const memory = yield* pool
		const language = yield* model({ calls, asked, open })
		// The memory Bot lives as long as the test, because its locks need its scope.
		const services = yield* Layer.build(
			MemoryBot.layer.pipe(
				Layer.provide([
					Layer.effect(BotRecords, records),
					Layer.succeed(BotMemories, memory.service),
					Layer.succeed(HelperModel, {
						rules: () => Effect.die("The test has no Rules model."),
						botMemory: () => Effect.succeed(language),
					}),
					Layer.succeed(Billing, {
						...({} as Billing["Service"]),
						botSpend: () => Effect.succeed(options.spent ?? 0),
					}),
					NodeCrypto.layer,
				]),
			),
		)
		const memoryBot = Context.get(services, MemoryBot.MemoryBot)
		const queue = memoryBot.queue({
			home,
			organizationId: "org_1",
			owner: "alice",
			chat: chatId,
		})
		const job = memoryBot.job("org_1", chatId).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.die("The test queued no job."),
					onSome: Effect.succeed,
				}),
			),
		)
		const learn = (job: MemoryBot.Job) =>
			memoryBot.learn({ job, bot: botOf, chat, read, own: HashSet.empty() })
		return {
			memoryBot,
			calls: Ref.get(calls),
			asked: Deferred.await(asked),
			open: Deferred.succeed(open, undefined),
			entries: memory.entries,
			queue,
			job,
			learn,
		}
	})

interface Line {
	readonly level: string
	readonly message: unknown
}

/** Keeps every log line of a test in place of the normal output. */
const collect = () => {
	let lines: ReadonlyArray<Line> = []
	const layer = Layer.merge(
		Logger.layer([
			Logger.make((log) => {
				lines = [...lines, { level: log.logLevel, message: log.message }]
			}),
		]),
		Layer.succeed(References.MinimumLogLevel, "All"),
	)
	return { layer, lines: () => lines }
}

describe("The memory Bot", () => {
	it.effect(
		"lets a second run of learn for one Chat wait for the first, so it learns the evidence once",
		() =>
			Effect.gen(function* () {
				const memory = yield* setup()
				yield* memory.queue
				const first = yield* memory.job
				const learning = yield* memory
					.learn(first)
					.pipe(Effect.forkChild({ startImmediately: true }))
				yield* memory.asked
				// The Bot confides again while the first run waits for the model.
				yield* TestClock.adjust("1 second")
				yield* memory.queue
				const second = yield* memory.job
				assert.notStrictEqual(second.queuedAt, first.queuedAt)
				const again = yield* memory
					.learn(second)
					.pipe(Effect.forkChild({ startImmediately: true }))
				yield* memory.open
				yield* Fiber.join(learning)
				yield* Fiber.join(again)
				// The second run found no new evidence, so it did not ask the model.
				assert.strictEqual(yield* memory.calls, 1)
				assert.deepStrictEqual(
					Arr.map(yield* memory.entries, (entry) => entry.content),
					["Alice likes green tea."],
				)
				assert.ok(Option.isNone(yield* memory.memoryBot.job("org_1", chatId)))
			}),
	)

	it.effect("keeps a job that the Bot queued again while learn ran", () =>
		Effect.gen(function* () {
			const memory = yield* setup()
			yield* memory.queue
			const first = yield* memory.job
			const learning = yield* memory
				.learn(first)
				.pipe(Effect.forkChild({ startImmediately: true }))
			yield* memory.asked
			yield* TestClock.adjust("1 second")
			yield* memory.queue
			const second = yield* memory.job
			yield* memory.open
			yield* Fiber.join(learning)
			assert.strictEqual((yield* memory.entries).length, 1)
			// The newer job waits, so a later end of a Turn learns from what it brought.
			assert.deepStrictEqual(
				yield* memory.memoryBot.job("org_1", chatId),
				Option.some(second),
			)
		}),
	)

	it.effect(
		"counts the wait for a permit in the time of a confession, and learn frees its permit after its time",
		() =>
			Effect.gen(function* () {
				const memory = yield* setup()
				yield* memory.memoryBot.update(home, { expected: 0, concurrency: 1 })
				yield* memory.queue
				// The model never answers learn, so learn holds the only permit.
				const learning = yield* memory
					.learn(yield* memory.job)
					.pipe(Effect.forkChild({ startImmediately: true }))
				yield* memory.asked
				const confessing = yield* memory.memoryBot
					.confess({
						home,
						bot: botOf,
						chat,
						items: [],
						turn,
						text: "I made a mistake.",
					})
					.pipe(Effect.forkChild({ startImmediately: true }))
				yield* TestClock.adjust("15 seconds")
				assert.strictEqual(
					yield* Fiber.join(confessing),
					MemoryBot.fallbackReply,
				)
				yield* TestClock.adjust("2 minutes")
				yield* Fiber.join(learning)
				// Learn did not end, so its job stays for the next try.
				assert.ok(Option.isSome(yield* memory.memoryBot.job("org_1", chatId)))
				assert.strictEqual((yield* memory.entries).length, 0)
			}),
	)

	it.effect(
		"keeps counting the running tasks when the owner changes the limit",
		() =>
			Effect.gen(function* () {
				const memory = yield* setup()
				yield* memory.memoryBot.update(home, { expected: 0, concurrency: 2 })
				yield* memory.queue
				// The model does not answer learn yet, so learn holds one permit.
				const learning = yield* memory
					.learn(yield* memory.job)
					.pipe(Effect.forkChild({ startImmediately: true }))
				yield* memory.asked
				yield* memory.memoryBot.update(home, { expected: 1, concurrency: 1 })
				const confess = memory.memoryBot.confess({
					home,
					bot: botOf,
					chat,
					items: [],
					turn,
					text: "I made a mistake.",
				})
				const confessing = yield* confess.pipe(
					Effect.forkChild({ startImmediately: true }),
				)
				yield* TestClock.adjust("15 seconds")
				// Learn still holds the only permit, so the confession did not ask the model.
				assert.strictEqual(
					yield* Fiber.join(confessing),
					MemoryBot.fallbackReply,
				)
				assert.strictEqual(yield* memory.calls, 1)
				// A higher limit lets the next confession ask the model at once.
				yield* memory.memoryBot.update(home, { expected: 2, concurrency: 2 })
				assert.strictEqual(yield* confess, "I hear you.")
				assert.strictEqual(yield* memory.calls, 2)
				yield* memory.open
				yield* Fiber.join(learning)
			}),
	)

	it.effect(
		"gives the calm answer when its budget is spent, and logs that only at level Debug",
		() => {
			const logs = collect()
			return Effect.gen(function* () {
				const memory = yield* setup({ spent: 100 })
				yield* memory.memoryBot.update(home, {
					expected: 0,
					budget: { period: "day", limitMicros: 100 },
				})
				const reply = yield* memory.memoryBot.confess({
					home,
					bot: botOf,
					chat,
					items: [],
					turn,
					text: "I made a mistake.",
				})
				assert.strictEqual(reply, MemoryBot.fallbackReply)
				yield* memory.queue
				yield* memory.learn(yield* memory.job)
				assert.strictEqual(yield* memory.calls, 0)
				// The job stays, so the memory Bot learns when the budget lets it.
				assert.ok(Option.isSome(yield* memory.memoryBot.job("org_1", chatId)))
				const levels = Arr.map(logs.lines(), (line) => line.level)
				assert.deepStrictEqual(levels, ["Debug", "Debug"])
				assert.ok(
					Arr.every(
						logs.lines(),
						(line) =>
							Arr.isArray(line.message) &&
							line.message[0] === "The budget of the memory Bot is spent",
					),
				)
			}).pipe(Effect.provide(logs.layer))
		},
	)
})
