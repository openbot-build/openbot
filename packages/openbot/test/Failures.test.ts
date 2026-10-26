import { assert, it } from "@effect/vitest"
import { Cause, Effect, Logger, Schema } from "effect"
import * as Failures from "../src/app/Failures.ts"

class Inside extends Schema.TaggedError<
	Inside,
	{ readonly brand: unique symbol }
>()("Inside", {}) {}
class Taken extends Schema.TaggedError<
	Taken,
	{ readonly brand: unique symbol }
>()("Taken", {}) {}
class Unavailable extends Schema.TaggedError<
	Unavailable,
	{ readonly brand: unique symbol }
>()("Unavailable", {}) {}

const read = Effect.fn("Store.read")(function* (error: Inside | Taken) {
	return yield* error
})

/** Runs a failing effect. It gives the error and the text of each Warn log. */
const warned = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		let logs: ReadonlyArray<string> = []
		const error = yield* effect.pipe(
			Effect.flip,
			Effect.provide(
				Logger.layer([
					Logger.make((log) => {
						if (log.logLevel === "Warn")
							logs = [...logs, Cause.pretty(log.cause)]
					}),
				]),
			),
		)
		return { error, logs }
	})

it.effect(
	"replace logs the inside failure with the place where it happened",
	() =>
		Effect.gen(function* () {
			const { error, logs } = yield* read(Inside.make({})).pipe(
				Failures.replace("The store failed.", () => Unavailable.make({})),
				warned,
			)
			assert.strictEqual(error._tag, "Unavailable")
			assert.strictEqual(logs.length, 1)
			assert.match(logs[0]!, /Inside/)
			assert.match(logs[0]!, /at Store\.read/)
		}),
)

it.effect(
	"replaceTag replaces only the failure with its tag, and logs where it happened",
	() =>
		Effect.gen(function* () {
			const replaceInside = Failures.replaceTag(
				"Inside",
				"The store failed.",
				() => Unavailable.make({}),
			)
			const replaced = yield* read(Inside.make({})).pipe(replaceInside, warned)
			assert.strictEqual(replaced.error._tag, "Unavailable")
			assert.strictEqual(replaced.logs.length, 1)
			assert.match(replaced.logs[0]!, /at Store\.read/)
			const kept = yield* read(Taken.make({})).pipe(replaceInside, warned)
			assert.strictEqual(kept.error._tag, "Taken")
			assert.deepStrictEqual(kept.logs, [])
		}),
)
