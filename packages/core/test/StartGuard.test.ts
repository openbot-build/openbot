import { assert, it } from "@effect/vitest"
import {
	Chat,
	ChatRuntime,
	ChatStoreRepository,
	MemoryPersistence,
	Store,
} from "@openbot-build/core"
import { Effect, Option, Ref, Stream } from "effect"
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
