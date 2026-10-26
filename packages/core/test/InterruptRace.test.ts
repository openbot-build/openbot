import { assert, it } from "@effect/vitest"
import { Chat, ChatRuntime } from "@openbot-build/core"
import { Deferred, Effect, Fiber, Ref, Stream } from "effect"
import { ChatTest, settled } from "./ChatTest.ts"
import { LanguageModelTest, textParts } from "./LanguageModelTest.ts"

it.effect(
	"an old stop cannot stop a new Turn that started while it read the old Turn",
	() =>
		Effect.gen(function* () {
			const firstEntered = yield* Deferred.make<void>()
			const firstDone = yield* Deferred.make<void>()
			const secondEntered = yield* Deferred.make<void>()
			const secondDone = yield* Deferred.make<void>()
			const stopRead = yield* Deferred.make<void>()
			const resumeStop = yield* Deferred.make<void>()
			const holdRead = yield* Ref.make(false)
			let calls = 0
			const model = LanguageModelTest({
				streamText: () => {
					const first = calls++ === 0
					return Stream.fromEffect(
						Deferred.succeed(first ? firstEntered : secondEntered, undefined),
					).pipe(
						Stream.flatMap(() =>
							Stream.fromEffect(Deferred.await(first ? firstDone : secondDone)),
						),
						Stream.flatMap(() => Stream.fromArray(textParts("done"))),
					)
				},
			})
			yield* Effect.gen(function* () {
				const { runtimeStore, chat } = yield* ChatTest()
				const runtime = yield* ChatRuntime.make({
					store: {
						...runtimeStore,
						read: (id) =>
							runtimeStore.read(id).pipe(
								Effect.tap(() =>
									Effect.gen(function* () {
										if (!(yield* Ref.getAndSet(holdRead, false))) return
										yield* Deferred.succeed(stopRead, undefined)
										yield* Deferred.await(resumeStop)
									}),
								),
							),
					},
					bot: {},
				})
				const first = yield* runtime.deliver({ chat, input: "first" })
				assert.ok(first.turn !== undefined)
				yield* Deferred.await(firstEntered)
				yield* Ref.set(holdRead, true)
				const stopping = yield* runtime
					.interrupt({ chat, turn: first.turn })
					.pipe(Effect.forkChild)
				yield* Deferred.await(stopRead)
				yield* Deferred.succeed(firstDone, undefined)
				yield* settled(runtime, chat)
				const second = yield* runtime.deliver({ chat, input: "second" })
				assert.ok(second.turn !== undefined)
				yield* Deferred.await(secondEntered)
				yield* Deferred.succeed(resumeStop, undefined)
				yield* Fiber.join(stopping)
				const current = yield* runtime.status(chat)
				assert.strictEqual(Chat.currentTurn(current.chat)?.id, second.turn)
				assert.strictEqual(Chat.status(current.chat)._tag, "Running")
				assert.isTrue(yield* runtime.isActive(chat))
				yield* Deferred.succeed(secondDone, undefined)
				const done = yield* settled(runtime, chat)
				assert.strictEqual(Chat.status(done.chat)._tag, "Completed")
				assert.strictEqual(calls, 2)
			}).pipe(Effect.provide(model))
		}),
)
