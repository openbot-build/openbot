import { assert, it } from "@effect/vitest"
import {
	Chat,
	ChatRuntime,
	ChatStoreRepository,
	MemoryPersistence,
	Store,
} from "@openbot-build/core"
import { Deferred, Effect, Fiber, Option, Ref, Stream } from "effect"
import { LanguageModelTest, textParts } from "./LanguageModelTest.ts"
import { settled } from "./ChatTest.ts"

it.effect(
	"a runtime that may not start Turns keeps input in the inbox, and drains it once it may",
	() =>
		Effect.gen(function* () {
			const definition = yield* Store.define({
				stores: {},
				schemaVersion: "start-guard/1",
			})
			const store = yield* ChatStoreRepository.make({
				definition,
				persistence: yield* MemoryPersistence.make,
			})
			const allowed = yield* Ref.make(false)
			const runtime = yield* ChatRuntime.make({
				store,
				bot: {},
				canStart: () => Ref.get(allowed),
			})
			const chat = (yield* store.create({})).chat.id

			const delivery = yield* runtime.deliver({ chat, input: "Hello" })
			assert.strictEqual(delivery.delivery, "queued")
			const waiting = yield* runtime.status(chat)
			assert.strictEqual(Chat.currentTurn(waiting.chat), undefined)
			assert.strictEqual(waiting.chat.inbox.length, 1)
			assert.isTrue(Option.isNone(yield* runtime.drain(chat)))

			const refused = yield* runtime
				.execute({ chat, input: "Now" })
				.pipe(Effect.flip)
			assert.strictEqual(refused._tag, "ChatConflict")
			assert.strictEqual(
				refused.message,
				"Another process runs the Turns of this Chat",
			)

			yield* Ref.set(allowed, true)
			const drained = yield* runtime.drain(chat)
			assert.strictEqual(Option.getOrThrow(drained).delivery, "started")
			const done = yield* settled(runtime, chat)
			assert.strictEqual(Chat.status(done.chat)._tag, "Completed")
			assert.strictEqual(done.chat.inbox.length, 0)
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.fromArray(textParts("answer")),
				}),
			),
		),
)

it.effect(
	"a guard changed after the quick read still stops admission without losing queued input",
	() => {
		let calls = 0
		return Effect.gen(function* () {
			const definition = yield* Store.define({
				stores: {},
				schemaVersion: "start-guard/1",
			})
			const store = yield* ChatStoreRepository.make({
				definition,
				persistence: yield* MemoryPersistence.make,
			})
			const quickRead = yield* Deferred.make<void>()
			const resume = yield* Deferred.make<void>()
			const runtime = yield* ChatRuntime.make({
				store: {
					...store,
					read: (chat) =>
						store.read(chat).pipe(
							Effect.tap(() => Deferred.succeed(quickRead, undefined)),
							Effect.tap(() => Deferred.await(resume)),
						),
				},
				bot: {},
				canStart: (view) => Effect.succeed(view.chat.settings.mode === "build"),
			})
			const chat = (yield* store.create({})).chat.id
			const delivery = yield* runtime
				.deliver({ chat, input: "Keep this input" })
				.pipe(Effect.forkChild)
			yield* Deferred.await(quickRead)
			yield* store.modifyEffect({
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
			assert.strictEqual((yield* Fiber.join(delivery)).delivery, "queued")
			const waiting = yield* store.read(chat)
			assert.strictEqual(waiting.chat.inbox.length, 1)
			assert.strictEqual(waiting.chat.turn, undefined)
			assert.strictEqual(calls, 0)
			yield* store.modifyEffect({
				chat,
				update: (view) =>
					Effect.succeed([
						undefined,
						Option.some({
							chat: { settings: { ...view.chat.settings, mode: "build" } },
						}),
					] as const),
			})
			assert.isTrue(Option.isSome(yield* runtime.drain(chat)))
			const done = yield* settled(runtime, chat)
			assert.strictEqual(done.chat.inbox.length, 0)
			assert.strictEqual(calls, 1)
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => {
						calls++
						return Stream.fromArray(textParts("answer"))
					},
				}),
			),
		)
	},
)
