import { assert, it } from "@effect/vitest"
import { Chat, ChatRuntime, ChatStoreRepository } from "@openbot-build/core"
import {
	Array as Arr,
	Deferred,
	Effect,
	Fiber,
	Option,
	Schema,
	Stream,
} from "effect"
import { Prompt } from "effect/ai"
import { ChatTest, settled } from "./ChatTest.ts"
import { LanguageModelTest, textParts } from "./LanguageModelTest.ts"

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

it.effect(
	"passive input survives a new runtime and only runs with its author's next message",
	() => {
		let prompts: ReadonlyArray<Prompt.Prompt> = []
		return Effect.gen(function* () {
			const { runtime, runtimeStore, chat, definition, persistence } =
				yield* ChatTest()
			const image = yield* runtime.deliver({
				chat,
				input: "Alice image",
				author: "alice",
				passive: true,
			})
			assert.strictEqual(image.delivery, "queued")
			assert.isTrue(Option.isNone(yield* runtime.drain(chat)))
			assert.strictEqual((yield* runtimeStore.items(chat)).length, 0)
			assert.strictEqual(
				(yield* runtime.context({ chat })).prompt.content.length,
				0,
			)
			assert.strictEqual(prompts.length, 0)
			const store = yield* ChatStoreRepository.make({ definition, persistence })
			const fresh = yield* ChatRuntime.make({ store, bot: {} })
			const other = yield* fresh.deliver({
				chat,
				input: "Bob message",
				author: "bob",
			})
			assert.strictEqual(other.delivery, "started")
			const bob = yield* settledWithoutPassive(fresh, chat)
			assert.strictEqual(bob.chat.inbox.length, 1)
			assert.notMatch(yield* json(prompts[0]), /Alice image/)
			const next = yield* fresh.deliver({
				chat,
				input: "Look at my image",
				author: "alice",
			})
			assert.strictEqual(next.delivery, "started")
			const done = yield* settled(fresh, chat)
			assert.strictEqual(done.chat.inbox.length, 0)
			assert.match(yield* json(prompts[1]), /Alice image.*Look at my image/)
			assert.strictEqual(
				Arr.filter(
					Chat.currentTurn(done.chat)!.input,
					(id) => id === image.item,
				).length,
				1,
			)
			assert.strictEqual(prompts.length, 2)
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: ({ prompt }) => {
						prompts = Arr.append(prompts, prompt)
						return Stream.fromArray(textParts("done"))
					},
				}),
			),
		)
	},
)

/** Passive context may wait after the current work ends. */
const settledWithoutPassive = <P>(runtime: Chat.Runtime<P>, chat: Chat.Id) =>
	Effect.gen(function* () {
		let view = yield* runtime.status(chat)
		while (
			(yield* runtime.isActive(chat)) ||
			Chat.status(view.chat)._tag === "Running"
		) {
			view = yield* runtime.wait({
				chat,
				after: view.chat.revision,
				afterActive: true,
				timeout: "1 second",
			})
		}
		return view
	})

it.effect(
	"passive input does not steer a running Turn or start after it ends",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const resume = yield* Deferred.make<void>()
			const model = LanguageModelTest({
				streamText: () =>
					Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
						Stream.flatMap(() => Stream.fromEffect(Deferred.await(resume))),
						Stream.flatMap(() => Stream.fromArray(textParts("done"))),
					),
			})
			yield* Effect.gen(function* () {
				const { runtime, runtimeStore, chat } = yield* ChatTest()
				const running = yield* runtime
					.execute({ chat, input: "Start", author: "alice" })
					.pipe(Effect.forkChild)
				yield* Deferred.await(entered)
				const passive = yield* runtime.deliver({
					chat,
					input: "Later image",
					author: "alice",
					passive: true,
				})
				assert.strictEqual(passive.delivery, "queued")
				const active = yield* runtimeStore.read(chat)
				assert.strictEqual(active.chat.inbox[0]?.kind, "message")
				assert.strictEqual(active.chat.inbox[0]?.passive, true)
				yield* Deferred.succeed(resume, undefined)
				yield* Fiber.join(running)
				const done = yield* settledWithoutPassive(runtime, chat)
				assert.strictEqual(done.chat.inbox.length, 1)
				assert.strictEqual((yield* runtimeStore.turns(chat)).length, 1)
				assert.notMatch(
					yield* json(yield* runtimeStore.items(chat)),
					/Later image/,
				)
				assert.isTrue(Option.isNone(yield* runtime.drain(chat)))
			}).pipe(Effect.provide(model))
		}),
)
