import { assert, it } from "@effect/vitest"
import { Cause, Effect, Exit, Logger, Schema } from "effect"
import * as Failures from "../src/errors/Failures.ts"
import { codec, snapshot } from "../src/errors/Snapshot.ts"

class Inside extends Schema.TaggedError<
	Inside,
	{ readonly brand: unique symbol }
>()("Inside", { detail: Schema.String }) {}
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

it.effect(
	"replacement keeps the private cause and never sends it to a log or public schema",
	() =>
		Effect.gen(function* () {
			let logs = 0
			const result = yield* read(
				Inside.make({ detail: "private-provider-token" }),
			).pipe(
				Failures.replace("The store failed.", () => Unavailable.make({})),
				Effect.provide(
					Logger.layer([
						Logger.make(() => {
							logs++
						}),
					]),
				),
				Effect.exit,
			)
			assert.isTrue(Exit.isFailure(result))
			if (!Exit.isFailure(result)) return
			assert.strictEqual(logs, 0)
			const diagnostic = yield* result.cause.pipe(
				snapshot,
				Schema.encodeEffect(codec),
			)
			assert.match(diagnostic, /private-provider-token/)
			assert.match(diagnostic, /Store.read/)
			assert.notMatch(Cause.pretty(result.cause), /private-provider-token/)
			const error = Cause.findErrorOption(result.cause)
			assert.isTrue(error._tag === "Some")
			if (error._tag !== "Some") return
			const publicValue = yield* Schema.encodeEffect(
				Schema.fromJsonString(Unavailable),
			)(error.value)
			assert.notMatch(publicValue, /private-provider-token|Inside|cause/)
			// A later catchTag may start a new Cause. The error itself still holds its private cause.
			const caught = yield* Cause.fail(error.value).pipe(
				snapshot,
				Schema.encodeEffect(codec),
			)
			assert.match(caught, /private-provider-token/)
			assert.match(caught, /Store.read/)
		}),
)

it.effect(
	"tag replacement keeps other typed errors, defects, and interruption",
	() =>
		Effect.gen(function* () {
			const replacement = Failures.replaceTag(
				"Inside",
				"The store failed.",
				() => Unavailable.make({}),
			)
			const kept = yield* read(Taken.make({})).pipe(replacement, Effect.flip)
			assert.strictEqual(kept._tag, "Taken")
			const combined = Cause.combine(
				Cause.fail(Inside.make({ detail: "private" })),
				Cause.combine(Cause.die("defect"), Cause.interrupt(12)),
			)
			const result = yield* Effect.failCause(combined).pipe(
				replacement,
				Effect.exit,
			)
			assert.isTrue(Exit.isFailure(result))
			if (!Exit.isFailure(result)) return
			assert.isTrue(Cause.hasDies(result.cause))
			assert.isTrue(Cause.hasInterrupts(result.cause))
			assert.match(Cause.pretty(result.cause), /Unavailable/)
			assert.notMatch(Cause.pretty(result.cause), /private/)
		}),
)
