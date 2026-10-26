import { assert, it } from "@effect/vitest"
import { ChatConflict } from "@openbot-build/api"
import { ChatStore } from "@openbot-build/core"
import { Cause, Effect, Logger } from "effect"
import { toPublic } from "../src/chats/ResponseMapping.ts"

/** Runs a failing effect. It gives the public error and the text of each Warn log. */
const warned = <A>(effect: Effect.Effect<A, ChatStore.ChatStoreError>) =>
	Effect.gen(function* () {
		let logs: ReadonlyArray<string> = []
		const error = yield* effect.pipe(
			toPublic,
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
	"stored Chat data that does not decode is a server fault, and the log keeps the cause",
	() =>
		Effect.gen(function* () {
			const { error, logs } = yield* warned(
				Effect.fail(
					ChatStore.ChatStoreError.make({
						reason: "decode-failed",
						message: "Stored Chat data is invalid",
					}),
				),
			)
			assert.strictEqual(error._tag, "ChatStorageUnavailable")
			assert.strictEqual(logs.length, 1)
			assert.match(logs[0]!, /Stored Chat data is invalid/)
		}),
)

it.effect("an old Chat revision is a conflict, and nothing is logged", () =>
	Effect.gen(function* () {
		const { error, logs } = yield* warned(
			Effect.fail(
				ChatStore.ChatStoreError.make({
					reason: "reference-conflict",
					message: "The Chat revision is out of date",
				}),
			),
		)
		assert.deepStrictEqual(
			error,
			ChatConflict.make({ message: "The Chat revision is out of date" }),
		)
		assert.deepStrictEqual(logs, [])
	}),
)
