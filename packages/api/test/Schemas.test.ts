import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SignInRequest } from "../src/AuthApi.ts"
import { Limit } from "../src/Page.ts"

describe("Schemas", () => {
	it.effect("a bad returnTo fails with a message that says what is wrong", () =>
		Effect.gen(function* () {
			const decode = Schema.decodeUnknownEffect(SignInRequest)
			assert.deepStrictEqual(yield* decode({ returnTo: "/settings" }), {
				returnTo: "/settings",
			})
			const error = yield* Effect.flip(decode({ returnTo: "/v1/chats" }))
			assert.include(
				error.message,
				"Expected a path on this origin that starts with one /",
			)
		}),
	)

	it.effect("a page limit is a whole number from 1 to the maximum", () =>
		Effect.gen(function* () {
			const decode = Schema.decodeUnknownEffect(Limit(100))
			assert.strictEqual(yield* decode("100"), 100)
			yield* Effect.flip(decode("1.5"))
			yield* Effect.flip(decode("0"))
			yield* Effect.flip(decode("101"))
		}),
	)
})
