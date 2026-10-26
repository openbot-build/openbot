import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	Schema,
	Scope,
	Stream,
	String as Str,
} from "effect"
import { type Prompt, Response, Tool, Toolkit } from "effect/ai"
import {
	Chat,
	ChatRuntime,
	ChatStoreRepository,
	Config,
	ContextWindow,
	MemoryPersistence,
	Model,
	Provider,
	Store,
} from "@openbot-build/core"
import { ChatTest, settled } from "./ChatTest.ts"
import {
	finish,
	LanguageModelTest,
	lastText,
	textParts,
} from "./LanguageModelTest.ts"

/** The JSON text of a value, so a test can match a pattern in it. */
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/**
 * A model that holds its first request until `gate` opens, and then gives `first`.
 * Later requests answer at once. It keeps every prompt in `prompts`.
 */
const heldModel = (input: {
	readonly ready: Deferred.Deferred<void>
	readonly gate: Deferred.Deferred<void>
	readonly prompts: { value: ReadonlyArray<Prompt.Prompt> }
	readonly first: ReturnType<typeof textParts>
}) =>
	LanguageModelTest({
		streamText: ({ prompt }) => {
			input.prompts.value = Arr.append(input.prompts.value, prompt)
			return input.prompts.value.length === 1
				? Stream.fromEffect(
						Deferred.succeed(input.ready, undefined).pipe(
							Effect.andThen(Deferred.await(input.gate)),
						),
					).pipe(Stream.flatMap(() => Stream.fromIterable(input.first)))
				: Stream.fromArray(textParts("done"))
		},
	})

it.effect(
	"a Turn that starts while the runtime closes ends, and input after the close waits in the inbox",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>(),
				gate = yield* Deferred.make<void>()
			const definition = yield* Store.define({
				stores: {},
				schemaVersion: "closing/1",
			})
			// The store lives longer than the runtime, as a database does.
			const store = yield* ChatStoreRepository.make({
				definition,
				persistence: yield* MemoryPersistence.make,
			})
			const chat = (yield* store.create({})).chat.id
			const scope = yield* Scope.make()
			const runtime = yield* ChatRuntime.make({
				store,
				bot: {},
				// The first start waits here, so the runtime closes while it is in progress.
				canStart: () =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(gate)),
						Effect.as(true),
					),
			}).pipe(Scope.provide(scope))
			const delivering = yield* Effect.forkChild(
				runtime.deliver({ chat, input: "first" }),
			)
			yield* Deferred.await(entered)
			const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
			yield* Deferred.succeed(gate, undefined)
			yield* Fiber.join(closing)
			const first = yield* Fiber.join(delivering)
			assert.strictEqual(first.delivery, "started")
			const closed = yield* store.read(chat)
			assert.strictEqual(Chat.currentTurn(closed.chat)?.id, first.turn)
			assert.strictEqual(Chat.status(closed.chat)._tag, "Interrupted")
			const late = yield* runtime.deliver({ chat, input: "after the close" })
			assert.strictEqual(late.delivery, "queued")
			const after = yield* store.read(chat)
			assert.strictEqual(Chat.currentTurn(after.chat)?.id, first.turn)
			assert.deepStrictEqual(
				Arr.map(after.chat.inbox, (entry) => [entry.id, entry.kind]),
				[[late.item, "message"]],
			)
		}).pipe(
			Effect.provide(LanguageModelTest({ streamText: () => Stream.never })),
		),
)

it.effect(
	"input of the same author during a host action gets its answer from a model Turn after the action",
	() => {
		let prompts: ReadonlyArray<Prompt.Prompt> = []
		const wait = Tool.make("Wait", {
			parameters: Schema.Struct({}),
			success: Schema.String,
		})
		const toolkit = Toolkit.make(wait)
		return Effect.gen(function* () {
			const entered = yield* Deferred.make<void>(),
				release = yield* Deferred.make<void>()
			const { runtime, runtimeStore, chat } = yield* ChatTest({ toolkit })
			const handlers = yield* toolkit.toHandlers({
				Wait: () =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
						Effect.as("waited"),
					),
			})
			const action = yield* runtime
				.startAction({ chat, action: { name: "Wait", arguments: {} } })
				.pipe(Effect.provideContext(handlers))
			yield* Deferred.await(entered)
			const steered = yield* runtime
				.deliver({ chat, input: "a question during the action" })
				.pipe(Effect.provideContext(handlers))
			assert.strictEqual(steered.delivery, "steered")
			yield* Deferred.succeed(release, undefined)
			const done = yield* settled(runtime, chat)
			const turns = yield* runtimeStore.turns(chat)
			assert.deepStrictEqual(
				Arr.map(turns, (turn) => turn.status._tag),
				["Completed", "Completed"],
			)
			assert.strictEqual(turns[0]!.id, action.turn)
			assert.strictEqual(turns[0]!.items.includes(steered.item), false)
			assert.strictEqual(turns[1]!.action, undefined)
			assert.deepStrictEqual(turns[1]!.input, [steered.item])
			assert.strictEqual(prompts.length, 1)
			assert.strictEqual(lastText(prompts[0]!), "a question during the action")
			assert.deepStrictEqual(done.chat.inbox, [])
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: ({ prompt }) => {
						prompts = Arr.append(prompts, prompt)
						return Stream.fromArray(textParts("answer"))
					},
				}),
			),
		)
	},
)

it.effect(
	"a steer that waits when a model step ends with length starts the next Turn",
	() => {
		const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		return Effect.gen(function* () {
			const ready = yield* Deferred.make<void>(),
				gate = yield* Deferred.make<void>()
			yield* Effect.gen(function* () {
				const { runtime, runtimeStore, chat } = yield* ChatTest()
				const started = yield* runtime.deliver({ chat, input: "first" })
				yield* Deferred.await(ready)
				const steered = yield* runtime.deliver({ chat, input: "more" })
				assert.strictEqual(steered.delivery, "steered")
				yield* Deferred.succeed(gate, undefined)
				const done = yield* settled(runtime, chat)
				const turns = yield* runtimeStore.turns(chat)
				assert.deepStrictEqual(
					Arr.map(turns, (turn) => turn.status._tag),
					["Completed", "Completed"],
				)
				assert.strictEqual(turns[0]!.id, started.turn)
				const cut = turns[0]!.status
				assert.ok(cut._tag === "Completed")
				assert.strictEqual(cut.result.finishReason, "length")
				assert.deepStrictEqual(turns[1]!.input, [steered.item])
				assert.deepStrictEqual(done.chat.inbox, [])
				assert.strictEqual(lastText(prompts.value.at(-1)!), "more")
			}).pipe(
				Effect.provide(
					heldModel({
						ready,
						gate,
						prompts,
						first: [
							Response.makePart("text-start", { id: "answer" }),
							Response.makePart("text-delta", { id: "answer", delta: "cut" }),
							Response.makePart("text-end", { id: "answer" }),
							finish("length"),
						],
					}),
				),
			)
		})
	},
)

it.effect(
	"an interrupt from another runtime stays when the first runtime ends its model step later",
	() => {
		const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		return Effect.gen(function* () {
			const ready = yield* Deferred.make<void>(),
				gate = yield* Deferred.make<void>()
			yield* Effect.gen(function* () {
				const { runtime, runtimeStore, chat } = yield* ChatTest()
				const started = yield* runtime.deliver({ chat, input: "work" })
				yield* Deferred.await(ready)
				// The second runtime is like another server over the same store.
				const other = yield* ChatRuntime.make({ store: runtimeStore, bot: {} })
				const stopped = yield* other.interrupt({ chat, turn: started.turn! })
				assert.strictEqual(Chat.status(stopped.chat)._tag, "Interrupted")
				yield* Deferred.succeed(gate, undefined)
				const done = yield* settled(runtime, chat)
				assert.strictEqual(Chat.currentTurn(done.chat)!.id, started.turn)
				assert.strictEqual(Chat.status(done.chat)._tag, "Interrupted")
				assert.notMatch(
					yield* json(yield* runtimeStore.items(chat)),
					/late answer/,
				)
				assert.strictEqual(prompts.value.length, 1)
			}).pipe(
				Effect.provide(
					heldModel({ ready, gate, prompts, first: textParts("late answer") }),
				),
			)
		})
	},
)

it.effect(
	"a steer during automatic compaction does not stop the Turn, and the compacted window is saved",
	() => {
		let prompts: ReadonlyArray<Prompt.Prompt> = []
		const selection = Config.Selection.make({
			provider: Provider.Id.make("execution"),
			model: Model.Id.make("execution-model"),
		})
		const summarySelection = Config.Selection.make({
			provider: Provider.Id.make("summaries"),
			model: Model.Id.make("summary-model"),
		})
		return Effect.gen(function* () {
			const entered = yield* Deferred.make<void>(),
				gate = yield* Deferred.make<void>()
			const summaries = new Provider.Provider({
				id: summarySelection.provider,
				model: (selected) =>
					Effect.succeed(
						Model.make({
							provider: selected.provider,
							model: selected.model,
							layer: LanguageModelTest({
								streamText: () => Stream.die("summary must use generateText"),
								// The summary waits, so a steer comes during the compaction.
								generateText: () =>
									Deferred.succeed(entered, undefined).pipe(
										Effect.andThen(Deferred.await(gate)),
										Effect.as([
											Response.makePart("text", { text: "preserved summary" }),
											finish(),
										]),
									),
							}),
						}),
					),
			})
			const { runtime, runtimeStore, chat } = yield* ChatTest({
				modelCatalog: Effect.succeed([
					Config.Model.make({
						provider: selection.provider,
						id: selection.model,
						name: "Execution",
						reasoningEfforts: [],
						serviceTiers: [],
						contextWindow: 100,
						compaction: Config.Compaction.NonNative({
							model: summarySelection,
							keepRecentMessages: 1,
						}),
					}),
				]),
				providers: [summaries],
				compaction: {
					// A window with the summary is small, and every other window is near the limit.
					count: (request) =>
						json(request.window.prompt).pipe(
							Effect.orDie,
							Effect.map((text) =>
								Str.includes("preserved summary")(text) ? 20 : 90,
							),
						),
					compact: () =>
						Effect.die("NonNative must not call the native service"),
				},
			})
			yield* runtimeStore.modifyEffect({
				chat,
				update: (current) =>
					Effect.succeed([
						undefined,
						Option.some({
							value: {
								...current.state,
								conversation: {
									...current.state.conversation,
									context: ContextWindow.fromPrompt("old goal and decisions"),
								},
							},
							chat: {
								settings: { ...current.chat.settings, model: selection },
							},
						}),
					] as const),
			})
			const started = yield* runtime.deliver({ chat, input: "go on" })
			yield* Deferred.await(entered)
			const steered = yield* runtime.deliver({
				chat,
				input: "and one more thing",
			})
			assert.strictEqual(steered.delivery, "steered")
			yield* Deferred.succeed(gate, undefined)
			const done = yield* settled(runtime, chat)
			const turn = Chat.currentTurn(done.chat)!
			assert.strictEqual(turn.id, started.turn)
			assert.strictEqual(turn.status._tag, "Completed")
			assert.strictEqual(turn.steps, 2)
			assert.ok(turn.items.includes(steered.item))
			assert.match(
				yield* json(done.state.conversation.context.prompt),
				/preserved summary/,
			)
			assert.strictEqual(prompts.length, 2)
			assert.strictEqual(lastText(prompts[1]!), "and one more thing")
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: ({ prompt }) => {
						prompts = Arr.append(prompts, prompt)
						return Stream.fromArray(textParts("answer"))
					},
				}),
			),
		)
	},
)
