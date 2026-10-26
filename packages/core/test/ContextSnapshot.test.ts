import { assert, it } from "@effect/vitest"
import {
	Chat,
	ChatRuntime,
	ChatState,
	ContextWindow,
	Item,
	Model,
	Provider,
	type ChatStore,
} from "@openbot-build/core"
import { Array as Arr, Deferred, Effect, Fiber, Option, Stream } from "effect"
import { Prompt } from "effect/ai"
import { ChatTest } from "./ChatTest.ts"
import { LanguageModelTest, textParts } from "./LanguageModelTest.ts"

const native = {
	_tag: "Native" as const,
	provider: Provider.Id.make("first"),
	model: Model.Id.make("first"),
	items: [{ type: "compaction", encrypted_content: "private-to-first" }],
	prompt: Prompt.empty,
}

const history = Arr.makeBy(48, (index): Item.Entry => ({
	id: Item.Id.make("item-" + index),
	content: Prompt.make("message " + index),
}))

const seed = (store: ChatStore.Store, chat: Chat.Id) =>
	store.modifyEffect({
		chat,
		update: (view) =>
			Effect.succeed([
				undefined,
				Option.some({
					append: history,
					value: {
						...view.state,
						conversation: { context: native, closed: true },
					},
				}),
			] as const),
	})

it.effect(
	"a portable snapshot reads all native history without writing or running a model",
	() => {
		let calls = 0
		return Effect.gen(function* () {
			const { runtime, runtimeStore, chat } = yield* ChatTest()
			const { view } = yield* seed(runtimeStore, chat)
			const items = yield* runtimeStore.items(chat)
			const snapshot = yield* runtime.context({
				chat,
				expected: view.chat.revision,
			})
			assert.strictEqual(snapshot.chat, chat)
			assert.strictEqual(snapshot.revision, view.chat.revision)
			assert.strictEqual(snapshot.seq, 48)
			assert.deepStrictEqual(snapshot.prompt, ChatState.promptOf(items))
			assert.deepStrictEqual(yield* runtimeStore.read(chat), view)
			assert.deepStrictEqual(yield* runtimeStore.items(chat), items)
			assert.strictEqual((yield* runtimeStore.turns(chat)).length, 0)
			assert.strictEqual(calls, 0)
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => {
						calls++
						return Stream.fromArray(textParts("must not run"))
					},
				}),
			),
		)
	},
)

it.effect(
	"a prompt snapshot keeps files, tool pairs and a portable summary",
	() =>
		Effect.gen(function* () {
			const { runtime, runtimeStore, chat } = yield* ChatTest()
			const prompt = Prompt.make([
				{
					role: "user",
					content: [
						Prompt.makePart("text", {
							text: "Earlier context: the code is blue.",
						}),
						Prompt.makePart("file", {
							mediaType: "image/png",
							data: new URL("https://files.example/image"),
							fileName: "image.png",
						}),
					],
				},
				{
					role: "assistant",
					content: [
						Prompt.toolCallPart({
							id: "call",
							name: "Read",
							params: { path: "notes" },
							providerExecuted: false,
						}),
					],
				},
				{
					role: "tool",
					content: [
						Prompt.toolResultPart({
							id: "call",
							name: "Read",
							result: { text: "blue" },
							isFailure: false,
							providerExecuted: false,
						}),
					],
				},
			])
			const { view } = yield* runtimeStore.modifyEffect({
				chat,
				update: (current) =>
					Effect.succeed([
						undefined,
						Option.some({
							value: {
								...current.state,
								conversation: {
									context: ContextWindow.fromPrompt(prompt),
									closed: true,
								},
							},
						}),
					] as const),
			})
			const snapshot = yield* runtime.context({ chat })
			assert.deepStrictEqual(snapshot.prompt, prompt)
			assert.strictEqual(snapshot.seq, 0)
			assert.deepStrictEqual(yield* runtimeStore.read(chat), view)
		}),
)

it.effect("a snapshot refuses a stale expected revision", () =>
	Effect.gen(function* () {
		const { runtime, runtimeStore, chat } = yield* ChatTest()
		const before = yield* runtimeStore.read(chat)
		yield* seed(runtimeStore, chat)
		const error = yield* runtime
			.context({ chat, expected: before.chat.revision })
			.pipe(Effect.flip)
		assert.strictEqual(error._tag, "ChatConflict")
	}),
)

it.effect("a snapshot rejects a change made while its Item log is read", () =>
	Effect.gen(function* () {
		const { runtimeStore, chat } = yield* ChatTest()
		yield* seed(runtimeStore, chat)
		const reading = yield* Deferred.make<void>()
		const resume = yield* Deferred.make<void>()
		const runtime = yield* ChatRuntime.make({
			store: {
				...runtimeStore,
				items: (id, query) =>
					runtimeStore.items(id, query).pipe(
						Effect.tap(() => Deferred.succeed(reading, undefined)),
						Effect.tap(() => Deferred.await(resume)),
					),
			},
			bot: {},
		})
		const snapshot = yield* runtime
			.context({ chat })
			.pipe(Effect.flip, Effect.forkChild)
		yield* Deferred.await(reading)
		yield* runtimeStore.modifyEffect({
			chat,
			update: (view) =>
				Effect.succeed([
					undefined,
					Option.some({
						chat: { settings: { ...view.chat.settings, mode: "plan" } },
					}),
				] as const),
		})
		yield* Deferred.succeed(resume, undefined)
		const error = yield* Fiber.join(snapshot)
		assert.strictEqual(error._tag, "ChatConflict")
	}).pipe(
		Effect.provide(
			LanguageModelTest({
				streamText: () => Stream.fromArray(textParts("unused")),
			}),
		),
	),
)

it.effect("a snapshot refuses an incomplete native Item log", () =>
	Effect.gen(function* () {
		const { runtimeStore, chat } = yield* ChatTest()
		yield* seed(runtimeStore, chat)
		const runtime = yield* ChatRuntime.make({
			store: {
				...runtimeStore,
				items: (id, query) =>
					runtimeStore.items(id, query).pipe(Effect.map(Arr.drop(1))),
			},
			bot: {},
		})
		const error = yield* runtime.context({ chat }).pipe(Effect.flip)
		assert.strictEqual(error._tag, "ChatError")
	}).pipe(
		Effect.provide(
			LanguageModelTest({
				streamText: () => Stream.fromArray(textParts("unused")),
			}),
		),
	),
)
