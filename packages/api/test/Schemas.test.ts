import { SecretInput, SecretOutput } from "../src/Secret.ts"
import { TurnInfo, UpdateTodosRequest } from "../src/ChatsApi.ts"
import { Chat, Item, Turn } from "@openbot-build/core"
import { Prompt } from "effect/ai"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted, Schema } from "effect"
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

it.effect(
	"secrets hide their value in logs and keep their JSON wire value",
	() =>
		Effect.gen(function* () {
			const secret = yield* Schema.decodeEffect(SecretInput)("test-secret")
			assert.isTrue(Redacted.isRedacted(secret))
			assert.notInclude(String(secret), "test-secret")
			assert.notInclude(
				yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
					secret,
				),
				"test-secret",
			)
			assert.strictEqual(
				yield* Schema.encodeEffect(SecretOutput)(secret),
				"test-secret",
			)
			yield* Effect.flip(Schema.decodeEffect(SecretInput)(""))
		}),
)

it.effect("todo input rejects repeated ids and two items in progress", () =>
	Effect.gen(function* () {
		const decode = Schema.decodeUnknownEffect(UpdateTodosRequest)
		const item = { id: "one", content: "Read the file", status: "in_progress" }
		yield* Effect.flip(decode({ revision: 0, items: [item, item] }))
		yield* Effect.flip(
			decode({ revision: 0, items: [item, { ...item, id: "two" }] }),
		)
		yield* decode({
			revision: 0,
			items: [item, { ...item, id: "two", status: "pending" }],
		})
	}),
)

it.effect("public Turns do not encode saved execution input", () =>
	Effect.gen(function* () {
		const turn: Turn.Record = {
			id: Turn.Id.make("turn"),
			chat: Chat.Id.make("chat"),
			settings: { mode: "build" },
			status: { _tag: "Running" },
			steps: 0,
			input: [],
			items: [],
			startedAt: 0,
			pendingStep: {
				step: 1,
				item: Item.Id.make("step"),
				input: Prompt.make("private instructions"),
				before: Prompt.empty,
				after: Prompt.empty,
			},
		}
		const encoded = yield* Schema.encodeEffect(TurnInfo)(turn)
		assert.notProperty(encoded, "pendingStep")
		assert.strictEqual(encoded.id, turn.id)
	}),
)
