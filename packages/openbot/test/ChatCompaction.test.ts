import * as BotFixture from "./BotFixture.ts"
import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	Effect,
	Option,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, Response } from "effect/ai"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as ManagedChats from "../src/chats/ManagedChats.ts"
import * as HostTools from "../src/chats/HostTools.ts"
import * as ChatsFixture from "./ChatsFixture.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"

const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

// The database is a real server, so the test runs on the real clock.
layer(ChatsFixture.layerDatabase, {
	excludeTestServices: true,
	timeout: "60 seconds",
})((it) => {
	it.effect(
		"a long Chat gets a summary of its older context when it gets near the window of its model",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const summaries = yield* Ref.make(0)
				const largest = yield* Ref.make(0)
				const model = yield* LanguageModel.make({
					// Only a summary uses generateText.
					generateText: () =>
						Ref.update(summaries, (count) => count + 1).pipe(
							Effect.as([
								Response.makePart("text", {
									text: "Summary of the talk so far.",
								}),
							]),
						),
					streamText: ({ prompt }) =>
						Stream.unwrap(
							encodeJson(prompt).pipe(
								Effect.orDie,
								Effect.flatMap((text) =>
									Ref.update(largest, (size) => Math.max(size, text.length)),
								),
								Effect.as(
									Stream.make(
										Response.makePart("text-start", { id: "answer" }),
										Response.makePart("text-delta", {
											id: "answer",
											delta: "I read it.",
										}),
										Response.makePart("text-end", { id: "answer" }),
										Response.makePart("finish", { reason: "stop", usage }),
									),
								),
							),
						),
				})
				// About 8000 characters of context.
				const chats = yield* ManagedChats.make(
					ChatsFixture.models(model, 2000),
				).pipe(Effect.provide(HostTools.none))
				const created = yield* chats.create(BotFixture.direct())
				const chat = created.chat.id
				const author = ChatHost.authorOf("test-user")
				const page = Str.repeat(30)("A long note about the work. ")
				for (let index = 0; index < 16; index++) {
					yield* chats.deliver(chat, {
						input: `Part ${index}: ${page}`,
						author,
					})
					const view = yield* ChatsFixture.settled(chats, chat)
					assert.strictEqual(view.status, "Completed")
				}
				// The older parts became a summary, so the context stays small.
				assert.ok((yield* Ref.get(summaries)) > 0)
				const stored = yield* chats.read(chat)
				const context = yield* encodeJson(
					stored.state.conversation.context.prompt,
				)
				assert.ok(Str.includes("Summary of the talk so far.")(context))
				assert.ok(!Str.includes("Part 0:")(context))
				assert.ok(Str.includes("Part 15:")(context))
				// No step sent much more than the window of the model.
				const step = yield* Ref.get(largest)
				assert.ok(step < 2000 * 4 * 1.5, String(step))
				// The history keeps every Item, also those that are only in the summary.
				const items = yield* chats.items(chat, { limit: 100 })
				assert.ok(Str.includes("Part 0:")(yield* encodeJson(items.items)))
			}),
		60000,
	)
	it.effect(
		"a slow event reader still gets one final response after the Turn ends",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const model = yield* LanguageModel.make({
					generateText: () => Effect.succeed([]),
					streamText: () =>
						Stream.fromIterable([
							Response.makePart("text-start", { id: "answer" }),
							...Arr.replicate(
								Response.makePart("text-delta", {
									id: "answer",
									delta: "word ",
								}),
								2048,
							),
							Response.makePart("text-end", { id: "answer" }),
							Response.makePart("finish", { reason: "stop", usage }),
						]),
				})
				const chats = yield* ManagedChats.make({
					...ChatsFixture.models(model),
					namespace: "slow-events",
				}).pipe(Effect.provide(HostTools.none))
				const chat = (yield* chats.create(BotFixture.direct())).chat.id
				const result = yield* chats.deliverStream(chat, {
					input: "Write a long answer",
					author: ChatHost.authorOf("test-user"),
				})
				assert.ok(Option.isSome(result.events))
				yield* ChatsFixture.settled(chats, chat)
				const events = yield* Stream.runCollect(result.events.value).pipe(
					Effect.timeout("10 seconds"),
				)
				assert.strictEqual(
					Arr.filter(events, (event) => event.event === "response.completed")
						.length,
					1,
				)
				assert.strictEqual(
					Arr.last(events).pipe(
						Option.map((event) => event.event),
						Option.getOrElse(() => "none"),
					),
					"response.completed",
				)
			}),
		60000,
	)
})
