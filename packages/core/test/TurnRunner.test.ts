import { assert, it } from "@effect/vitest"
import { TestClock } from "effect/testing"
import {
	Array as Arr,
	Context,
	Deferred,
	Duration,
	Fiber,
	Effect,
	Layer,
	Option,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { Prompt, Response, Tool, Toolkit } from "effect/ai"
import {
	Chat,
	ChatState,
	ChatStoreRepository,
	Item,
	MemoryPersistence,
	Plugin,
	PluginComposition,
	Store,
	Turn,
	TurnRunner,
	TurnState,
} from "@openbot-build/core"
import { LanguageModelTest, finish, textParts } from "./LanguageModelTest.ts"

const Lookup = Tool.make("Lookup", {
	parameters: Schema.Struct({}),
	success: Schema.String,
})
const tools = Toolkit.make(Lookup)

it.effect("a stopped Turn runner resumes after the last committed step", () =>
	Effect.gen(function* () {
		const persistence = yield* MemoryPersistence.make
		const definition = yield* Store.define({
			stores: {},
			schemaVersion: "chat/1",
		})
		const store = yield* ChatStoreRepository.make({ definition, persistence })
		const initial = yield* store.create({})
		const turn = Turn.Id.make("turn-1")
		const entry: Chat.InboxEntry = {
			id: Item.Id.make("input-1"),
			kind: "message",
			content: Prompt.make("Find the note"),
		}
		const input = {
			turn,
			selected: [entry] as const,
			items: [
				{
					id: entry.id,
					content: entry.content,
					origin: { chat: initial.chat.id, turn, step: 0 },
				},
			],
			startedAt: 0,
		}
		const admitted = yield* store.modifyEffect({
			chat: initial.chat.id,
			update: (view) =>
				TurnState.start(view, input).pipe(
					Effect.map((mutation) => [undefined, Option.some(mutation)] as const),
				),
		})
		const accepted = {
			view: admitted.view,
			turn,
			item: entry.id,
			prompt: entry.content,
		}
		const entered = yield* Deferred.make<void>()
		const toolCalls = yield* Ref.make(0)
		const handlers = tools.toLayer({
			Lookup: () =>
				Ref.update(toolCalls, (n) => n + 1).pipe(Effect.as("The saved note")),
		})
		const calls = yield* Ref.make(0)
		const firstModel = LanguageModelTest({
			streamText: () =>
				Stream.unwrap(
					Effect.gen(function* (): Effect.fn.Return<
						Stream.Stream<Response.StreamPartEncoded>
					> {
						const n = yield* Ref.updateAndGet(calls, (n) => n + 1)
						return n === 1
							? Stream.make(
									Response.makePart("tool-call", {
										id: "lookup-1",
										name: "Lookup",
										params: {},
										providerExecuted: false,
									}),
									finish("tool-calls"),
								)
							: Stream.concat(
									Stream.fromArray(
										Arr.filter(
											textParts("unfinished"),
											(part) => part.type !== "finish",
										),
									),
									Stream.fromEffectDrain(
										Deferred.succeed(entered, undefined).pipe(
											Effect.andThen(Effect.never),
										),
									),
								)
					}),
				),
		})
		// The first owner loses its whole scope in the middle of the second model call.
		yield* Effect.scoped(
			Effect.gen(function* () {
				const runner = yield* TurnRunner.make({
					store,
					bot: { toolkit: tools },
				})
				yield* Effect.forkScoped(runner.run(accepted).pipe(Stream.runDrain))
				yield* Deferred.await(entered)
			}).pipe(Effect.provide(Layer.merge(firstModel, handlers))),
		)
		const checkpoint = yield* store.read(initial.chat.id)
		assert.strictEqual(checkpoint.chat.turn?.status._tag, "Running")
		assert.strictEqual(checkpoint.chat.turn?.steps, 1)
		assert.strictEqual(yield* Ref.get(toolCalls), 1)
		const secondStore = yield* ChatStoreRepository.make({
			definition,
			persistence,
		})
		const secondModel = LanguageModelTest({
			streamText: ({ prompt }) => {
				const text = Arr.flatMap(prompt.content, (message) =>
					message.role === "assistant"
						? Arr.filter(message.content, (part) => part.type === "text")
						: [],
				)
				assert.isFalse(
					Arr.some(text, (part) => Str.includes("unfinished")(part.text)),
				)
				return Stream.fromArray(textParts("The note was found"))
			},
		})
		yield* Effect.scoped(
			Effect.gen(function* () {
				const runner = yield* TurnRunner.make({
					store: secondStore,
					bot: { toolkit: tools },
				})
				yield* runner
					.run({ ...accepted, view: yield* secondStore.read(initial.chat.id) })
					.pipe(Stream.runDrain)
			}).pipe(Effect.provide(Layer.merge(secondModel, handlers))),
		)
		const completed = yield* secondStore.read(initial.chat.id)
		assert.strictEqual(completed.chat.turn?.status._tag, "Completed")
		assert.strictEqual(completed.chat.turn?.steps, 2)
		assert.strictEqual(yield* Ref.get(toolCalls), 1)
		const history = ChatState.promptOf(
			yield* secondStore.items(initial.chat.id),
		)
		assert.deepStrictEqual(
			Arr.map(history.content, (message) => message.role),
			["user", "assistant", "tool", "assistant"],
		)
	}),
)

for (const input of [
	{
		name: "no finish",
		parts: Arr.filter(textParts("partial"), (part) => part.type !== "finish"),
		error: "ModelStepIncomplete",
	},
	{
		name: "an error part",
		parts: [
			Response.makePart("error", { error: { code: "provider_failed" } }),
			finish(),
		],
		error: "ModelStepFailed",
	},
	{
		name: "an error finish",
		parts: [finish("error")],
		error: "ModelStepFailed",
	},
]) {
	it.effect(
		`a response with ${input.name} cannot become a Turn checkpoint`,
		() =>
			Effect.gen(function* () {
				const toolCalls = yield* Ref.make(0)
				const definition = yield* Store.define({
					stores: {},
					schemaVersion: "chat/1",
				})
				const store = yield* ChatStoreRepository.make({
					definition,
					persistence: yield* MemoryPersistence.make,
				})
				const initial = yield* store.create({})
				const turn = Turn.Id.make("turn-1")
				const entry: Chat.InboxEntry = {
					id: Item.Id.make("input-1"),
					kind: "message",
					content: Prompt.make("Read the note"),
				}
				const admitted = yield* store.modifyEffect({
					chat: initial.chat.id,
					update: (view) =>
						TurnState.start(view, {
							turn,
							selected: [entry],
							items: [{ id: entry.id, content: entry.content }],
							startedAt: 0,
						}).pipe(
							Effect.map(
								(mutation) => [undefined, Option.some(mutation)] as const,
							),
						),
				})
				const runner = yield* TurnRunner.make({
					store,
					bot: { toolkit: tools },
				}).pipe(
					Effect.provide(
						tools.toLayer({
							Lookup: () =>
								Ref.update(toolCalls, (n) => n + 1).pipe(
									Effect.as("must not run"),
								),
						}),
					),
				)
				const failure = yield* runner
					.run({
						view: admitted.view,
						turn,
						item: entry.id,
						prompt: entry.content,
					})
					.pipe(Stream.runDrain, Effect.flip)
				assert.strictEqual(failure._tag, input.error)
				const checkpoint = yield* store.read(initial.chat.id)
				assert.strictEqual(checkpoint.chat.turn?.status._tag, "Running")
				assert.strictEqual(checkpoint.chat.turn?.steps, 0)
				assert.strictEqual((yield* store.items(initial.chat.id)).length, 1)
				assert.strictEqual(yield* Ref.get(toolCalls), 0)
			}).pipe(
				Effect.provide(
					LanguageModelTest({
						streamText: () =>
							Stream.fromArray<Response.StreamPartEncoded>([
								Response.makePart("tool-call", {
									id: "unsafe",
									name: "Lookup",
									params: {},
									providerExecuted: false,
								}),
								...input.parts,
							]),
					}),
				),
			),
	)
}

const Save = Tool.make("Save", {
	parameters: Schema.Struct({ name: Schema.String }),
	success: Schema.String,
})
const saveTools = Toolkit.make(Save)
it.effect(
	"a new runner uses the saved model and skips tools with saved results",
	() =>
		Effect.gen(function* () {
			const persistence = yield* MemoryPersistence.make
			const definition = yield* Store.define({
				stores: {},
				schemaVersion: "chat/1",
			})
			const store = yield* ChatStoreRepository.make({ definition, persistence })
			const initial = yield* store.create({})
			const turn = Turn.Id.make("resume-tools")
			const entry: Chat.InboxEntry = {
				id: Item.Id.make("input"),
				kind: "message",
				content: Prompt.make("Save both notes"),
			}
			const admitted = yield* store.modifyEffect({
				chat: initial.chat.id,
				update: (view) =>
					TurnState.start(view, {
						turn,
						selected: [entry],
						items: [entry],
						startedAt: 0,
					}).pipe(
						Effect.map(
							(mutation) => [undefined, Option.some(mutation)] as const,
						),
					),
			})
			const accepted = {
				view: admitted.view,
				turn,
				item: entry.id,
				prompt: entry.content,
			}
			const entered = yield* Deferred.make<void>()
			const calls = yield* Ref.make<ReadonlyArray<string>>([])
			const models = yield* Ref.make(0)
			const model = LanguageModelTest({
				streamText: () =>
					Stream.unwrap(
						Effect.gen(function* () {
							const n = yield* Ref.updateAndGet(models, (n) => n + 1)
							return n === 1
								? Stream.fromArray<Response.StreamPartEncoded>([
										...Arr.map(["first", "second"], (name) =>
											Response.makePart("tool-call", {
												id: name,
												name: "Save",
												params: { name },
												providerExecuted: false,
											}),
										),
										finish("tool-calls"),
									])
								: Stream.fromArray(textParts("Both notes are saved"))
						}),
					),
			})
			const handlers = saveTools.toLayer({
				Save: ({ name }) =>
					Effect.gen(function* () {
						const view = yield* store.read(initial.chat.id).pipe(Effect.orDie)
						assert.ok(
							view.chat.turn?.pendingStep?.model,
							"The model commits before a tool runs",
						)
						const previous = yield* Ref.getAndUpdate(calls, (calls) =>
							Arr.append(calls, name),
						)
						if (name === "second" && !Arr.contains(previous, name)) {
							yield* Deferred.succeed(entered, undefined)
							return yield* Effect.never
						}
						return "saved:" + name
					}),
			})
			yield* Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* TurnRunner.make({
						store,
						bot: { toolkit: saveTools, concurrency: 1 },
					})
					yield* Effect.forkScoped(runner.run(accepted).pipe(Stream.runDrain))
					yield* Deferred.await(entered)
				}).pipe(Effect.provide(Layer.merge(model, handlers))),
			)
			const checkpoint = yield* store.read(initial.chat.id)
			assert.strictEqual(checkpoint.chat.turn?.steps, 0)
			assert.deepStrictEqual(yield* Ref.get(calls), ["first", "second"])
			assert.strictEqual(yield* Ref.get(models), 1)
			const secondStore = yield* ChatStoreRepository.make({
				definition,
				persistence,
			})
			yield* Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* TurnRunner.make({
						store: secondStore,
						bot: { toolkit: saveTools, concurrency: 1 },
					})
					yield* runner
						.run({ ...accepted, view: checkpoint })
						.pipe(Stream.runDrain)
				}).pipe(Effect.provide(Layer.merge(model, handlers))),
			)
			assert.deepStrictEqual(yield* Ref.get(calls), [
				"first",
				"second",
				"second",
			])
			assert.strictEqual(yield* Ref.get(models), 2)
			const completed = yield* secondStore.read(initial.chat.id)
			assert.strictEqual(completed.chat.turn?.status._tag, "Completed")
			assert.isUndefined(completed.chat.turn?.pendingStep)
		}),
)

for (const source of ["plugin", "registration"] as const)
	it.effect(
		`result hooks from ${source} run in order again after a failed hook`,
		() =>
			Effect.gen(function* () {
				const persistence = yield* MemoryPersistence.make
				const definition = yield* Store.define({
					stores: {},
					schemaVersion: "chat/1",
				})
				const store = yield* ChatStoreRepository.make({
					definition,
					persistence,
				})
				const initial = yield* store.create({})
				const turn = Turn.Id.make("hook-turn")
				const entry: Chat.InboxEntry = {
					id: Item.Id.make("hook-input"),
					kind: "message",
					content: Prompt.make("Read the note"),
				}
				const admitted = yield* store.modifyEffect({
					chat: initial.chat.id,
					update: (view) =>
						TurnState.start(view, {
							turn,
							selected: [entry],
							startedAt: 0,
							items: [
								{
									id: entry.id,
									content: entry.content,
									origin: { chat: initial.chat.id, turn, step: 0 },
								},
							],
						}).pipe(
							Effect.map(
								(mutation) => [undefined, Option.some(mutation)] as const,
							),
						),
				})
				const accepted = {
					view: admitted.view,
					turn,
					item: entry.id,
					prompt: entry.content,
				}
				const seen = yield* Ref.make<ReadonlyArray<string>>([])
				const fail = yield* Ref.make(true)
				const models = yield* Ref.make(0)
				const hook = (name: string) => (result: Plugin.StepResult) =>
					Effect.gen(function* () {
						const saved = yield* store.read(result.chat)
						assert.ok(saved.chat.turn?.pendingStep?.model)
						assert.strictEqual(result.kind, "model")
						assert.strictEqual(result.finishReason, "stop")
						assert.deepStrictEqual(
							result.output,
							saved.chat.turn.pendingStep.model.output,
						)
						yield* Ref.update(seen, Arr.append(name))
						if (name === "second" && (yield* Ref.getAndSet(fail, false)))
							return yield* Effect.fail("hook-failed" as const)
					})
				const wrap = (name: string) =>
					Plugin.make({ id: Plugin.Id.make(name) })(() =>
						Effect.succeed({
							tools: {},
							handlers: Context.empty(),
							afterStep: hook(name),
						}),
					)
				const botDefinition =
					source === "plugin"
						? { plugin: PluginComposition.merge(wrap("first"), wrap("second")) }
						: {
								registerTools: Effect.succeed({
									tools: {},
									handlers: Context.empty(),
									afterStep: (result: Plugin.StepResult) =>
										Effect.andThen(hook("first")(result), () =>
											hook("second")(result),
										),
								}),
							}

				const model = LanguageModelTest({
					streamText: () =>
						Stream.fromEffect(Ref.update(models, (n) => n + 1)).pipe(
							Stream.flatMap(() =>
								Stream.fromArray(textParts("The note is saved")),
							),
						),
				})
				const run = (view: typeof admitted.view) =>
					Effect.scoped(
						Effect.gen(function* () {
							const runner = yield* TurnRunner.make({
								store,
								bot: botDefinition,
							})
							yield* runner.run({ ...accepted, view }).pipe(Stream.runDrain)
						}),
					).pipe(Effect.provide(model))
				assert.strictEqual(
					yield* run(admitted.view).pipe(Effect.flip),
					"hook-failed",
				)
				const saved = yield* store.read(initial.chat.id)
				assert.strictEqual(saved.chat.turn?.status._tag, "Running")
				yield* run(saved)
				assert.deepStrictEqual(yield* Ref.get(seen), [
					"first",
					"second",
					"first",
					"second",
				])
				assert.strictEqual(yield* Ref.get(models), 1)
				assert.strictEqual(
					(yield* store.read(initial.chat.id)).chat.turn?.status._tag,
					"Completed",
				)
			}),
	)

for (const elapsed of [40, 50]) {
	it.effect(
		`a resumed Turn keeps its time limit after ${elapsed} milliseconds`,
		() =>
			Effect.gen(function* () {
				const definition = yield* Store.define({
					stores: {},
					schemaVersion: "chat/1",
				})
				const store = yield* ChatStoreRepository.make({
					definition,
					persistence: yield* MemoryPersistence.make,
				})
				const initial = yield* store.create({})
				const turn = Turn.Id.make("timed-turn")
				const entry: Chat.InboxEntry = {
					id: Item.Id.make("timed-input"),
					kind: "message",
					content: Prompt.make("hello"),
				}
				const admitted = yield* store.modifyEffect({
					chat: initial.chat.id,
					update: (view) =>
						TurnState.start(view, {
							turn,
							selected: [entry],
							items: [{ id: entry.id, content: entry.content }],
							startedAt: 0,
						}).pipe(
							Effect.map(
								(mutation) => [undefined, Option.some(mutation)] as const,
							),
						),
				})
				const started = yield* Deferred.make<void>()
				const calls = yield* Ref.make(0)
				const released = yield* Ref.make(0)
				const limit = (milliseconds: number) =>
					Plugin.make({ id: Plugin.Id.make("limit-" + milliseconds) })(() =>
						Effect.succeed({
							tools: {},
							handlers: Context.empty(),
							timeLimit: {
								duration: Duration.millis(milliseconds),
								error: () => "time-limit" as const,
							},
						}),
					)
				yield* TestClock.adjust(elapsed)
				const run = Effect.scoped(
					Effect.gen(function* () {
						const runner = yield* TurnRunner.make({
							store,
							bot: { plugin: PluginComposition.merge(limit(100), limit(50)) },
						})
						return yield* runner
							.run({
								view: admitted.view,
								turn,
								item: entry.id,
								prompt: entry.content,
							})
							.pipe(Stream.runDrain, Effect.flip)
					}),
				).pipe(
					Effect.provide(
						LanguageModelTest({
							streamText: () =>
								Stream.fromEffectDrain(
									Ref.update(calls, (n) => n + 1).pipe(
										Effect.andThen(Deferred.succeed(started, undefined)),
										Effect.andThen(Effect.never),
									),
								).pipe(Stream.ensuring(Ref.update(released, (n) => n + 1))),
						}),
					),
				)
				const fiber = yield* run.pipe(Effect.forkChild)
				if (elapsed < 50) {
					yield* Deferred.await(started)
					yield* TestClock.adjust(50 - elapsed)
				}
				assert.equal(yield* Fiber.join(fiber), "time-limit")
				assert.equal(yield* Ref.get(calls), elapsed < 50 ? 1 : 0)
				assert.equal(yield* Ref.get(released), elapsed < 50 ? 1 : 0)
			}),
	)
}
