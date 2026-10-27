import { Array as Arr, Effect, Ref, Schema, Stream } from "effect"
import { assert, it, layer } from "@effect/vitest"
import { Chat, Plugin, PluginComposition } from "@openbot-build/core"
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/ai"
import * as TokenLimiter from "../src/plugins/token-limiter/TokenLimiter.ts"
import { ChatTest } from "./ChatTest.ts"

// Each model step uses 3 input tokens and 2 output tokens.
const usage = Response.Usage.make({
	inputTokens: {
		total: 3,
		uncached: 3,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 2, text: 2, reasoning: undefined },
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
const Echo = Tool.make("Echo", {
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.String,
})
const tools = Toolkit.make(Echo)
const handlers = tools.toLayer({
	Echo: ({ text }) => Effect.succeed("tool:" + text),
})
const call = (n: number) =>
	Response.makePart("tool-call", {
		id: "echo-" + n,
		name: "Echo",
		params: { text: "turn:" + n },
		providerExecuted: false,
	})
const toolPlugin = Plugin.make({ id: Plugin.Id.make("tools") })(() =>
	Effect.succeed((next, options) =>
		next({
			...options,
			toolkit: Effect.map(options.toolkit, (current) =>
				Toolkit.merge(current, tools),
			),
			instructions: Prompt.concat(options.instructions, [
				{ role: "system", content: "Use Echo" },
			]),
		}),
	),
)

it.effect("invalid token limits fail before any model request", () =>
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
		for (const maxTokens of [0, -1, 0.5, NaN, Infinity]) {
			const chat = ChatTest(TokenLimiter.make({ maxTokens }))
			const error = yield* chat
				.execute({ input: "hello" })
				.pipe(
					Effect.flip,
					Effect.provideService(LanguageModel.LanguageModel, model),
				)
			assert.ok(Schema.is(TokenLimiter.InvalidMaxTokens)(error))
			// NaN is not equal to itself, so use Object.is.
			assert.ok(Object.is(error.maxTokens, maxTokens))
		}
		assert.strictEqual(yield* Ref.get(calls), 0)
	}),
)

layer(handlers)((it) => {
	it.effect(
		"blocks the next model step when the used tokens reach the limit",
		() =>
			Effect.gen(function* () {
				for (const [maxTokens, steps] of [
					[1, 1],
					[5, 1],
					[6, 2],
					[10, 2],
					[11, 3],
				] as const) {
					const calls = yield* Ref.make(0)
					const chat = ChatTest(
						PluginComposition.merge(
							TokenLimiter.make({ maxTokens }),
							toolPlugin,
						),
					)
					const model = yield* makeModel(() =>
						Stream.unwrap(
							Effect.map(
								Ref.updateAndGet(calls, (n) => n + 1),
								(n) => Stream.make(call(n), finish("tool-calls")),
							),
						),
					)
					const error = yield* chat
						.execute({ input: "echo" })
						.pipe(
							Effect.flip,
							Effect.provideService(LanguageModel.LanguageModel, model),
						)
					assert.ok(Schema.is(TokenLimiter.TokenLimitExceeded)(error))
					assert.strictEqual(yield* Ref.get(calls), steps)
					assert.strictEqual(error.maxTokens, maxTokens)
					assert.strictEqual(error.usedTokens, steps * 5)
					assert.deepStrictEqual(
						Arr.map(error.history.content, (m) => m.role),
						[
							"system",
							"user",
							...Arr.flatten(
								Arr.replicate(["assistant", "tool"] as const, steps),
							),
						],
					)
				}
			}),
	)

	it.effect("a Turn that ends under the limit completes", () =>
		Effect.gen(function* () {
			const chat = ChatTest(
				PluginComposition.merge(
					TokenLimiter.make({ maxTokens: 6 }),
					toolPlugin,
				),
			)
			const model = yield* makeModel(({ prompt }) =>
				Arr.some(prompt.content, (m) => m.role === "tool")
					? answer()
					: Stream.make(call(1), finish("tool-calls")),
			)
			const view = yield* chat
				.execute({ input: "echo" })
				.pipe(Effect.provideService(LanguageModel.LanguageModel, model))
			assert.strictEqual(Chat.currentTurn(view.chat)!.steps, 2)
			assert.strictEqual(Chat.status(view.chat)._tag, "Completed")
		}),
	)
})

it.effect("each execution counts its own tokens", () =>
	Effect.gen(function* () {
		const chat = ChatTest(TokenLimiter.make({ maxTokens: 5 }))
		const model = yield* makeModel(() => answer())
		for (const input of ["first", "second"]) {
			const view = yield* chat
				.execute({ input })
				.pipe(Effect.provideService(LanguageModel.LanguageModel, model))
			assert.strictEqual(Chat.status(view.chat)._tag, "Completed")
		}
	}),
)
