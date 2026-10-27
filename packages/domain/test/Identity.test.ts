import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { AccountCaller, Caller } from "../src/Identity.ts"

it.effect("a token actor must name its token and organization", () =>
	Effect.gen(function* () {
		for (const schema of [Caller, AccountCaller]) {
			const decode = Schema.decodeUnknownEffect(schema)
			assert.isFalse(
				yield* Effect.isSuccess(
					decode({ kind: "user_token", organizationId: "org", userId: "user" }),
				),
			)
			assert.isFalse(
				yield* Effect.isSuccess(
					decode({ kind: "user_token", tokenId: "token", userId: "user" }),
				),
			)
			assert.isTrue(
				yield* Effect.isSuccess(
					decode({
						kind: "user_token",
						tokenId: "token",
						organizationId: "org",
						userId: "user",
					}),
				),
			)
			assert.isFalse(
				yield* Effect.isSuccess(
					decode({
						kind: "member",
						tokenId: "token",
						organizationId: "org",
						userId: "user",
					}),
				),
			)
		}
	}),
)
