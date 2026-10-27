import { assert, it } from "@effect/vitest"
import { ChatConflict } from "@openbot-build/domain"
import { Chat, ChatStore } from "@openbot-build/core"
import { Array as Arr, Cause, Effect, Exit, Logger, Schema } from "effect"
import { codec, snapshot } from "../src/errors/Snapshot.ts"
import * as ChatErrors from "../src/chats/ChatErrors.ts"

it.effect(
	"a Chat query keeps the whole private cause without logging storage details",
	() =>
		Effect.gen(function* () {
			let logs: ReadonlyArray<string> = []
			const read = Effect.fn("ChatQuery.read")(function* () {
				return yield* Effect.failCause(
					Cause.combine(
						Cause.fail(
							Chat.Conflict.make({
								chat: Chat.Id.make("chat"),
								message: "The Chat changed",
							}),
						),
						Cause.fail(
							ChatStore.ChatStoreError.make({
								reason: "storage-failed",
								message: "private database detail",
								cause: "private row",
							}),
						),
					),
				)
			})
			const result = yield* read().pipe(
				ChatErrors.map,
				Effect.exit,
				Effect.provide(
					Logger.layer([
						Logger.make((log) => {
							if (log.logLevel === "Warn")
								logs = Arr.append(logs, Cause.pretty(log.cause))
						}),
					]),
				),
			)
			assert.isTrue(Exit.isFailure(result))
			if (Exit.isSuccess(result)) return assert.fail("The read did not fail")
			assert.strictEqual(result.cause.reasons.length, 2)
			assert.deepStrictEqual(
				Arr.map(result.cause.reasons, (reason) =>
					reason._tag === "Fail" ? reason.error._tag : reason._tag,
				),
				["ChatConflict", "ChatStorageUnavailable"],
			)
			assert.strictEqual(logs.length, 0)
			const diagnostic = yield* result.cause.pipe(
				snapshot,
				Schema.encodeEffect(codec),
			)
			assert.match(diagnostic, /private database detail/)
			assert.match(diagnostic, /ChatQuery.read/)
			assert.notMatch(
				Cause.pretty(result.cause),
				/private database detail|private row/,
			)
		}),
)

/** Runs a failing effect. It gives the public error and the text of each Warn log. */
const warned = <A>(effect: Effect.Effect<A, ChatStore.ChatStoreError>) =>
	Effect.gen(function* () {
		let logs: ReadonlyArray<string> = []
		const error = yield* effect.pipe(
			ChatErrors.map,
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
	"stored Chat data that does not decode keeps a private cause for its server fault",
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
			assert.strictEqual(logs.length, 0)
			const diagnostic = yield* Cause.fail(error).pipe(
				snapshot,
				Schema.encodeEffect(codec),
			)
			assert.match(diagnostic, /Stored Chat data is invalid/)
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
