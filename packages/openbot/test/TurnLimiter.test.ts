import { assert, it } from "@effect/vitest"
import { Bot, Chat, Plugin, PluginComposition } from "@openbot-build/core"
import {
	Array as Arr,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	pipe,
	Ref,
	Schema,
	Stream,
} from "effect"
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/ai"
import * as TurnLimiter from "../src/plugins/turn-limiter/TurnLimiter.ts"
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
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
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
	Effect.map(
		Effect.context<Tool.HandlersFor<typeof tools.tools>>(),
		(handlers) => ({
			tools: tools.tools,
			handlers,
			instructions: Prompt.make([{ role: "system", content: "Use Echo" }]),
		}),
	),
)

it.effect(
	"invalid limits fail only when run, before later hooks or any model request",
	() =>
		Effect.gen(function* () {
			let enters = 0,
				calls = 0
			const inner = Plugin.make({ id: Plugin.Id.make("inner") })(() =>
				Effect.succeed({
					tools: {},
					handlers: Context.empty(),
					beforeStep: () =>
						Effect.sync(() => {
							enters++
							return true
						}),
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
				assert.strictEqual(enters, 0)
				const error = yield* task.pipe(
					Effect.flip,
					Effect.provide(
						LanguageModelTest(() => {
							calls++
							return Stream.empty
						}),
					),
				)
				assert.ok(Schema.is(TurnLimiter.InvalidMaxSteps)(error))
				// NaN is not equal to itself, so use Object.is.
				assert.ok(Object.is(error.maxSteps, maxSteps))
			}
			assert.strictEqual(enters + calls, 0)
		}),
)
it.effect(
	"blocks the next request after tool versions complete and keeps their typed history",
	() =>
		Effect.gen(function* () {
			for (const maxSteps of [1, 3])
				for (const mode of ["advance", "stream"]) {
					const calls = yield* Ref.make(0)
					const released = yield* Ref.make(0)
					const observed = yield* Ref.make<
						ReadonlyArray<Bot.Event<typeof tools.tools>>
					>([])
					const chat = ChatTest(
						PluginComposition.merge(TurnLimiter.make({ maxSteps }), toolPlugin),
					)
					const task =
						mode === "advance"
							? chat.execute({ input: "echo" })
							: chat.stream({ input: "echo" }).pipe(
									Stream.tap((e) => Ref.update(observed, Arr.append(e))),
									Stream.runDrain,
								)
					const error = yield* task.pipe(
						Effect.flip,
						Effect.provide(
							Layer.merge(
								LanguageModelTest(() =>
									Stream.unwrap(
										Effect.map(
											Ref.updateAndGet(calls, (n) => n + 1),
											(n) =>
												Stream.make(call(n), finish("tool-calls")).pipe(
													Stream.ensuring(Ref.update(released, (n) => n + 1)),
												),
										),
									),
								),
								handlers,
							),
						),
					)
					assert.ok(Schema.is(TurnLimiter.ModelStepLimitExceeded)(error))
					assert.strictEqual(error.maxSteps, maxSteps)
					assert.strictEqual(yield* Ref.get(calls), maxSteps)
					assert.strictEqual(yield* Ref.get(released), maxSteps)
					assert.deepStrictEqual(
						Arr.map(error.history.content, (m) => m.role),
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
						const seen = yield* Ref.get(observed)
						assert.deepStrictEqual(
							pipe(
								seen,
								Arr.filter((e) => e._tag === "ModelStepStarted"),
								Arr.map((e) => e.step),
							),
							Array.from({ length: maxSteps }, (_, i) => i + 1),
						)
						assert.strictEqual(seen.at(-1)?._tag, "ChatUpdated")
						assert.strictEqual(
							Arr.filter(seen, (e) => e._tag === "ChatUpdated").length,
							maxSteps + 1,
						)
						for (const e of seen)
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
		}),
)
it.effect(
	"a normal finish at the exact limit succeeds through execute and stream",
	() =>
		Effect.gen(function* () {
			for (const maxSteps of [1, 2]) {
				const chat = ChatTest(
					PluginComposition.merge(TurnLimiter.make({ maxSteps }), toolPlugin),
				)
				const model = LanguageModelTest(({ prompt }) =>
					maxSteps === 1 || Arr.some(prompt.content, (m) => m.role === "tool")
						? answer()
						: Stream.make(call(1), finish("tool-calls")),
				)
				const layer = Layer.merge(model, handlers)
				const view = yield* chat
					.execute({ input: "echo" })
					.pipe(Effect.provide(layer))
				assert.strictEqual(Chat.currentTurn(view.chat)!.steps, maxSteps)
				assert.strictEqual(Chat.status(view.chat)._tag, "Completed")
				const events = yield* chat
					.stream({ input: "echo" })
					.pipe(Stream.runCollect, Effect.provide(layer))
				const final = events.at(-1)
				assert.ok(final?._tag === "TurnCompleted")
				assert.strictEqual(Chat.status(final.view.chat)._tag, "Completed")
			}
		}),
)
it.effect("an incomplete finish keeps its core state at the limit", () =>
	Effect.gen(function* () {
		const chat = ChatTest(
			PluginComposition.merge(TurnLimiter.make({ maxSteps: 1 }), toolPlugin),
		)
		const view = yield* chat.execute({ input: "echo" }).pipe(
			Effect.provide(
				Layer.merge(
					LanguageModelTest(() => Stream.make(call(1), finish("length"))),
					handlers,
				),
			),
		)
		assert.strictEqual(Chat.currentTurn(view.chat)!.steps, 1)
		assert.strictEqual(Chat.status(view.chat)._tag, "Completed")
	}),
)
it.effect(
	"a pending approval does not wait, so the next step meets the limit",
	() =>
		Effect.gen(function* () {
			const selected = Toolkit.make(Echo.setNeedsApproval(true))
			const plugin = Plugin.make({ id: Plugin.Id.make("selected") })(() =>
				Effect.map(
					Effect.context<Tool.HandlersFor<typeof selected.tools>>(),
					(handlers) => ({ tools: selected.tools, handlers }),
				),
			)
			const chat = ChatTest(
				PluginComposition.merge(TurnLimiter.make({ maxSteps: 1 }), plugin),
			)
			const error = yield* chat.execute({ input: "echo" }).pipe(
				Effect.flip,
				Effect.provide(
					Layer.merge(
						LanguageModelTest(() => Stream.make(call(1), finish("tool-calls"))),
						selected.toLayer({ Echo: () => Effect.succeed("done") }),
					),
				),
			)
			assert.ok(Schema.is(TurnLimiter.ModelStepLimitExceeded)(error))
			// The pending result of the call is in the history, so no call is left open.
			assert.ok(
				Arr.some(
					error.history.content,
					(message) =>
						message.role === "tool" &&
						Arr.some(message.content, (part) => part.type === "tool-result"),
				),
			)
		}),
)
it.effect(
	"repeated and concurrent executions keep limiter history separate",
	() =>
		Effect.gen(function* () {
			const chat = ChatTest(
				PluginComposition.merge(TurnLimiter.make({ maxSteps: 1 }), toolPlugin),
			)
			const model = LanguageModelTest(() =>
				Stream.make(call(1), finish("tool-calls")),
			)
			const outcomes = yield* Effect.forEach(
				["first", "second"],
				(input) => chat.execute({ input }).pipe(Effect.flip),
				{ concurrency: "unbounded" },
			).pipe(Effect.provide(Layer.merge(model, handlers)))
			for (const [index, error] of outcomes.entries()) {
				assert.ok(Schema.is(TurnLimiter.ModelStepLimitExceeded)(error))
				const text = yield* encodeJson(error.history)
				assert.match(text, new RegExp(index === 0 ? "first" : "second"))
				assert.notMatch(text, new RegExp(index === 0 ? "second" : "first"))
			}
		}),
)
it.effect(
	"interruption releases plugin resources and keeps native cancellation",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>()
			const order = yield* Ref.make<ReadonlyArray<string>>([])
			const track = (name: string) =>
				Plugin.make({ id: Plugin.Id.make(name) })(() =>
					Effect.acquireRelease(
						Ref.update(order, Arr.append(name + ":enter")),
						() => Ref.update(order, Arr.append(name + ":exit")),
					).pipe(Effect.as({ tools: {}, handlers: Context.empty() })),
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
			const exit = yield* Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					Stream.runDrain(chat.stream({ input: "wait" })),
				)
				yield* Deferred.await(started)
				yield* Fiber.interrupt(fiber)
				return yield* Fiber.await(fiber)
			}).pipe(
				Effect.provide(
					LanguageModelTest(() =>
						Stream.fromEffect(
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Effect.never),
							),
						),
					),
				),
			)
			assert.ok(Exit.isFailure(exit))
			assert.ok(Cause.hasInterruptsOnly(exit.cause))
			assert.deepStrictEqual(yield* Ref.get(order), [
				"outer:enter",
				"inner:enter",
				"inner:exit",
				"outer:exit",
			])
		}),
)
