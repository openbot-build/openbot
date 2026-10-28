import { Chat, Item, Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Schema,
	String as Str,
} from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { Calls } from "../execution/Calls.ts"
import { Store, storage, type Fence } from "../execution/Store.ts"
import { Records, category } from "../errors/Records.ts"
import type { Bots } from "@openbot-build/domain"
import { BotMemories, type Home } from "./BotMemories.ts"
import { MemoryLogs } from "./MemoryLogs.ts"
import { fallbackReply } from "./MemoryBot.ts"
import { MemoryModels } from "./MemoryModels.ts"
import * as Rules from "./MemoryRules.ts"
import * as Evidence from "./MemoryEvidence.ts"

export interface Service {
	readonly confess: (
		fence: Fence,
		input: {
			readonly home: Home
			readonly bot: Bots.Bot
			readonly chat: Chat.Ref
			readonly items: ReadonlyArray<Item.Record>
			readonly turn: Turn.Id
			readonly text: string
		},
		callId: string,
	) => Effect.Effect<string, never>
	readonly enrich: (
		fence: Fence,
		input: {
			readonly home: Home
			readonly chat: Chat.Ref
			readonly turn: Turn.Id
			readonly text: string
		},
	) => Effect.Effect<Option.Option<string>, never>
}

export class MemoryTasks extends Context.Service<MemoryTasks, Service>()(
	"@openbot-build/openbot/bots/MemoryTasks",
) {}

const make = Effect.gen(function* () {
	const models = yield* MemoryModels
	const memories = yield* BotMemories
	const store = yield* Store
	const calls = yield* Calls
	const errors = yield* Records
	const { confessions, enrichments } = yield* MemoryLogs
	const fallback = <A, E, R>(
		fence: Fence,
		work: Effect.Effect<A, E, R>,
		value: A,
	) =>
		work.pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: errors
							.record(cause, category(cause), fence.id)
							.pipe(Effect.orDie, Effect.as(value)),
			),
		)
	const confess = (
		fence: Fence,
		input: {
			readonly home: Home
			readonly bot: Bots.Bot
			readonly chat: Chat.Ref
			readonly items: ReadonlyArray<Item.Record>
			readonly turn: Turn.Id
			readonly text: string
		},
		callId: string,
	) =>
		fallback(
			fence,
			Effect.gen(function* () {
				yield* calls.authorize(fence, "replay")
				const saved = yield* store.loadMember(fence)
				const reply = yield* models.run(
					fence,
					"memory:confess:" + callId,
					input.home,
					{
						schema: Schema.String,
						kind: "text",
						name: "bot_confession",
						send: (prompt) =>
							LanguageModel.generateText({ prompt }).pipe(
								Effect.map((response) => ({
									value: response.text,
									usage: response.usage,
								})),
							),
						prompt: (instructions) =>
							Effect.gen(function* () {
								const viewer = Evidence.viewer(input.chat, saved.identity)
								const context = yield* memories.context(
									input.home,
									viewer,
									20000,
								)
								return Prompt.make([
									{
										role: "system",
										content:
											Rules.confessorRules +
											"\n\nRules of the owner of the Bot:\n" +
											instructions,
									},
									{
										role: "user",
										content: yield* Schema.encodeEffect(
											Schema.fromJsonString(Schema.Unknown),
										)({
											bot: { name: input.bot.name, role: input.bot.role },
											words: input.text,
											conversation: Str.takeRight(
												Arr.join(
													Arr.map(
														Arr.filter(
															Arr.flatMap(
																Arr.takeRight(input.items, 20),
																(item) => item.content.content,
															),
															(message) =>
																message.role === "user" ||
																message.role === "assistant",
														),
														(message) =>
															message.role + ": " + Evidence.textOf(message),
													),
													"\n",
												),
												8000,
											),
											memory: context.text,
										}),
									},
								])
							}).pipe(storage),
					},
				)
				const answer =
					Str.trim(reply).length === 0 ? fallbackReply : Str.trim(reply)
				const id = "cnf_" + fence.id + ":" + callId
				yield* store.commit(
					fence,
					{},
					confessions.put(
						{
							organizationId: saved.identity.owner.organizationId,
							id,
							owner: input.chat.id,
							scope: input.turn,
							status: "",
						},
						{
							id,
							chat: input.chat.id,
							turn: input.turn,
							text: input.text,
							reply: answer,
							at: yield* Clock.currentTimeMillis,
						},
					),
				)
				return answer
			}),
			fallbackReply,
		)
	const enrich = (
		fence: Fence,
		input: {
			readonly home: Home
			readonly chat: Chat.Ref
			readonly turn: Turn.Id
			readonly text: string
		},
	) =>
		fallback(
			fence,
			Effect.gen(function* () {
				yield* calls.authorize(fence, "replay")
				const saved = yield* store.loadMember(fence)
				const viewer = Evidence.viewer(input.chat, saved.identity)
				const context = yield* memories.context(input.home, viewer, 8000)
				if (!context.hasEntries || Str.trim(input.text).length === 0)
					return Option.none<string>()
				const answer = yield* models.run(
					fence,
					"memory:enrich:" + input.turn,
					input.home,
					{
						schema: Schema.toCodecJson(Rules.Enriched),
						kind: "object",
						name: "enriched_message",
						send: (prompt) =>
							LanguageModel.generateObject({
								prompt,
								objectName: "enriched_message",
								schema: Rules.Enriched,
							}).pipe(
								Effect.map((response) => ({
									value: response.value,
									usage: response.usage,
								})),
							),
						prompt: (instructions) =>
							Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
								message: input.text,
								memory: context.text,
							}).pipe(
								Effect.map((content) =>
									Prompt.make([
										{
											role: "system",
											content:
												Rules.enrichRules +
												"\n\nRules of the owner of the Bot:\n" +
												instructions,
										},
										{ role: "user", content },
									]),
								),
								storage,
							),
					},
				)
				// A saved answer is checked against current visibility before it reaches the model.
				if (
					Str.trim(answer.text).length === 0 ||
					answer.text === input.text ||
					answer.entries.length === 0 ||
					!(yield* memories.validateReferences(
						input.home,
						viewer,
						answer.entries,
					))
				)
					return Option.none<string>()
				yield* store.commit(
					fence,
					{},
					enrichments.put(
						{
							organizationId: saved.identity.owner.organizationId,
							id: input.chat.id + "/" + input.turn,
							owner: input.chat.id,
							scope: input.turn,
							status: "",
						},
						{
							chat: input.chat.id,
							turn: input.turn,
							text: answer.text,
							original: input.text,
							entries: Arr.dedupe(answer.entries),
							at: yield* Clock.currentTimeMillis,
						},
					),
				)
				return Option.some(answer.text)
			}),
			Option.none<string>(),
		)
	return MemoryTasks.of({ confess, enrich })
})

export const layer = Layer.effect(MemoryTasks, make)
