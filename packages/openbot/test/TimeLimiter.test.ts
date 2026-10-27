import {
	Array as Arr,
	Deferred,
	Effect,
	Fiber,
	Ref,
	Schema,
	Stream,
} from "effect"
import { assert, it, layer } from "@effect/vitest"
import { TestClock } from "effect/testing"
import { Chat, Plugin, PluginComposition } from "@openbot-build/core"
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/ai"
import * as TimeLimiter from "../src/plugins/time-limiter/TimeLimiter.ts"
import { ChatTest } from "./ChatTest.ts"

const usage = Response.Usage.make({
	inputTokens: {
		total: 1,
		uncached: 1,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: 1, reasoning: undefined },
})
const finish = (reason: Response.FinishReason = "stop") =>
	Response.makePart("finish", { reason, usage })
const answer = () =>
	Stream.make(
		Response.makePart("text-start", { id: "text" }),
		Response.makePart("text-delta", { id: "text", delta: "answer" }),
		Response.makePart("text-end", { id: "text" }),
		finish(),
	)
/** A model that streams the parts of `streamText`. */
const makeModel = (
	streamText: Parameters<typeof LanguageModel.make>[0]["streamText"],
) => LanguageModel.make({ generateText: () => Effect.succeed([]), streamText })
const Wait = Tool.make("Wait", {
	parameters: Schema.Struct({}),
	success: Schema.String,
})
const tools = Toolkit.make(Wait)
const toolPlugin = Plugin.make({ id: Plugin.Id.make("tools") })(() =>
	Effect.succeed((next, options) =>
		next({
			...options,
			toolkit: Effect.map(options.toolkit, (current) =>
				Toolkit.merge(current, tools),
			),
			instructions: Prompt.concat(options.instructions, [
				{ role: "system", content: "Use Wait" },
			]),
		}),
	),
)

it.effect("invalid time limits fail before any model request", () =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const model = yield* makeModel(() =>
			Stream.unwrap(
				Effect.as(
					Ref.update(calls, (n) => n + 1),
					Stream.empty,
				),
			),
		)
		for (const maxDuration of [0, -1, "Infinity", "-Infinity"] as const) {
			const chat = ChatTest(TimeLimiter.make({ maxDuration }))
			const error = yield* chat
				.execute({ input: "hello" })
				.pipe(
					Effect.flip,
					Effect.provideService(LanguageModel.LanguageModel, model),
				)
			assert.ok(Schema.is(TimeLimiter.InvalidMaxDuration)(error))
			assert.strictEqual(error.maxDuration, maxDuration)
		}
		assert.strictEqual(yield* Ref.get(calls), 0)
	}),
)

it.effect("stops a model step that runs past the limit", () =>
	Effect.gen(function* () {
		const released = yield* Ref.make(0)
		const started = yield* Deferred.make<void>()
		const chat = ChatTest(TimeLimiter.make({ maxDuration: "20 millis" }))
		const model = yield* makeModel(() =>
			Stream.unwrap(
				Effect.as(Deferred.succeed(started, undefined), Stream.never),
			).pipe(Stream.ensuring(Ref.update(released, (n) => n + 1))),
		)
		const fiber = yield* chat
			.execute({ input: "slow" })
			.pipe(
				Effect.flip,
				Effect.provideService(LanguageModel.LanguageModel, model),
				Effect.forkChild,
			)
		// The limit starts before the model does. A move of the clock before the
		// model starts can come before the limit, and then nothing stops the Turn.
		yield* Deferred.await(started)
		yield* TestClock.adjust("20 millis")
		const error = yield* Fiber.join(fiber)
		assert.ok(Schema.is(TimeLimiter.TimeLimitExceeded)(error))
		assert.strictEqual(yield* Ref.get(released), 1)
		assert.deepStrictEqual(
			Arr.map(error.history.content, (m) => m.role),
			["user"],
		)
	}),
)

layer(tools.toLayer({ Wait: () => Effect.never }))((it) => {
	it.effect(
		"stops a tool call that runs past the limit and keeps earlier history",
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const chat = ChatTest(
					PluginComposition.merge(
						TimeLimiter.make({ maxDuration: "20 millis" }),
						toolPlugin,
					),
				)
				const model = yield* makeModel(() =>
					Stream.unwrap(
						Effect.as(
							Deferred.succeed(started, undefined),
							Stream.make(
								Response.makePart("tool-call", {
									id: "wait-1",
									name: "Wait",
									params: {},
									providerExecuted: false,
								}),
								finish("tool-calls"),
							),
						),
					),
				)
				const fiber = yield* chat
					.execute({ input: "wait" })
					.pipe(
						Effect.flip,
						Effect.provideService(LanguageModel.LanguageModel, model),
						Effect.forkChild,
					)
				yield* Deferred.await(started)
				yield* TestClock.adjust("20 millis")
				const error = yield* Fiber.join(fiber)
				assert.ok(Schema.is(TimeLimiter.TimeLimitExceeded)(error))
				assert.strictEqual(error.history.content[0]?.role, "system")
			}),
	)
})

it.effect("a Turn that ends in time completes", () =>
	Effect.gen(function* () {
		const chat = ChatTest(TimeLimiter.make({ maxDuration: "1 minute" }))
		const model = yield* makeModel(() => answer())
		const view = yield* chat
			.execute({ input: "hello" })
			.pipe(Effect.provideService(LanguageModel.LanguageModel, model))
		assert.strictEqual(Chat.status(view.chat)._tag, "Completed")
	}),
)
