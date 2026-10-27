import * as Read from "./Read.ts"
import {
	BrowserHost,
	Caller,
	Messages,
	Chats,
} from "@openbot-build/openbot/testing"
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
import { Execution } from "@openbot-build/domain"
import { HostTools } from "@openbot-build/openbot"

const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

// The database is a real server, so the test runs on the real clock.
layer(BrowserHost.layerPlatform, {
	excludeTestServices: true,
	timeout: "60 seconds",
})((it) => {
	it.effect(
		"a long Chat gets a summary of its older context when it gets near the window of its model",
		() =>
			Effect.gen(function* () {
				const summaries = yield* Ref.make(0)
				const largest = yield* Ref.make(0)
				const model = yield* LanguageModel.make({
					generateText: () => Effect.die("This test uses saved model streams."),
					streamText: ({ prompt, tools }) =>
						Stream.unwrap(
							Effect.gen(function* () {
								const summary = tools.length === 0
								if (summary) yield* Ref.update(summaries, (count) => count + 1)
								else
									yield* Ref.update(largest, (size) =>
										Math.max(size, JSON.stringify(prompt).length),
									)
								return Stream.make(
									Response.makePart("text-start", { id: "answer" }),
									Response.makePart("text-delta", {
										id: "answer",
										delta: summary
											? "Summary of the talk so far."
											: "I read it.",
									}),
									Response.makePart("text-end", { id: "answer" }),
									Response.makePart("finish", { reason: "stop", usage }),
								)
							}),
						),
				})
				const publicOrigin = "https://compaction.example.com"
				const host = yield* BrowserHost.start({
					publicOrigin,
					model,
					contextWindow: 64000,
					hostTools: HostTools.none,
				})
				const member = yield* host.login("compaction")
				const bot = yield* host.defaultBot(member.session)
				const send: Messages.Send = (path, method, body) =>
					Effect.flatMap(host.address, (address) =>
						Caller.withCookie({ address, publicOrigin })(
							member.session,
							path,
							method,
							body,
						),
					)
				const chat = yield* host.run(Chats.direct(member.identity, bot))
				const page = Str.repeat(1000)("A long note about the work. ")
				for (let index = 0; index < 16; index++) {
					yield* Messages.send(send, chat, `Part ${index}: ${page}`)
					const view = yield* Messages.settled(send, chat)
					assert.strictEqual(view.status, "Completed")
				}
				// The older parts became a summary, so the context stays small.
				assert.ok((yield* Ref.get(summaries)) > 0)
				const context = yield* host
					.run(Chats.contextPrompt(member.identity, chat))
					.pipe(Effect.flatMap(encodeJson))
				assert.ok(Str.includes("Summary of the talk so far.")(context))
				assert.ok(!Str.includes("Part 0:")(context))
				assert.ok(Str.includes("Part 15:")(context))
				// No step sent much more than the window of the model.
				const step = yield* Ref.get(largest)
				assert.ok(step < 64000 * 4 * 1.5, String(step))
				// The history keeps every Item, also those that are only in the summary.
				const items = yield* Read.items(send, chat)
				assert.ok(Str.includes("Part 0:")(yield* encodeJson(items.items)))
			}),
		60000,
	)
	it.effect(
		"a slow event reader still gets one final response after the Turn ends",
		() =>
			Effect.gen(function* () {
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
				const publicOrigin = "https://slow-events.example.com"
				const host = yield* BrowserHost.start({
					publicOrigin,
					model,
					hostTools: HostTools.none,
				})
				const member = yield* host.login("slow-events")
				const bot = yield* host.defaultBot(member.session)
				const send: Messages.Send = (path, method, body) =>
					Effect.flatMap(host.address, (address) =>
						Caller.withCookie({ address, publicOrigin })(
							member.session,
							path,
							method,
							body,
						),
					)
				const result = yield* Messages.message(send, bot, "Write a long answer")
				yield* Messages.settled(send, result.chat)
				const events = yield* Read.observe(send, result.executionId).pipe(
					Effect.timeout("10 seconds"),
				)
				assert.strictEqual(
					Arr.filter(
						events,
						(event) =>
							event.body._tag === "State" &&
							Execution.isTerminal(event.body.status),
					).length,
					1,
				)
				assert.deepEqual(Option.getOrThrow(Arr.last(events)).body, {
					_tag: "State",
					status: "completed",
					failure: null,
				})
				const end = Option.getOrThrow(Arr.last(events))
				const replay = yield* Read.observe(
					send,
					result.executionId,
					end.sequence - 1,
				)
				assert.deepEqual(replay, [end])
			}),
		60000,
	)
})
