import { assert, it } from "@effect/vitest"
import {
	Chat,
	ChatRuntime,
	ChatStoreRepository,
	MemoryPersistence,
	Store,
	Plugin,
} from "@openbot-build/core"
import { Context, Deferred, Effect, Ref, Stream } from "effect"
import { LanguageModelTest, textParts } from "./LanguageModelTest.ts"
import { settled } from "./ChatTest.ts"

/** Each Turn opens its plugin resources in its own scope. */
const runtimeWithResources = Effect.gen(function* () {
	const definition = yield* Store.define({
		stores: {},
		schemaVersion: "turn-resources/1",
	})
	const store = yield* ChatStoreRepository.make({
		definition,
		persistence: yield* MemoryPersistence.make,
	})
	const counts = yield* Ref.make<ReadonlyArray<number>>([])
	const open = yield* Ref.make(0)
	const opened = yield* Deferred.make<void>()
	const change = (by: number) =>
		Ref.updateAndGet(open, (count) => count + by).pipe(
			Effect.tap((count) => Ref.update(counts, (all) => [...all, count])),
			Effect.tap((count) =>
				count > 0 ? Deferred.succeed(opened, undefined) : Effect.void,
			),
		)
	const runtime = yield* ChatRuntime.make({
		store,
		bot: {
			plugin: Plugin.make({ id: Plugin.Id.make("turn-resources") })(() =>
				Effect.acquireRelease(change(1), () => change(-1)).pipe(
					Effect.as({ tools: {}, handlers: Context.empty() }),
				),
			),
		},
	})
	const chat = (yield* store.create({})).chat.id
	return { runtime, chat, counts, open, opened }
})

/** A model that answers only when the gate opens. */
const gated = (gate: Deferred.Deferred<void>) =>
	LanguageModelTest({
		streamText: () =>
			Stream.fromEffect(Deferred.await(gate)).pipe(
				Stream.flatMap(() => Stream.fromArray(textParts("answer"))),
			),
	})

it.effect("each queued Turn opens and closes its own plugin resources", () =>
	Effect.gen(function* () {
		const gate = yield* Deferred.make<void>()
		yield* Effect.gen(function* () {
			const { runtime, chat, counts, open, opened } =
				yield* runtimeWithResources
			const first = yield* runtime.deliver({ chat, input: "first" })
			assert.strictEqual(first.delivery, "started")
			yield* Deferred.await(opened)
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
			assert.strictEqual(yield* Ref.get(open), 0)
			assert.deepStrictEqual(yield* Ref.get(counts), [1, 0, 1, 0])
		}).pipe(Effect.provide(gated(gate)))
	}),
)

it.effect(
	"closing the runtime releases the plugin resources of a running Turn",
	() =>
		Effect.gen(function* () {
			const gate = yield* Deferred.make<void>()
			const open = yield* Effect.scoped(
				Effect.gen(function* () {
					const { runtime, chat, open, opened } = yield* runtimeWithResources
					yield* runtime.deliver({ chat, input: "never answered" })
					yield* Deferred.await(opened)
					assert.strictEqual(yield* Ref.get(open), 1)
					return open
				}),
			).pipe(Effect.provide(gated(gate)))
			assert.strictEqual(yield* Ref.get(open), 0)
		}),
)
