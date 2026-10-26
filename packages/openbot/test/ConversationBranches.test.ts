import { assert, layer } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { Effect, Ref, Stream, Exit, Option, Array as Arr } from "effect"
import { LanguageModel, Response } from "effect/ai"
import * as ManagedChats from "../src/chats/ManagedChats.ts"
import * as HostTools from "../src/chats/HostTools.ts"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as ChatsFixture from "./ChatsFixture.ts"
import * as BotFixture from "./BotFixture.ts"

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
const createInput = (requestId: string) => ({
	...BotFixture.direct(),
	kind: "conversation" as const,
	requestId,
})
const runtime = (namespace: string) =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const model = yield* LanguageModel.make({
			generateText: () => Effect.succeed([]),
			streamText: () =>
				Stream.unwrap(
					Effect.gen(function* () {
						yield* Ref.update(calls, (n) => n + 1)
						return Stream.make(
							Response.makePart("text-start", { id: "answer" }),
							Response.makePart("text-delta", {
								id: "answer",
								delta: "Saved answer.",
							}),
							Response.makePart("text-end", { id: "answer" }),
							Response.makePart("finish", { reason: "stop", usage }),
						)
					}),
				),
		})
		const chats = yield* ManagedChats.make({
			...ChatsFixture.models(model),
			namespace,
		}).pipe(Effect.provide(HostTools.none))
		return { chats, calls }
	})
layer(ChatsFixture.layerDatabase, {
	excludeTestServices: true,
	timeout: "60 seconds",
})((it) => {
	it.effect(
		"independent conversations share a Bot but not history, and a repeated create finds its Chat",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const { chats } = yield* runtime("create-conversations")
				const first = yield* chats.create(createInput("first"))
				const second = yield* chats.create(createInput("second"))
				assert.notStrictEqual(first.chat.id, second.chat.id)
				assert.strictEqual(first.chat.bot, second.chat.bot)
				assert.deepStrictEqual(first.chat.memory, { read: true, write: true })
				assert.strictEqual(
					(yield* chats.create(createInput("first"))).chat.id,
					first.chat.id,
				)
				const changed = yield* Effect.exit(
					chats.create({
						...createInput("first"),
						memory: { read: false, write: false },
					}),
				)
				assert.isTrue(Exit.isFailure(changed))
				const direct = yield* chats.direct(
					BotFixture.bot,
					BotFixture.direct().chain,
				)
				assert.strictEqual(
					yield* chats.direct(BotFixture.bot, BotFixture.direct().chain),
					direct,
				)
				assert.notStrictEqual(direct, first.chat.id)
				yield* chats.deliver(first.chat.id, {
					input: "First",
					author: "test-user",
				})
				yield* ChatsFixture.settled(chats, first.chat.id)
				assert.strictEqual(
					(yield* chats.items(second.chat.id, {})).items.length,
					0,
				)
			}),
	)
	it.effect(
		"a fork copies saved Items and Turns without running a model, and survives restart",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const { chats, calls } = yield* runtime("fork-conversations")
				const source = yield* chats.create(createInput("source"))
				yield* chats.deliver(source.chat.id, {
					input: "Keep this",
					author: "test-user",
				})
				const settled = yield* ChatsFixture.settled(chats, source.chat.id)
				const before = yield* chats.items(source.chat.id, {})
				const turn = settled.turn!
				const fork = yield* chats.fork(source.chat.id, {
					expected: settled.chat.revision,
					requestId: "fork",
					reason: "fork",
				})
				assert.strictEqual(yield* Ref.get(calls), 1)
				assert.strictEqual(fork.chat.branchOf?.throughSeq, before.items.length)
				assert.deepStrictEqual(
					Arr.map((yield* chats.items(fork.chat.id, {})).items, (item) => item.id),
					Arr.map(before.items, (item) => item.id),
				)
				assert.strictEqual(
					(yield* chats.turn(fork.chat.id, turn.id)).turn.id,
					turn.id,
				)
				assert.deepStrictEqual((yield* chats.read(fork.chat.id)).chat.inbox, [])
				assert.strictEqual(
					(yield* chats.read(fork.chat.id)).chat.turn,
					undefined,
				)
				assert.strictEqual(
					ChatHost.hostState((yield* chats.read(fork.chat.id)).chat)
						.learnAfterSeq,
					before.items.length,
				)
				assert.strictEqual(
					(yield* chats.fork(source.chat.id, {
						expected: settled.chat.revision,
						requestId: "fork",
						reason: "fork",
					})).chat.id,
					fork.chat.id,
				)
				const restarted = (yield* runtime("fork-conversations")).chats
				assert.strictEqual(
					(yield* restarted.branches(source.chat.id)).length,
					2,
				)
				const regeneration = yield* restarted.fork(source.chat.id, {
					expected: settled.chat.revision,
					requestId: "regenerate",
					reason: "regenerate",
					through: { turnId: turn.id, edge: "before" },
				})
				assert.strictEqual(
					(yield* restarted.items(regeneration.chat.id, {})).items.length,
					0,
				)
				assert.strictEqual(yield* Ref.get(calls), 1)
				assert.deepStrictEqual(
					(yield* restarted.items(source.chat.id, {})).items,
					before.items,
				)
			}),
	)
	it.effect(
		"a fork rejects an old revision, unsettled operations and a foreign namespace",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const { chats } = yield* runtime("guard-conversations")
				const source = yield* chats.create(createInput("source"))
				yield* chats.update(source.chat.id, {
					expected: source.chat.revision,
					memory: { read: false, write: false },
				})
				assert.isTrue(
					Exit.isFailure(
						yield* Effect.exit(
							chats.fork(source.chat.id, {
								expected: source.chat.revision,
								requestId: "old",
								reason: "fork",
							}),
						),
					),
				)
				const current = yield* chats.get(source.chat.id)
				assert.deepStrictEqual(current.chat.memory, {
					read: false,
					write: false,
				})
				const sql = yield* PgClient.PgClient
				yield* sql`insert into openbot_app_invocations(owner,id,chat,status,body) values('guard-conversations','unknown',${source.chat.id},'OutcomeUnknown','{}')`
				assert.isTrue(
					Exit.isFailure(
						yield* Effect.exit(
							chats.fork(source.chat.id, {
								expected: current.chat.revision,
								requestId: "unknown",
								reason: "fork",
							}),
						),
					),
				)
				const foreign = (yield* runtime("foreign-conversations")).chats
				assert.isTrue(
					Exit.isFailure(
						yield* Effect.exit(
							foreign.fork(source.chat.id, {
								expected: current.chat.revision,
								requestId: "cross-user",
								reason: "fork",
							}),
						),
					),
				)
				assert.strictEqual((yield* chats.branches(source.chat.id)).length, 1)
			}),
	)
	it.effect(
		"memory overrides belong to one Turn and old policy writes cannot commit",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const { chats } = yield* runtime("memory-conversations")
				const source = yield* chats.create(createInput("source"))
				yield* chats.deliver(source.chat.id, {
					input: "Private",
					author: "test-user",
					memory: { read: false, write: false },
				})
				const privateTurn = (yield* ChatsFixture.settled(chats, source.chat.id))
					.turn!
				assert.deepStrictEqual(privateTurn.metadata?.["memory"], {
					read: false,
					write: false,
				})
				assert.deepStrictEqual((yield* chats.get(source.chat.id)).chat.memory, {
					read: true,
					write: true,
				})
				yield* chats.deliver(source.chat.id, {
					input: "Remember this",
					author: "test-user",
				})
				const regular = yield* ChatsFixture.settled(chats, source.chat.id)
				assert.deepStrictEqual(regular.turn?.metadata?.["memory"], {
					read: true,
					write: true,
				})
				assert.deepStrictEqual(
					(yield* chats.itemsAfter(source.chat.id, 0)).memoryDenied,
					[privateTurn.id],
				)
				yield* chats.update(source.chat.id, {
					expected: regular.chat.revision,
					memory: { read: false, write: false },
				})
				const saved = yield* Ref.make(false)
				const result = yield* chats.withMemoryWrite(
					source.chat.id,
					0,
					Ref.set(saved, true),
				)
				assert.isTrue(Option.isNone(result))
				assert.isFalse(yield* Ref.get(saved))
				const state = ChatHost.hostState(
					(yield* chats.read(source.chat.id)).chat,
				)
				assert.strictEqual(
					state.learnAfterSeq,
					(yield* chats.items(source.chat.id, {})).items.length,
				)
			}),
	)
})
