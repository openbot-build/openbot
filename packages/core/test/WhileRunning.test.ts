import { assert, it } from "@effect/vitest"
import {
	Chat,
	ChatRuntime,
	ChatStoreRepository,
	MemoryPersistence,
	Store,
} from "@openbot-build/core"
import { Deferred, Effect, Ref, Stream } from "effect"
import { LanguageModelTest, textParts } from "./LanguageModelTest.ts"
import { settled } from "./ChatTest.ts"

/**
 * A runtime whose host part counts how many Turns hold it. Each change of the
 * count goes into `counts`, and `idle` ends when the count falls to zero.
 */
const runtimeWithHold = Effect.gen(function* () {
	const definition = yield* Store.define({
		stores: {},
		schemaVersion: "while-running/1",
	})
	const store = yield* ChatStoreRepository.make({
		definition,
		persistence: yield* MemoryPersistence.make,
	})
	const counts = yield* Ref.make<ReadonlyArray<number>>([])
	const open = yield* Ref.make(0)
	const idle = yield* Deferred.make<void>()
	const change = (by: number) =>
		Ref.updateAndGet(open, (count) => count + by).pipe(
			Effect.tap((count) => Ref.update(counts, (all) => [...all, count])),
			Effect.tap((count) =>
				count === 0 ? Deferred.succeed(idle, undefined) : Effect.void,
			),
		)
	const runtime = yield* ChatRuntime.make({
		store,
		bot: {},
		whileRunning: () => Effect.acquireRelease(change(1), () => change(-1)),
	})
	const chat = (yield* store.create({})).chat.id
	return { runtime, chat, counts, open, idle }
})

/** A model that answers only when the gate opens. */
const gated = (gate: Deferred.Deferred<void>) =>
	LanguageModelTest({
		streamText: () =>
			Stream.fromEffect(Deferred.await(gate)).pipe(
				Stream.flatMap(() => Stream.fromArray(textParts("answer"))),
			),
	})

it.effect(
	"the host part holds from the start of a Turn until the next Turn from the inbox has started",
	() =>
		Effect.gen(function* () {
			const gate = yield* Deferred.make<void>()
			yield* Effect.gen(function* () {
				const { runtime, chat, counts, open, idle } = yield* runtimeWithHold
				const first = yield* runtime.deliver({ chat, input: "first" })
				assert.strictEqual(first.delivery, "started")
				assert.strictEqual(yield* Ref.get(open), 1)
				const second = yield* runtime.deliver({
					chat,
					input: "second",
					queue: true,
				})
				assert.strictEqual(second.delivery, "queued")
				yield* Deferred.succeed(gate, undefined)
				const done = yield* settled(runtime, chat)
				assert.strictEqual(Chat.status(done.chat)._tag, "Completed")
				// The watcher of the last Turn lets the hold go after it closed the Turn.
				yield* Deferred.await(idle)
				// The second Turn takes the hold before the first lets it go, so the
				// count never falls to zero between the two Turns.
				assert.deepStrictEqual(yield* Ref.get(counts), [1, 2, 1, 0])
			}).pipe(Effect.provide(gated(gate)))
		}),
)

it.effect("the host part ends when the runtime closes during a Turn", () =>
	Effect.gen(function* () {
		const gate = yield* Deferred.make<void>()
		const open = yield* Effect.scoped(
			Effect.gen(function* () {
				const { runtime, chat, open } = yield* runtimeWithHold
				yield* runtime.deliver({ chat, input: "never answered" })
				assert.strictEqual(yield* Ref.get(open), 1)
				return open
			}),
		).pipe(Effect.provide(gated(gate)))
		assert.strictEqual(yield* Ref.get(open), 0)
	}),
)
