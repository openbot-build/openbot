import { assert, it } from "@effect/vitest"
import {
	ChatRuntime,
	ChatStoreRepository,
	MemoryPersistence,
	Store,
} from "@openbot-build/core"
import { Deferred, Effect, Fiber, Option, Stream } from "effect"
import { LanguageModelTest, textParts } from "./LanguageModelTest.ts"

it.effect(
	"an input whose owner changed before the inbox write is refused without a Turn or an inbox entry",
	() => {
		let calls = 0
		return Effect.gen(function* () {
			const definition = yield* Store.define({
				stores: {},
				schemaVersion: "inbox-revision/1",
			})
			const store = yield* ChatStoreRepository.make({
				definition,
				persistence: yield* MemoryPersistence.make,
			})
			for (const passive of [false, true]) {
				const beforeWrite = yield* Deferred.make<void>()
				const resume = yield* Deferred.make<void>()
				const runtime = yield* ChatRuntime.make({
					store: {
						...store,
						modifyEffect: (input) =>
							(input.expectedRevision === undefined
								? Effect.void
								: Deferred.succeed(beforeWrite, undefined).pipe(
										Effect.andThen(Deferred.await(resume)),
									)
							).pipe(Effect.andThen(store.modifyEffect(input))),
					},
					bot: {},
					canStart: () => Effect.succeed(false),
				})
				const initial = yield* store.create({})
				const chat = initial.chat.id
				const late = yield* runtime
					.deliver({
						chat,
						expected: initial.chat.revision,
						input: "Old connection",
						passive,
					})
					.pipe(Effect.flip, Effect.forkChild)
				yield* Deferred.await(beforeWrite)
				const changed = yield* store.modifyEffect({
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
				assert.strictEqual((yield* Fiber.join(late))._tag, "ChatConflict")
				const refused = yield* store.read(chat)
				assert.strictEqual(refused.chat.revision, changed.view.chat.revision)
				assert.strictEqual(refused.chat.turn, undefined)
				assert.deepStrictEqual(refused.chat.inbox, [])
				assert.deepStrictEqual(yield* store.items(chat), [])
				const fresh = yield* runtime.deliver({
					chat,
					expected: refused.chat.revision,
					input: "New connection",
					passive,
				})
				assert.strictEqual(fresh.delivery, "queued")
				assert.strictEqual((yield* store.read(chat)).chat.inbox.length, 1)
			}
			assert.strictEqual(calls, 0)
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => {
						calls++
						return Stream.fromArray(textParts("Must not run"))
					},
				}),
			),
		)
	},
)
