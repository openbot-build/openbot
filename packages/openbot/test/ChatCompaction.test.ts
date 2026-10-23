// @effect-diagnostics strictEffectProvide:off
import * as BotFixture from "./BotFixture.ts"
import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Config, Model, Provider } from "@openbot-build/core"
import { Effect, Layer, Redacted, Stream } from "effect"
import { LanguageModel, Response } from "effect/ai"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as ManagedChats from "../src/chats/ManagedChats.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"

const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}

test(
	"a long Chat gets a summary of its older context when it gets near the window of its model",
	{ timeout: 60000 },
	async () => {
		const database = await PostgresTest.start()
		const layer = DatabasePostgres.layer({
			databaseUrl: Redacted.make(database.url),
		}).pipe(Layer.provide(NodeServices.layer))
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* DatabasePostgres.migrate
						let summaries = 0
						let largest = 0
						const model = yield* LanguageModel.make({
							// Only a summary uses generateText.
							generateText: () =>
								Effect.sync(() => {
									summaries++
									return [
										Response.makePart("text", {
											text: "Summary of the talk so far.",
										}),
									]
								}),
							streamText: ({ prompt }) => {
								largest = Math.max(largest, JSON.stringify(prompt).length)
								return Stream.make(
									Response.makePart("text-start", { id: "answer" }),
									Response.makePart("text-delta", {
										id: "answer",
										delta: "I read it.",
									}),
									Response.makePart("text-end", { id: "answer" }),
									Response.makePart("finish", { reason: "stop", usage }),
								)
							},
						})
						const provider = Provider.Id.make("test")
						const id = Model.Id.make("small")
						const chats = yield* ManagedChats.make({
							modelCatalog: Effect.succeed({
								providers: [{ id: provider, name: "Test" }],
								models: [
									Config.Model.make({
										provider,
										id,
										name: "Small",
										reasoningEfforts: [],
										serviceTiers: [],
										// About 8000 characters of context.
										maxContextWindow: 2000,
									}),
								],
							}),
							defaults: Effect.succeed({
								model: Config.Selection.make({ provider, model: id }),
							}),
							resolveModel: () => Effect.succeed(model),
						})
						const created = yield* chats.create(BotFixture.direct())
						const chat = created.chat.id
						const author = ChatHost.authorOf("test-user")
						const page = "A long note about the work. ".repeat(30)
						for (let index = 0; index < 16; index++) {
							yield* chats.deliver(chat, {
								input: `Part ${index}: ${page}`,
								author,
							})
							let view = yield* chats.get(chat)
							for (
								let tries = 0;
								tries < 200 && view.activity === "active";
								tries++
							) {
								view = yield* chats.wait(
									chat,
									view.chat.revision,
									500,
									view.activity,
								)
							}
							assert.equal(view.status, "Completed")
						}
						// The older parts became a summary, so the context stays small.
						assert.ok(summaries > 0)
						const stored = yield* chats.read(chat)
						const context = JSON.stringify(
							stored.state.conversation.context.prompt,
						)
						assert.ok(context.includes("Summary of the talk so far."))
						assert.ok(!context.includes("Part 0:"))
						assert.ok(context.includes("Part 15:"))
						// No step sent much more than the window of the model.
						assert.ok(largest < 2000 * 4 * 1.5, String(largest))
						// The history keeps every Item, also those that are only in the summary.
						const items = yield* chats.items(chat, { limit: 100 })
						assert.ok(JSON.stringify(items.items).includes("Part 0:"))
					}),
				).pipe(Effect.provide(layer)),
			)
		} finally {
			await database.close()
		}
	},
)
