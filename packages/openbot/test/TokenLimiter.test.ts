import { Effect, Layer, Schema, Stream } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Session, Plugin, PluginComposition } from "@openbot-build/core"
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/ai"
import * as TokenLimiter from "../src/plugins/token-limiter/TokenLimiter.ts"
import { SessionTest } from "./SessionTest.ts"
// @effect-diagnostics strictEffectProvide:off

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
const LanguageModelTest = (
	streamText: Parameters<typeof LanguageModel.make>[0]["streamText"],
) =>
	Layer.effect(
		LanguageModel.LanguageModel,
		LanguageModel.make({ generateText: () => Effect.succeed([]), streamText }),
	)
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

test("invalid token limits fail before any model request", async () => {
	let calls = 0
	for (const maxTokens of [0, -1, 0.5, NaN, Infinity]) {
		const session = SessionTest(TokenLimiter.make({ maxTokens }))
		const error = await Effect.runPromise(
			session.execute({ input: "hello" }).pipe(
				Effect.flip,
				Effect.provide(
					LanguageModelTest(() => {
						calls++
						return Stream.empty
					}),
				),
			),
		)
		assert.ok(error instanceof TokenLimiter.InvalidMaxTokens)
		assert.equal(error.maxTokens, maxTokens)
	}
	assert.equal(calls, 0)
})

test("blocks the next model step when the used tokens reach the limit", async () => {
	for (const [maxTokens, steps] of [
		[1, 1],
		[5, 1],
		[6, 2],
		[10, 2],
		[11, 3],
	] as const) {
		let calls = 0
		const session = SessionTest(
			PluginComposition.merge(TokenLimiter.make({ maxTokens }), toolPlugin),
		)
		const error = await Effect.runPromise(
			session.execute({ input: "echo" }).pipe(
				Effect.flip,
				Effect.provide(
					Layer.merge(
						LanguageModelTest(() =>
							Stream.suspend(() => {
								calls++
								return Stream.make(call(calls), finish("tool-calls"))
							}),
						),
						handlers,
					),
				),
			),
		)
		assert.ok(error instanceof TokenLimiter.TokenLimitExceeded)
		assert.equal(calls, steps)
		assert.equal(error.maxTokens, maxTokens)
		assert.equal(error.usedTokens, steps * 5)
		assert.deepEqual(
			error.history.content.map((m) => m.role),
			[
				"system",
				"user",
				...Array.from({ length: steps }, () => ["assistant", "tool"]).flat(),
			],
		)
	}
})

test("a Turn that ends under the limit completes", async () => {
	const session = SessionTest(
		PluginComposition.merge(TokenLimiter.make({ maxTokens: 6 }), toolPlugin),
	)
	const view = await Effect.runPromise(
		session.execute({ input: "echo" }).pipe(
			Effect.provide(
				Layer.merge(
					LanguageModelTest(({ prompt }) =>
						prompt.content.some((m) => m.role === "tool")
							? answer()
							: Stream.make(call(1), finish("tool-calls")),
					),
					handlers,
				),
			),
		),
	)
	assert.equal(Session.currentTurn(view.session)!.steps, 2)
	assert.equal(Session.status(view.session)._tag, "Completed")
})

test("each execution counts its own tokens", async () => {
	const session = SessionTest(TokenLimiter.make({ maxTokens: 5 }))
	const model = LanguageModelTest(() => answer())
	for (const input of ["first", "second"]) {
		const view = await Effect.runPromise(
			session.execute({ input }).pipe(Effect.provide(model)),
		)
		assert.equal(Session.status(view.session)._tag, "Completed")
	}
})
