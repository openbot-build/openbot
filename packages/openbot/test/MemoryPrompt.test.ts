import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Ref } from "effect"
import { Prompt } from "effect/ai"
import { guardedMemoryPrompt } from "../src/plugins/bots/BotTools.ts"

const original = Prompt.make([{ role: "user", content: "Help with my trip" }])
const enriched = {
	original: "Help with my trip",
	changed: Option.some("Help with my trip. My private preference is trains."),
}

it.effect(
	"disabling memory between model steps revokes an already cached enrichment",
	() =>
		Effect.gen(function* () {
			const allowed = yield* Ref.make(true)
			const calls = yield* Ref.make(0)
			const cached = yield* Effect.cached(
				Ref.update(calls, (n) => n + 1).pipe(Effect.as(enriched)),
			)
			const transform = guardedMemoryPrompt(Ref.get(allowed), cached)
			assert.notDeepEqual(yield* transform(original), original)
			yield* Ref.set(allowed, false)
			assert.deepEqual(yield* transform(original), original)
			assert.equal(yield* Ref.get(calls), 1)
		}),
)

it.effect(
	"disabling memory while enrichment is pending does not expose the late answer",
	() =>
		Effect.gen(function* () {
			const allowed = yield* Ref.make(true)
			const entered = yield* Deferred.make<void>()
			const complete = yield* Deferred.make<void>()
			const cached = yield* Effect.cached(
				Effect.gen(function* () {
					yield* Deferred.succeed(entered, undefined)
					yield* Deferred.await(complete)
					return enriched
				}),
			)
			const transform = guardedMemoryPrompt(Ref.get(allowed), cached)
			const pending = yield* Effect.forkChild(transform(original))
			yield* Deferred.await(entered)
			yield* Ref.set(allowed, false)
			yield* Deferred.succeed(complete, undefined)
			assert.deepEqual(yield* Fiber.join(pending), original)
			assert.deepEqual(yield* transform(original), original)
		}),
)
