import { Effect, Layer, Schema, Stream } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Session, Plugin, PluginComposition } from "@openbot-build/core"
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/ai"
import * as TimeLimiter from "../src/plugins/time-limiter/TimeLimiter.ts"
import { SessionTest } from "./SessionTest.ts"
// @effect-diagnostics strictEffectProvide:off

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
const LanguageModelTest = (
	streamText: Parameters<typeof LanguageModel.make>[0]["streamText"],
) =>
	Layer.effect(
		LanguageModel.LanguageModel,
		LanguageModel.make({ generateText: () => Effect.succeed([]), streamText }),
	)
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

test("invalid time limits fail before any model request", async () => {
	let calls = 0
	for (const maxDuration of [0, -1, "Infinity", "-Infinity"] as const) {
		const session = SessionTest(TimeLimiter.make({ maxDuration }))
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
		assert.ok(error instanceof TimeLimiter.InvalidMaxDuration)
		assert.equal(error.maxDuration, maxDuration)
	}
	assert.equal(calls, 0)
})

test("stops a model step that runs past the limit", async () => {
	let released = 0
	const session = SessionTest(TimeLimiter.make({ maxDuration: "20 millis" }))
	const error = await Effect.runPromise(
		session.execute({ input: "slow" }).pipe(
			Effect.flip,
			Effect.provide(
				LanguageModelTest(() =>
					Stream.never.pipe(
						Stream.ensuring(
							Effect.sync(() => {
								released++
							}),
						),
					),
				),
			),
		),
	)
	assert.ok(error instanceof TimeLimiter.TimeLimitExceeded)
	assert.equal(released, 1)
	assert.deepEqual(
		error.history.content.map((m) => m.role),
		["user"],
	)
})

test("stops a tool call that runs past the limit and keeps earlier history", async () => {
	const session = SessionTest(
		PluginComposition.merge(
			TimeLimiter.make({ maxDuration: "20 millis" }),
			toolPlugin,
		),
	)
	const error = await Effect.runPromise(
		session.execute({ input: "wait" }).pipe(
			Effect.flip,
			Effect.provide(
				Layer.merge(
					LanguageModelTest(() =>
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
					tools.toLayer({ Wait: () => Effect.never }),
				),
			),
		),
	)
	assert.ok(error instanceof TimeLimiter.TimeLimitExceeded)
	assert.equal(error.history.content[0]?.role, "system")
})

test("a Turn that ends in time completes", async () => {
	const session = SessionTest(TimeLimiter.make({ maxDuration: "1 minute" }))
	const view = await Effect.runPromise(
		session
			.execute({ input: "hello" })
			.pipe(Effect.provide(LanguageModelTest(() => answer()))),
	)
	assert.equal(Session.status(view.session)._tag, "Completed")
})
