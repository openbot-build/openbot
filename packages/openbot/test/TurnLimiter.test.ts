import { Bot } from "@openbot-build/core"
import {
	Array as EffectArray,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Schema,
	Stream,
} from "effect"
import assert from "node:assert/strict"
import * as TurnLimiter from "../src/plugins/turn-limiter/TurnLimiter.ts"
import { test } from "node:test"
import { Chat, Plugin, PluginComposition } from "@openbot-build/core"

import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/ai"
import { ChatTest } from "./ChatTest.ts"
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
test("invalid limits fail only when run, before inner middleware or any model request", async () => {
	let enters = 0,
		calls = 0
	const inner = Plugin.make({ id: Plugin.Id.make("inner") })(() =>
		Effect.succeed((next, options) => {
			enters++
			return next(options)
		}),
	)
	for (const maxSteps of [
		0,
		-1,
		0.5,
		NaN,
		Infinity,
		Number.MAX_SAFE_INTEGER + 1,
	]) {
		const chat = ChatTest(
			PluginComposition.merge(TurnLimiter.make({ maxSteps }), inner),
		)
		const task = chat.execute({ input: "hello" })
		assert.equal(enters, 0)
		const error = await Effect.runPromise(
			task.pipe(
				Effect.flip,
				Effect.provide(
					LanguageModelTest(() => {
						calls++
						return Stream.empty
					}),
				),
			),
		)
		assert.ok(error instanceof TurnLimiter.InvalidMaxSteps)
		assert.equal(error.maxSteps, maxSteps)
	}
	assert.equal(enters + calls, 0)
})
test("blocks the next request after tool versions complete and keeps their typed history", async () => {
	for (const maxSteps of [1, 3])
		for (const mode of ["advance", "stream"]) {
			let calls = 0,
				released = 0
			let observed: ReadonlyArray<Bot.Event<typeof tools.tools>> = []
			const chat = ChatTest(
				PluginComposition.merge(TurnLimiter.make({ maxSteps }), toolPlugin),
			)
			const task =
				mode === "advance"
					? chat.execute({ input: "echo" })
					: chat.stream({ input: "echo" }).pipe(
							Stream.tap((e) =>
								Effect.sync(() => {
									observed = EffectArray.append(observed, e)
								}),
							),
							Stream.runDrain,
						)
			const error = await Effect.runPromise(
				task.pipe(
					Effect.flip,
					Effect.provide(
						Layer.merge(
							LanguageModelTest(() =>
								Stream.suspend(() => {
									calls++
									return Stream.make(call(calls), finish("tool-calls")).pipe(
										Stream.ensuring(
											Effect.sync(() => {
												released++
											}),
										),
									)
								}),
							),
							handlers,
						),
					),
				),
			)
			assert.ok(error instanceof TurnLimiter.ModelStepLimitExceeded)
			assert.equal(error.maxSteps, maxSteps)
			assert.equal(calls, maxSteps)
			assert.equal(released, maxSteps)
			assert.deepEqual(
				error.history.content.map((m) => m.role),
				[
					"system",
					"user",
					...Array.from({ length: maxSteps }, () => [
						"assistant",
						"tool",
					]).flat(),
				],
			)
			if (mode === "stream") {
				assert.deepEqual(
					observed
						.filter((e) => e._tag === "ModelStepStarted")
						.map((e) => e.step),
					Array.from({ length: maxSteps }, (_, i) => i + 1),
				)
				assert.equal(observed.at(-1)?._tag, "ChatUpdated")
				assert.equal(
					observed.filter((e) => e._tag === "ChatUpdated").length,
					maxSteps + 1,
				)
				for (const e of observed)
					if (
						e._tag === "ResponsePart" &&
						e.part.type === "tool-result" &&
						!e.part.isFailure
					) {
						const result: string = e.part.result
						assert.match(result, /tool:turn:/)
					}
			}
		}
})
test("a normal finish at the exact limit succeeds through execute and stream", async () => {
	for (const maxSteps of [1, 2]) {
		const chat = ChatTest(
			PluginComposition.merge(TurnLimiter.make({ maxSteps }), toolPlugin),
		)
		const model = LanguageModelTest(({ prompt }) =>
			maxSteps === 1 || prompt.content.some((m) => m.role === "tool")
				? answer()
				: Stream.make(call(1), finish("tool-calls")),
		)
		const layer = Layer.merge(model, handlers)
		const view = await Effect.runPromise(
			chat.execute({ input: "echo" }).pipe(Effect.provide(layer)),
		)
		assert.equal(Chat.currentTurn(view.chat)!.steps, maxSteps)
		assert.equal(Chat.status(view.chat)._tag, "Completed")
		const events = await Effect.runPromise(
			chat
				.stream({ input: "echo" })
				.pipe(Stream.runCollect, Effect.provide(layer)),
		)
		const final = events.at(-1)
		assert.ok(final?._tag === "TurnCompleted")
		assert.equal(Chat.status(final.view.chat)._tag, "Completed")
	}
})
test("an incomplete finish keeps its core state at the limit", async () => {
	const chat = ChatTest(
		PluginComposition.merge(TurnLimiter.make({ maxSteps: 1 }), toolPlugin),
	)
	const view = await Effect.runPromise(
		chat.execute({ input: "echo" }).pipe(
			Effect.provide(
				Layer.merge(
					LanguageModelTest(() => Stream.make(call(1), finish("length"))),
					handlers,
				),
			),
		),
	)
	assert.equal(Chat.currentTurn(view.chat)!.steps, 1)
	assert.equal(Chat.status(view.chat)._tag, "Completed")
})
test("a pending approval does not wait, so the next step meets the limit", async () => {
	const selected = Toolkit.make(Echo.setNeedsApproval(true))
	const plugin = Plugin.make({ id: Plugin.Id.make("selected") })(() =>
		Effect.succeed((next, options) =>
			next({ ...options, toolkit: Effect.succeed(selected) }),
		),
	)
	const chat = ChatTest(
		PluginComposition.merge(TurnLimiter.make({ maxSteps: 1 }), plugin),
	)
	const error = await Effect.runPromise(
		chat.execute({ input: "echo" }).pipe(
			Effect.flip,
			Effect.provide(
				Layer.merge(
					LanguageModelTest(() => Stream.make(call(1), finish("tool-calls"))),
					selected.toLayer({ Echo: () => Effect.succeed("done") }),
				),
			),
		),
	)
	assert.ok(error instanceof TurnLimiter.ModelStepLimitExceeded)
	// The pending result of the call is in the history, so no call is left open.
	assert.ok(
		error.history.content.some(
			(message) =>
				message.role === "tool" &&
				message.content.some((part) => part.type === "tool-result"),
		),
	)
})
test("repeated and concurrent executions keep limiter history separate", async () => {
	const chat = ChatTest(
		PluginComposition.merge(TurnLimiter.make({ maxSteps: 1 }), toolPlugin),
	)
	const model = LanguageModelTest(() =>
		Stream.make(call(1), finish("tool-calls")),
	)
	const outcomes = await Effect.runPromise(
		Effect.forEach(
			["first", "second"],
			(input) => chat.execute({ input }).pipe(Effect.flip),
			{ concurrency: "unbounded" },
		).pipe(Effect.provide(Layer.merge(model, handlers))),
	)
	for (const [index, error] of outcomes.entries()) {
		assert.ok(error instanceof TurnLimiter.ModelStepLimitExceeded)
		const text = JSON.stringify(error.history)
		assert.match(text, new RegExp(index === 0 ? "first" : "second"))
		assert.doesNotMatch(text, new RegExp(index === 0 ? "second" : "first"))
	}
})
test("interruption unwinds limiter middleware and keeps native cancellation", async () => {
	let started = Deferred.makeUnsafe<void>(),
		order: ReadonlyArray<string> = []
	const track = (name: string) =>
		Plugin.make({ id: Plugin.Id.make(name) })(() =>
			Effect.succeed((next, options) =>
				Stream.suspend(() => {
					order = EffectArray.append(order, name + ":enter")
					return next(options).pipe(
						Stream.ensuring(
							Effect.sync(() => {
								order = EffectArray.append(order, name + ":exit")
							}),
						),
					)
				}),
			),
		)
	const chat = ChatTest(
		PluginComposition.merge(
			track("outer"),
			PluginComposition.merge(
				TurnLimiter.make({ maxSteps: 1 }),
				track("inner"),
			),
		),
	)
	const exit = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					Stream.runDrain(chat.stream({ input: "wait" })),
				)
				yield* Deferred.await(started)
				yield* Fiber.interrupt(fiber)
				return yield* Fiber.await(fiber)
			}),
		).pipe(
			Effect.provide(
				LanguageModelTest(() =>
					Stream.fromEffect(
						Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Effect.never),
						),
					),
				),
			),
		),
	)
	assert.ok(Exit.isFailure(exit))
	assert.ok(Cause.hasInterruptsOnly(exit.cause))
	assert.deepEqual(order, [
		"outer:enter",
		"inner:enter",
		"inner:exit",
		"outer:exit",
	])
})
