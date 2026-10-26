import { assert, it } from "@effect/vitest"
import { Chat } from "@openbot-build/core"
import { Effect, Exit, Option, Ref, Scope, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import * as LiveSessions from "../src/chats/live/LiveSessions.ts"

it.effect(
	"a new Live owner replaces a stale local session before the old scope closes",
	() =>
		Effect.gen(function* () {
			const sessions = yield* LiveSessions.make
			const model = yield* LanguageModel.make({
				generateText: () => Effect.succeed([]),
				streamText: () => Stream.empty,
			})
			const current = yield* Ref.make("first")
			const first = yield* Scope.make()
			const second = yield* Scope.make()
			const chat = Chat.Id.make("chat_shared")
			const owner = (sessionId: string) => ({
				sessionId,
				generation: 1,
				check: Ref.get(current).pipe(Effect.map((id) => id === sessionId)),
			})
			assert.strictEqual(
				yield* sessions
					.register(chat, model, owner("first"))
					.pipe(Effect.provideService(Scope.Scope, first)),
				true,
			)
			assert.strictEqual(
				yield* Effect.scoped(sessions.register(chat, model, owner("second"))),
				false,
			)
			yield* Ref.set(current, "second")
			assert.strictEqual(
				yield* sessions
					.register(chat, model, owner("second"))
					.pipe(Effect.provideService(Scope.Scope, second)),
				true,
			)
			yield* Scope.close(first, Exit.void)
			assert.strictEqual(yield* sessions.has(chat, 1, "second"), true)
			assert.ok(Option.isSome(yield* sessions.find(chat, 1)))
			yield* Scope.close(second, Exit.void)
			assert.strictEqual(yield* sessions.has(chat), false)
		}),
)
