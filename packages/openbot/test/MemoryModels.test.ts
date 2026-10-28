import { PgClient } from "@effect/sql-pg"
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { Chat, Item, Turn, Config, Model, Provider } from "@openbot-build/core"
import { Authorization, Bots, Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Option,
	Redacted,
	Ref,
	Result,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, Prompt, Response } from "effect/ai"
import { TestClock } from "effect/testing"
import { Billing } from "../src/billing/Billing.ts"
import * as MemoryBot from "../src/bots/MemoryBot.ts"
import { textOf } from "../src/bots/MemoryEvidence.ts"
import * as MemoryModels from "../src/bots/MemoryModels.ts"
import * as MemoryTasks from "../src/bots/MemoryTasks.ts"
import { BotMemories, make as makeMemories } from "../src/bots/BotMemories.ts"
import * as MemoryRules from "../src/bots/MemoryRules.ts"
import * as Audience from "../src/plugins/memory/Audience.ts"
import type * as Memory from "../src/plugins/memory/BotMemory.ts"
import { chatHostId } from "../src/chats/ChatHost.ts"
import * as BotFixture from "./BotFixture.ts"
import * as BotRecords from "../src/bots/BotRecords.ts"
import * as MemoryLogs from "../src/bots/MemoryLogs.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Records from "../src/errors/Records.ts"
import * as Calls from "../src/execution/Calls.ts"
import { Registry } from "../src/execution/Engine.ts"
import * as Store from "../src/execution/Store.ts"
import * as Observation from "../src/execution/Observation.ts"
import { ModelRegistry } from "../src/models/ModelRegistry.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as PostgresTest from "./PostgresTest.ts"

const actor = { kind: "member", organizationId: "org", userId: "user" } as const
const selection = Config.Selection.make({
	provider: Provider.Id.make("test"),
	model: Model.Id.make("test"),
})
const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}
const database = Layer.effectDiscard(DatabasePostgres.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = Layer.mergeAll(
	Calls.layer,
	MemoryBot.layer,
	Observation.layer,
).pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			Store.layer,
			Records.layer,
			BotRecords.layer,
			MemoryLogs.layer,
		),
	),
	Layer.provideMerge(
		Layer.mock(Registry, {
			get: () =>
				Effect.succeedSome({
					start: () => Effect.void,
					cancel: () => Effect.void,
					signal: () => Effect.void,
					authorize: () => Effect.void,
				}),
		}),
	),
	Layer.provideMerge(
		Layer.mock(Billing, {
			botSpend: () => Effect.succeed(0),
			record: () => Effect.void,
			unknown: () => Effect.void,
		}),
	),
	Layer.provideMerge(
		Authorizer.layer(Authorization.Auth, {
			policy: () =>
				Effect.succeed(
					Policy.define(Authorization.OpenBot)(function* (_) {
						yield* _.allow("*", "*")
					}),
				),
		}),
	),
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const start = Effect.fn(function* (namespace: string) {
	const store = yield* Store.Store
	const receipt = yield* store.submit(
		namespace,
		Execution.CommandKey.make("start"),
		{
			workflow: "memory-test",
			resource: { kind: "MemoryLearning", id: namespace },
			identity: { owner: actor, actor },
			input: null,
		},
	)
	return yield* store.takeOver({ namespace, id: receipt.executionId })
})
const setup = Effect.gen(function* () {
	const open = yield* Deferred.make<void>()
	const asked = yield* Deferred.make<void>()
	const count = yield* Ref.make(0)
	const selected = yield* Ref.make(0)
	const queued = yield* Deferred.make<void>()
	const model = yield* LanguageModel.make({
		generateText: ({ prompt }) =>
			Effect.gen(function* () {
				yield* Ref.update(count, (n) => n + 1)
				if (
					Arr.some(prompt.content, (message) => textOf(message) === "learn")
				) {
					yield* Deferred.succeed(asked, undefined)
					yield* Deferred.await(open)
				}
				return [
					Response.makePart("text", { text: "I hear you." }),
					Response.makePart("finish", { reason: "stop", usage }),
				]
			}),
		streamText: () => Stream.never,
	})
	const models = yield* Layer.build(
		MemoryModels.layer.pipe(
			Layer.provide(
				Layer.mock(ModelRegistry, {
					defaultModel: Option.some(selection),
					helperSelection: () =>
						Ref.updateAndGet(selected, (n) => n + 1).pipe(
							Effect.tap((n) =>
								n === 2 ? Deferred.succeed(queued, undefined) : Effect.void,
							),
							Effect.as(selection),
						),
					resolve: () => Effect.succeed(model),
				}),
			),
		),
	)
	return {
		context: models,
		queued: Deferred.await(queued),
		open: Deferred.succeed(open, undefined),
		asked: Deferred.await(asked),
		count: Ref.get(count),
		run: (
			fence: Store.Fence,
			home: { organizationId: string; bot: Bots.BotId },
			name: string,
		) =>
			Effect.flatMap(MemoryModels.MemoryModels, (models) =>
				models.run(fence, name, home, {
					schema: Schema.String,
					kind: "text",
					name,
					prompt: () =>
						Effect.succeed(
							Prompt.make(
								name === "bot_memory_operations" ? "learn" : "confess",
							),
						),
					send: (prompt) =>
						LanguageModel.generateText({ prompt }).pipe(
							Effect.map((response) => ({
								value: response.text,
								usage: response.usage,
							})),
						),
				}),
			).pipe(Effect.provideContext(models)),
	}
})
layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect(
		"a spent memory budget gives a calm confession without sending to the model",
		() =>
			Effect.gen(function* () {
				const memory = yield* MemoryBot.MemoryBot
				const home = {
					organizationId: actor.organizationId,
					bot: Bots.BotId.make("spent-budget"),
				}
				yield* memory.update(home, {
					expected: 0,
					budget: { period: "day", limitMicros: 0 },
				})
				const models = yield* setup
				const fence = yield* start("memory-spent-confession")
				const chat: Chat.Ref = {
					id: Chat.Id.make("spent-chat"),
					revision: Chat.Revision.make(1),
					seq: Item.Seq.make(0),
					settings: { mode: "build" },
					inbox: [],
					createdAt: 0,
					business: {
						[chatHostId]: {
							bot: home.bot,
							kind: "direct",
							chain: {
								organizationId: actor.organizationId,
								userId: actor.userId,
								bots: [home.bot],
								chats: [],
							},
						},
					},
				}
				const confess = (callId: string) =>
					Effect.flatMap(MemoryTasks.MemoryTasks, (tasks) =>
						tasks.confess(
							fence,
							{
								home,
								bot: { ...BotFixture.bot, id: home.bot },
								chat,
								items: [],
								turn: Turn.Id.make("spent-turn"),
								text: "I made a mistake.",
							},
							callId,
						),
					).pipe(
						Effect.provide(
							MemoryTasks.layer.pipe(
								Layer.provide(
									Layer.mock(BotMemories, {
										context: () =>
											Effect.succeed({ text: "", ids: [], hasEntries: false }),
									}),
								),
							),
						),
						Effect.provideContext(models.context),
					)
				assert.equal(yield* confess("spent"), MemoryBot.fallbackReply)
				assert.equal(yield* models.count, 0)
				const sql = yield* PgClient.PgClient
				assert.deepEqual(
					yield* sql`select id from openbot_execution_permits where execution_id = ${fence.id}`,
					[],
				)
				const errors = yield* sql<{
					readonly id: string
					readonly cause: string
				}>`select id, cause from openbot_execution_failures where execution_id = ${fence.id}`
				assert.equal(errors.length, 1)
				assert.notInclude(errors[0]!.cause, "MemoryBudgetSpent")
				const secrets = yield* Secrets.Secrets.pipe(
					Effect.provide(
						Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					),
				)
				assert.include(
					yield* secrets.open(errors[0]!.cause, "failure:" + errors[0]!.id),
					"MemoryBudgetSpent",
				)
				yield* memory.update(home, { expected: 1, budget: null })
				assert.equal(yield* confess("after-budget"), "I hear you.")
				assert.equal(yield* models.count, 1)
				assert.deepEqual(
					yield* sql`select id from openbot_execution_permits where execution_id = ${fence.id}`,
					[],
				)
			}),
	)
	it.effect(
		"a saved memory answer checks its sources outside the context limit",
		() =>
			Effect.gen(function* () {
				const home = {
					organizationId: actor.organizationId,
					bot: Bots.BotId.make("replay-context"),
				}
				const memories = yield* makeMemories.pipe(
					Effect.provide(
						Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					),
				)
				const source = {
					chat: Chat.Id.make("replay-source"),
					item: Item.Id.make("words"),
				}
				const evidence: ReadonlyArray<Memory.Evidence> = [
					{
						source,
						role: "user",
						outside: false,
						author: actor.userId,
						organizationId: actor.organizationId,
						audience: Audience.person(actor.userId),
						text: "Use tabs for this work.",
					},
				]
				const add = (id: string, content: string, now: number) =>
					memories.applyLearning(home, {
						evidence,
						operations: [
							{
								_tag: "AddFact",
								ref: id,
								content,
								topics: [],
								sources: [source],
							},
						],
						ids: [id],
						now,
					})
				yield* add("old-id", "Use tabs for this work.", 1)
				const count = yield* Ref.make(0)
				const answer = "Please use tabs for this work."
				const encoded = yield* Schema.encodeEffect(
					Schema.fromJsonString(MemoryRules.Enriched),
				)({ text: answer, entries: ["old-id"] })
				const model = yield* LanguageModel.make({
					generateText: () =>
						Ref.update(count, (n) => n + 1).pipe(
							Effect.as([
								Response.makePart("text", { text: encoded }),
								Response.makePart("finish", { reason: "stop", usage }),
							]),
						),
					streamText: () => Stream.never,
				})
				const models = yield* Layer.build(
					MemoryModels.layer.pipe(
						Layer.provide(
							Layer.mock(ModelRegistry, {
								defaultModel: Option.some(selection),
								helperSelection: () => Effect.succeed(selection),
								resolve: () => Effect.succeed(model),
							}),
						),
					),
				)
				const fence = yield* start("memory-replay-context")
				const chat: Chat.Ref = {
					id: Chat.Id.make("replay-context-chat"),
					revision: Chat.Revision.make(1),
					seq: Item.Seq.make(0),
					settings: { mode: "build" },
					inbox: [],
					createdAt: 0,
					business: {
						[chatHostId]: {
							bot: home.bot,
							kind: "direct",
							chain: {
								organizationId: actor.organizationId,
								userId: actor.userId,
								bots: [home.bot],
								chats: [],
							},
						},
					},
				}
				const enrich = Effect.flatMap(MemoryTasks.MemoryTasks, (tasks) =>
					tasks.enrich(fence, {
						home,
						chat,
						turn: Turn.Id.make("replay-context-turn"),
						text: "Help with this work.",
					}),
				).pipe(
					Effect.provide(
						MemoryTasks.layer.pipe(
							Layer.provide(Layer.succeed(BotMemories, memories)),
						),
					),
					Effect.provideContext(models),
				)
				assert.deepEqual(yield* enrich, Option.some(answer))
				assert.equal(yield* Ref.get(count), 1)
				const store = yield* Store.Store
				const saved = yield* store.calls(fence)
				assert.equal(saved.length, 1)
				assert.equal(saved[0]?.status, "completed")
				yield* add("new-id", Str.repeat(1000)("New words. "), 2)
				assert.deepEqual(
					yield* memories.context(
						home,
						{
							organizationId: actor.organizationId,
							person: actor.userId,
						},
						8000,
					),
					{ text: "", ids: [], hasEntries: true },
				)
				assert.deepEqual(yield* enrich, Option.some(answer))
				assert.equal(yield* Ref.get(count), 1)
				yield* memories.edit(
					home,
					{ organizationId: actor.organizationId, userId: actor.userId },
					{ _tag: "Forget", id: "old-id" },
				)
				assert.deepEqual(yield* enrich, Option.none())
				assert.equal(yield* Ref.get(count), 1)
				assert.deepEqual(yield* store.calls(fence), saved)
			}),
	)
	it.effect(
		"a memory timeout includes permit wait and releases a stopped model permit",
		() =>
			Effect.gen(function* () {
				const memory = yield* MemoryBot.MemoryBot
				const home = { organizationId: "org", bot: Bots.BotId.make("timeout") }
				yield* memory.update(home, { expected: 0, concurrency: 1 })
				const models = yield* setup
				const learning = yield* models
					.run(
						yield* start("memory-timeout-learn"),
						home,
						"bot_memory_operations",
					)
					.pipe(Effect.result, Effect.forkChild)
				yield* Effect.raceFirst(
					models.asked,
					Fiber.join(learning).pipe(
						Effect.flatMap((result) =>
							Result.isFailure(result)
								? Effect.fail(result.failure)
								: Effect.die("Learning ended before the model started"),
						),
					),
				)
				const confess = yield* models
					.run(yield* start("memory-timeout-confess"), home, "confess")
					.pipe(Effect.result, Effect.forkChild)
				yield* models.queued
				yield* Effect.yieldNow
				yield* TestClock.adjust("15 seconds")
				assert.isTrue(Result.isFailure(yield* Fiber.join(confess)))
				assert.equal(yield* models.count, 1)
				yield* TestClock.adjust("2 minutes")
				assert.isTrue(Result.isFailure(yield* Fiber.join(learning)))
				assert.equal(
					yield* models.run(
						yield* start("memory-after-timeout"),
						home,
						"confess",
					),
					"I hear you.",
				)
				assert.equal(yield* models.count, 2)
			}).pipe(Effect.provide(TestClock.layer())),
	)
	it.effect("a changed memory limit counts models that already run", () =>
		Effect.gen(function* () {
			const memory = yield* MemoryBot.MemoryBot
			const home = { organizationId: "org", bot: Bots.BotId.make("resize") }
			yield* memory.update(home, { expected: 0, concurrency: 2 })
			const models = yield* setup
			const learning = yield* models
				.run(yield* start("memory-resize-learn"), home, "bot_memory_operations")
				.pipe(Effect.forkChild)
			yield* Effect.raceFirst(
				models.asked,
				Fiber.join(learning).pipe(
					Effect.andThen(Effect.die("Learning ended before the model started")),
				),
			)
			yield* memory.update(home, { expected: 1, concurrency: 1 })
			const confess = yield* models
				.run(yield* start("memory-resize-wait"), home, "confess")
				.pipe(Effect.result, Effect.forkChild)
			yield* models.queued
			yield* Effect.yieldNow
			yield* TestClock.adjust("15 seconds")
			assert.isTrue(Result.isFailure(yield* Fiber.join(confess)))
			assert.equal(yield* models.count, 1)
			yield* memory.update(home, { expected: 2, concurrency: 2 })
			assert.equal(
				yield* models.run(yield* start("memory-resize-open"), home, "confess"),
				"I hear you.",
			)
			yield* models.open
			assert.equal(yield* Fiber.join(learning), "I hear you.")
			assert.equal(yield* models.count, 2)
		}).pipe(Effect.provide(TestClock.layer())),
	)
	it.effect("a saved memory answer needs no new model place", () =>
		Effect.gen(function* () {
			const memory = yield* MemoryBot.MemoryBot
			const home = { organizationId: "org", bot: Bots.BotId.make("replay") }
			yield* memory.update(home, { expected: 0, concurrency: 1 })
			const models = yield* setup
			const saved = yield* start("memory-replay-saved")
			assert.equal(yield* models.run(saved, home, "confess"), "I hear you.")
			const learning = yield* models
				.run(yield* start("memory-replay-busy"), home, "bot_memory_operations")
				.pipe(Effect.forkChild)
			yield* models.asked
			assert.equal(
				yield* models
					.run(saved, home, "confess")
					.pipe(Effect.timeout("3 seconds")),
				"I hear you.",
			)
			assert.equal(yield* models.count, 2)
			yield* models.open
			yield* Fiber.join(learning)
		}),
	)
})
