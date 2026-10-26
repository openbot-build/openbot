import { assert, it } from "@effect/vitest"
import { Array as Arr, Duration, Effect, Option } from "effect"
import { TestClock } from "effect/testing"
import * as Temporary from "../src/Temporary.ts"

it.effect("take gives an entry to one caller only", () =>
	Effect.gen(function* () {
		const store = yield* Temporary.make<string>(Duration.minutes(1))
		yield* store.put("code", "value")
		const taken = yield* Effect.all(
			Arr.makeBy(20, () => store.take("code")),
			{ concurrency: "unbounded" },
		)
		assert.deepStrictEqual(Arr.getSomes(taken), ["value"])
		assert.isTrue(Option.isNone(yield* store.get("code")))
	}),
)

it.effect("entries expire after their time to live", () =>
	Effect.gen(function* () {
		const store = yield* Temporary.make<string>(Duration.minutes(1))
		yield* store.put("first", "a")
		yield* store.put("second", "b")
		yield* TestClock.adjust(Duration.seconds(59))
		assert.deepStrictEqual(yield* store.get("first"), Option.some("a"))
		yield* TestClock.adjust(Duration.seconds(1))
		assert.isTrue(Option.isNone(yield* store.get("first")))
		assert.isTrue(Option.isNone(yield* store.take("second")))
	}),
)

it.effect("a full store refuses new keys until entries expire", () =>
	Effect.gen(function* () {
		const store = yield* Temporary.make<string>(Duration.minutes(1), 2)
		yield* store.put("first", "a")
		yield* store.put("second", "b")
		const refused = yield* Effect.flip(store.put("third", "c"))
		assert.strictEqual(refused._tag, "CapacityExceeded")
		yield* store.put("first", "changed")
		assert.deepStrictEqual(yield* store.get("first"), Option.some("changed"))
		yield* store.remove("second")
		yield* store.put("third", "c")
		yield* TestClock.adjust(Duration.minutes(1))
		yield* store.put("fourth", "d")
		assert.deepStrictEqual(yield* store.get("fourth"), Option.some("d"))
	}),
)
